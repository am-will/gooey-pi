import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isBroadProjectRoot, ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import type { SessionRecord } from '../../src/types/api'

const electronMocks = vi.hoisted(() => ({
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}))
vi.mock('electron', () => electronMocks)

const dirs: string[] = []
function identity(path: string): { dev: string; ino: string; birthtimeNs?: string } {
  const info = lstatSync(path, { bigint: true })
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
  }
}
const identities = (...paths: string[]) => Object.fromEntries(paths.map((path) => [realpathSync(path), identity(path)]))
afterEach(() => {
  electronMocks.dialog.showOpenDialog.mockReset()
  electronMocks.dialog.showSaveDialog.mockReset()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { root: string; service: ProjectService; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-files-')); dirs.push(dir)
  const root = join(dir, 'project'); mkdirSync(root)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new ProjectService(store, () => null)
  return { root, service, store }
}

function session(id: string, projectPath: string, createdAt: string, updatedAt: string): SessionRecord {
  return {
    id,
    harness: 'prime',
    filePath: join(projectPath, `${id}.jsonl`),
    projectPath,
    title: id,
    createdAt,
    updatedAt,
    status: 'idle',
    depth: 0,
    archived: false,
  }
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe('ProjectService list enrichment', () => {
  it('coalesces concurrent denied read-only checks without branch enrichment', async () => {
    const { root, service } = setup()
    const sessionsStarted = deferred<void>()
    const releaseSessions = deferred<void>()
    let discoveryCalls = 0
    let branchCalls = 0
    service.bindProviders({
      sessions: async () => {
        discoveryCalls += 1
        sessionsStarted.resolve()
        await releaseSessions.promise
        return []
      },
      branch: async () => {
        branchCalls += 1
        return 'main'
      },
    })

    const checks = Promise.all(Array.from({ length: 4 }, () => service.authorizeReadOnlyCwd(root).catch((error: unknown) => error)))
    await sessionsStarted.promise
    expect(discoveryCalls).toBe(1)
    expect(branchCalls).toBe(0)
    releaseSessions.resolve()
    const errors = await checks
    expect(errors).toHaveLength(4)
    expect(errors.every((error) => error instanceof TypeError)).toBe(true)
  })

  it('does not resurrect an inferred root from a stale list during removal', async () => {
    const { root, service } = setup()
    const current = session('session', root, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
    service.bindProviders({ sessions: async () => [current], branch: async () => undefined })
    const [inferred] = await service.list()

    const sessionsStarted = deferred<void>()
    const staleSessions = deferred<SessionRecord[]>()
    const stopStarted = deferred<void>()
    const releaseStop = deferred<void>()
    let sessionCalls = 0
    service.bindProviders({
      sessions: async () => {
        sessionCalls += 1
        if (sessionCalls === 1) {
          sessionsStarted.resolve()
          return staleSessions.promise
        }
        return []
      },
      branch: async () => undefined,
      stopProjectProcesses: async () => {
        stopStarted.resolve()
        await releaseStop.promise
      },
    })

    const removal = service.remove(inferred.id)
    await stopStarted.promise
    const staleList = service.list()
    await sessionsStarted.promise
    releaseStop.resolve()
    await expect(removal).resolves.toBe(true)
    await expect(service.authorizeReadOnlyCwd(root)).rejects.toThrow(/not inside/)

    staleSessions.resolve([current])
    await staleList
    await expect(service.authorizeReadOnlyCwd(root)).rejects.toThrow(/not inside/)
  })

  it('aggregates canonical session metadata once for persisted and inferred projects', async () => {
    const { root, service, store } = setup()
    const projectAlias = `${root}-alias`
    const additionalFolder = `${root}-additional`
    const inferred = `${root}-inferred`
    const dismissed = `${root}-dismissed`
    const missing = `${root}-missing`
    symlinkSync(root, projectAlias)
    mkdirSync(additionalFolder)
    mkdirSync(inferred)
    mkdirSync(dismissed)
    const sessions = [
      session('persisted-newer', root, '2026-02-03T00:00:00.000Z', '2026-02-04T00:00:00.000Z'),
      session('persisted-alias', projectAlias, '2026-02-01T00:00:00.000Z', '2026-02-06T00:00:00.000Z'),
      session('persisted-additional', additionalFolder, '2026-02-02T00:00:00.000Z', '2026-02-05T00:00:00.000Z'),
      session('inferred-newer', inferred, '2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z'),
      session('inferred-older', inferred, '2026-03-01T00:00:00.000Z', '2026-03-07T00:00:00.000Z'),
      session('dismissed', dismissed, '2026-04-01T00:00:00.000Z', '2026-04-02T00:00:00.000Z'),
      session('missing', missing, '2026-05-01T00:00:00.000Z', '2026-05-02T00:00:00.000Z'),
    ]
    const filterSpy = vi.spyOn(sessions, 'filter')
    const now = '2026-01-01T00:00:00.000Z'
    await store.update((state) => {
      state.projects.push({
        id: 'persisted', harness: 'prime', name: 'Persisted', path: root,
        // Canonical aliases and repeated folders must not multiply counts.
        folders: [root, projectAlias, additionalFolder, additionalFolder], primaryFolder: root, pinned: true,
        createdAt: now, lastOpenedAt: '2026-05-01T00:00:00.000Z', folderIdentities: identities(root, additionalFolder),
      })
      state.dismissedProjectPaths.push(dismissed)
    })
    service.bindProviders({ sessions: async () => sessions, branch: async () => undefined })

    const records = await service.list()

    expect(filterSpy).not.toHaveBeenCalled()
    expect(records.map((record) => record.id)).toEqual([
      'persisted',
      expect.stringMatching(/^inferred-/),
    ])
    expect(records[0]).toMatchObject({
      id: 'persisted',
      createdAt: now,
      lastOpenedAt: '2026-05-01T00:00:00.000Z',
      sessionCount: 3,
    })
    expect(records[1]).toMatchObject({
      path: realpathSync(inferred),
      createdAt: '2026-03-01T00:00:00.000Z',
      lastOpenedAt: '2026-03-07T00:00:00.000Z',
      sessionCount: 2,
      inferred: true,
      readOnly: true,
    })
    expect(records.some((record) => record.path === realpathSync(dismissed))).toBe(false)
    expect(records.some((record) => record.path === resolve(missing))).toBe(false)
  })

  it('enriches persisted branches without spawning git for inferred roots', async () => {
    const { root, service, store } = setup()
    const inferredRoots = [1, 2, 3].map((index) => `${root}-inferred-${index}`)
    for (const inferredRoot of inferredRoots) mkdirSync(inferredRoot)
    const now = '2026-01-01T00:00:00.000Z'
    await store.update((state) => {
      state.projects.push({
        id: 'persisted',
        harness: 'prime',
        name: 'Persisted',
        path: root,
        folders: [root],
        primaryFolder: root,
        pinned: false,
        createdAt: now,
        lastOpenedAt: now,
        folderIdentities: identities(root),
      })
    })
    const sessions = inferredRoots.map((path, index) => session(`inferred-${index}`, path, now, now))
    const branchCwds: string[] = []
    service.bindProviders({
      sessions: async () => sessions,
      branch: async (cwd) => {
        branchCwds.push(cwd)
        return 'main'
      },
    })

    const records = await service.list()
    expect(branchCwds).toEqual([root])
    expect(records.find((record) => record.id === 'persisted')?.gitBranch).toBe('main')
    expect(records.filter((record) => record.inferred)).toHaveLength(inferredRoots.length)
    expect(records.filter((record) => record.inferred).every((record) => record.gitBranch === undefined)).toBe(true)
  })

  it('bounds overlapping branch enrichment without changing record order or undefined branches', async () => {
    const { root, service, store } = setup()
    const concurrencyLimit = 4
    const projectRoots = [root]
    for (let index = 1; index < concurrencyLimit + 2; index += 1) {
      const path = `${root}-${index}`
      mkdirSync(path)
      projectRoots.push(path)
    }
    const now = '2026-01-01T00:00:00.000Z'
    await store.update((state) => {
      for (const [index, path] of projectRoots.entries()) state.projects.push({
        id: `project-${index}`, harness: 'prime', name: `Project ${index}`, path,
        folders: [path], primaryFolder: path, pinned: false,
        createdAt: now, lastOpenedAt: now, folderIdentities: identities(path),
      })
    })

    const gates = projectRoots.map(() => deferred<string | undefined>())
    const firstStarted = deferred<void>()
    const nextStarted = deferred<void>()
    const started: string[] = []
    let active = 0
    let maximumActive = 0
    service.bindProviders({ sessions: async () => [], branch: async (cwd) => {
      const index = projectRoots.indexOf(cwd)
      started.push(cwd)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (started.length === 1) firstStarted.resolve()
      if (started.length === concurrencyLimit + 1) nextStarted.resolve()
      try { return await gates[index].promise }
      finally { active -= 1 }
    } })

    const listing = service.list()
    await firstStarted.promise
    try {
      expect(started).toEqual(projectRoots.slice(0, concurrencyLimit))
      expect(maximumActive).toBe(concurrencyLimit)

      gates[0].resolve('branch-0')
      await nextStarted.promise
      expect(active).toBe(concurrencyLimit)

      for (let index = 1; index < gates.length; index += 1) {
        gates[index].resolve(index === gates.length - 1 ? undefined : `branch-${index}`)
      }
      const records = await listing
      expect(records.map((record) => record.id)).toEqual(projectRoots.map((_path, index) => `project-${index}`))
      expect(records.map((record) => record.gitBranch)).toEqual([
        'branch-0', 'branch-1', 'branch-2', 'branch-3', 'branch-4', undefined,
      ])
      expect(maximumActive).toBe(concurrencyLimit)
    } finally {
      for (const gate of gates) gate.resolve(undefined)
      await listing.catch(() => undefined)
    }
  })

  it('publishes authorization before enrichment and still propagates branch failures', async () => {
    const { root, service, store } = setup()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root),
    }) })
    service.bindProviders({ sessions: async () => [], branch: async (cwd) => {
      await expect(service.authorizeCwd(cwd)).resolves.toBe(realpathSync(root))
      throw new Error('branch inspection failed')
    } })

    await expect(service.list()).rejects.toThrow('branch inspection failed')
    await expect(service.authorizeCwd(root)).resolves.toBe(realpathSync(root))
  })

  it('does not start queued branch lookups after a concurrent lookup fails', async () => {
    const { root, service, store } = setup()
    const concurrencyLimit = 4
    const projectRoots = [root]
    for (let index = 1; index <= concurrencyLimit; index += 1) {
      const path = `${root}-failure-${index}`
      mkdirSync(path)
      projectRoots.push(path)
    }
    const now = new Date().toISOString()
    await store.update((state) => {
      for (const [index, path] of projectRoots.entries()) state.projects.push({
        id: `failure-${index}`, harness: 'prime', name: `Failure ${index}`, path,
        folders: [path], primaryFolder: path, pinned: false,
        createdAt: now, lastOpenedAt: now, folderIdentities: identities(path),
      })
    })

    const gates = projectRoots.map(() => deferred<string | undefined>())
    const saturated = deferred<void>()
    const initialSettled = deferred<void>()
    const started: string[] = []
    let settled = 0
    service.bindProviders({ sessions: async () => [], branch: async (cwd) => {
      const index = projectRoots.indexOf(cwd)
      started.push(cwd)
      if (started.length === concurrencyLimit) saturated.resolve()
      try { return await gates[index].promise }
      finally {
        settled += 1
        if (settled === concurrencyLimit) initialSettled.resolve()
      }
    } })

    const listing = service.list()
    await saturated.promise
    const primaryFailure = new Error('primary branch failure')
    gates[0].reject(primaryFailure)
    await expect(listing).rejects.toBe(primaryFailure)

    // A second in-flight rejection is still owned by mapLimit's workers. The
    // remaining active calls settle, but the fifth lookup must stay queued.
    gates[1].reject(new Error('secondary branch failure'))
    gates[2].resolve('branch-2')
    gates[3].resolve('branch-3')
    await initialSettled.promise
    await Promise.resolve()
    await Promise.resolve()

    expect(started).toEqual(projectRoots.slice(0, concurrencyLimit))
    await expect(service.authorizeCwd(projectRoots.at(-1)!)).resolves.toBe(realpathSync(projectRoots.at(-1)!))
  })
})

describe('broad project root authorization', () => {
  it.each([
    ['POSIX filesystem root', '/', { platform: 'linux', homePath: '/Users/alice' }],
    ['POSIX home directory', '/Users/alice', { platform: 'darwin', homePath: '/Users/alice' }],
    ['Windows system drive root', 'C:\\', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
    ['Windows secondary drive root', 'D:/', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
    ['Windows UNC share root', '\\\\server\\share', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
    ['Windows extended UNC share root', '\\\\?\\UNC\\server\\share\\', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
    ['Windows home directory case-insensitively', 'c:\\users\\alice', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
  ] as const)('classifies %s as too broad', (_label, path, options) => {
    expect(isBroadProjectRoot(path, options)).toBe(true)
  })

  it.each([
    ['POSIX project', '/Users/alice/work/app', { platform: 'darwin', homePath: '/Users/alice' }],
    ['POSIX home-name sibling', '/Users/alice-other', { platform: 'darwin', homePath: '/Users/alice' }],
    ['Windows project', 'C:\\Users\\Alice\\work\\app', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
    ['Windows UNC project', '\\\\server\\share\\work\\app', { platform: 'win32', homePath: 'C:\\Users\\Alice' }],
  ] as const)('allows %s', (_label, path, options) => {
    expect(isBroadProjectRoot(path, options)).toBe(false)
  })

  it.each([
    ['filesystem root', realpathSync(resolve('/'))],
    ['home directory', realpathSync(homedir())],
  ])('rejects a direct grant for the %s before persisting it', async (_label, path) => {
    const { service, store } = setup()
    electronMocks.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] })

    await expect(service.add()).rejects.toThrow(/Broad filesystem roots cannot be added as projects/)
    expect(store.snapshot().projects).toEqual([])
  })

  it.each([
    ['filesystem root', realpathSync(resolve('/'))],
    ['home directory', realpathSync(homedir())],
  ])('keeps a persisted %s visible but quarantined from authorization', async (_label, path) => {
    const { root, service, store } = setup()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'broad-project', harness: 'prime', name: 'Broad project', path, folders: [path], primaryFolder: path,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(path),
    }) })

    expect((await service.list()).map((project) => project.id)).toEqual(['broad-project'])
    await expect(service.authorizeCwd(path === resolve('/') ? root : path)).rejects.toThrow(/unsafe broad.*remove it and add a narrower project folder/i)
  })

  it('does not reauthorize a quarantined broad grant while rebuilding after removal', async () => {
    const { root, service, store } = setup()
    const filesystemRoot = realpathSync(resolve('/'))
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      {
        id: 'broad-project', harness: 'prime', name: 'Broad project', path: filesystemRoot, folders: [filesystemRoot], primaryFolder: filesystemRoot,
        pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(filesystemRoot),
      },
      {
        id: 'narrow-project', harness: 'prime', name: 'Narrow project', path: root, folders: [root], primaryFolder: root,
        pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root),
      },
    ) })

    await service.list()
    await expect(service.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    await expect(service.remove('narrow-project')).resolves.toBe(true)
    await expect(service.authorizeCwd(root)).rejects.toThrow(/unsafe broad.*remove it and add a narrower project folder/i)
  })
})

describe('ProjectService file listing', () => {
  it('lists project files while excluding generated trees and symlinks', async () => {
    const { root, service, store } = setup()
    mkdirSync(join(root, 'src')); mkdirSync(join(root, '.git')); mkdirSync(join(root, 'node_modules')); mkdirSync(join(root, 'vendor')); mkdirSync(join(root, 'release'))
    writeFileSync(join(root, 'README.md'), 'read me')
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, '.git', 'config'), 'private metadata')
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'generated')
    writeFileSync(join(root, 'vendor', 'autoload.php'), 'generated vendor file')
    writeFileSync(join(root, 'release', 'Prime Work.dmg'), 'generated')
    symlinkSync('/etc/hosts', join(root, 'hosts-link'))
    await store.update((state) => { state.projects.push({ id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root) }) })

    await service.list()
    expect(await service.listFiles(root)).toEqual({
      entries: [
        { path: 'src', type: 'directory' },
        { path: 'src/index.ts', type: 'file' },
        { path: 'README.md', type: 'file' },
      ],
      skipped: 0,
    })
  })

  it('skips unreadable directories and reports how many were skipped', async () => {
    const { root, service, store } = setup()
    mkdirSync(join(root, 'readable'))
    writeFileSync(join(root, 'readable', 'kept.txt'), 'kept')
    mkdirSync(join(root, 'unreadable'))
    writeFileSync(join(root, 'unreadable', 'hidden.txt'), 'hidden')
    chmodSync(join(root, 'unreadable'), 0o000)
    await store.update((state) => { state.projects.push({ id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root) }) })
    await service.list()
    try {
      const listing = await service.listFiles(root)
      expect(listing.entries).toContainEqual({ path: 'readable/kept.txt', type: 'file' })
      expect(listing.entries.some((entry) => entry.path === 'unreadable/hidden.txt')).toBe(false)
      expect(listing.skipped).toBe(1)
    } finally {
      chmodSync(join(root, 'unreadable'), 0o700)
    }
  })

  it('rejects paths that have not been added as projects', async () => {
    const { root, service } = setup()
    await expect(service.listFiles(root)).rejects.toThrow(/not inside an added Prime Work project/)
  })

  it('lists files for an inferred project discovered from sessions without manual addition', async () => {
    const { root, service } = setup()
    writeFileSync(join(root, 'README.md'), 'inferred project readme')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.ts'), 'console.log("hello")')
    service.bindProviders({
      sessions: async () => [session('session-1', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')],
      branch: async () => undefined,
    })

    const listing = await service.listFiles(root)
    expect(listing).toEqual({
      entries: [
        { path: 'src', type: 'directory' },
        { path: 'src/main.ts', type: 'file' },
        { path: 'README.md', type: 'file' },
      ],
      skipped: 0,
    })
  })

  it('lists files for an inferred Pi Work project discovered from Pi agent sessions', async () => {
    const { root, store } = setup()
    const piService = new ProjectService(store, () => null, 'pi')
    writeFileSync(join(root, 'config.json'), '{}')
    piService.bindProviders({
      sessions: async () => [{
        id: 'pi-session-1',
        harness: 'pi',
        filePath: join(root, 'pi-session-1.jsonl'),
        projectPath: root,
        title: 'Pi Session',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        status: 'idle',
        depth: 0,
        archived: false,
      }],
      branch: async () => undefined,
    })

    const listing = await piService.listFiles(root)
    expect(listing).toEqual({
      entries: [
        { path: 'config.json', type: 'file' },
      ],
      skipped: 0,
    })
  })

  it('lists files for an inferred OMP project discovered from OMP sessions', async () => {
    const { root, store } = setup()
    const ompService = new ProjectService(store, () => null, 'omp')
    writeFileSync(join(root, 'omp-config.yaml'), 'version: 1')
    ompService.bindProviders({
      sessions: async () => [{
        id: 'omp-session-1',
        harness: 'omp',
        filePath: join(root, 'omp-session-1.jsonl'),
        projectPath: root,
        title: 'OMP Session',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-02T00:00:00.000Z',
        status: 'idle',
        depth: 0,
        archived: false,
      }],
      branch: async () => undefined,
    })

    const listing = await ompService.listFiles(root)
    expect(listing).toEqual({
      entries: [
        { path: 'omp-config.yaml', type: 'file' },
      ],
      skipped: 0,
    })
  })

  it('revokes file listing authorization when an inferred project is dismissed', async () => {
    const { root, service } = setup()
    writeFileSync(join(root, 'README.md'), 'readme')
    service.bindProviders({
      sessions: async () => [session('session-1', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')],
      branch: async () => undefined,
    })

    const listed = await service.list()
    expect(listed).toHaveLength(1)
    expect(await service.listFiles(root)).toEqual({ entries: [{ path: 'README.md', type: 'file' }], skipped: 0 })

    expect(await service.remove(listed[0].id)).toBe(true)
    await expect(service.listFiles(root)).rejects.toThrow(/not inside an added Prime Work project/)
  })

  it('revokes read-only authorization when a symlinked dismissal names the project', async () => {
    const { root, service, store } = setup()
    const alias = `${root}-alias`
    symlinkSync(root, alias)
    service.bindProviders({
      sessions: async () => [session('session-1', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')],
      branch: async () => undefined,
    })

    await service.list()
    await expect(service.authorizeReadOnlyCwd(root)).resolves.toBe(realpathSync(root))
    await store.update((state) => { state.dismissedProjectPaths.push(alias) })
    await expect(service.authorizeReadOnlyCwd(root)).rejects.toThrow(/not inside an added Prime Work project/)
  })

  it('safely ignores stale and nonexistent session project paths during file listing', async () => {
    const { root, service } = setup()
    writeFileSync(join(root, 'index.ts'), 'export {}')
    const nonexistent = join(root, 'does-not-exist')
    service.bindProviders({
      sessions: async () => [
        session('stale-session', nonexistent, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
        session('valid-session', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
      ],
      branch: async () => undefined,
    })

    expect(await service.listFiles(root)).toEqual({ entries: [{ path: 'index.ts', type: 'file' }], skipped: 0 })
  })

  it('continues rebuild past empty projectPath entries to authorize later valid session roots', async () => {
    const { root, service } = setup()
    writeFileSync(join(root, 'main.ts'), 'export const x = 1')
    service.bindProviders({
      sessions: async () => [
        session('empty-1', '', '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
        session('valid-1', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
      ],
      branch: async () => undefined,
    })

    await service.list()
    expect(await service.listFiles(root)).toEqual({ entries: [{ path: 'main.ts', type: 'file' }], skipped: 0 })
  })

  it('lazily re-lists and authorizes newly discovered session roots during file listing', async () => {
    const { root, service } = setup()
    const newlyDiscovered = `${root}-newly-discovered`
    mkdirSync(newlyDiscovered)
    writeFileSync(join(newlyDiscovered, 'app.ts'), 'console.log("new")')
    let sessionsList: SessionRecord[] = []
    service.bindProviders({
      sessions: async () => sessionsList,
      branch: async () => undefined,
    })

    await service.list()
    await expect(service.listFiles(newlyDiscovered)).rejects.toThrow(/not inside/)

    sessionsList = [session('new-session', newlyDiscovered, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')]
    const listing = await service.listFiles(newlyDiscovered)
    expect(listing).toEqual({ entries: [{ path: 'app.ts', type: 'file' }], skipped: 0 })
  })

  it('canonicalizes symlinked session roots and deduplicates aliases', async () => {
    const { root, service } = setup()
    const symlinkAlias = `${root}-alias`
    symlinkSync(root, symlinkAlias)
    writeFileSync(join(root, 'index.ts'), 'export {}')
    service.bindProviders({
      sessions: async () => [
        session('s1', symlinkAlias, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z'),
        session('s2', root, '2026-03-01T00:00:00.000Z', '2026-03-03T00:00:00.000Z'),
      ],
      branch: async () => undefined,
    })

    const records = await service.list()
    expect(records).toHaveLength(1)
    expect(records[0].path).toBe(realpathSync(root))
    expect(records[0].sessionCount).toBe(2)
    expect(await service.listFiles(symlinkAlias)).toEqual({ entries: [{ path: 'index.ts', type: 'file' }], skipped: 0 })
  })

  it.skipIf(process.platform === 'win32')('preserves backslashes in POSIX filenames', async () => {
    const { root, service, store } = setup()
    writeFileSync(join(root, 'weird\\name.txt'), 'posix filename with a backslash')
    await store.update((state) => { state.projects.push({ id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root) }) })

    await service.list()
    expect(await service.listFiles(root)).toEqual({ entries: [{ path: 'weird\\name.txt', type: 'file' }], skipped: 0 })
  })

  it('migrates explicit project grants created before folder identities were persisted', async () => {
    const { root, service, store } = setup()
    writeFileSync(join(root, 'README.md'), 'read me')
    await store.update((state) => { state.projects.push({
      id: 'legacy-project', harness: 'prime', name: 'Legacy project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(),
    }) })

    expect(await service.listFiles(root)).toEqual({ entries: [{ path: 'README.md', type: 'file' }], skipped: 0 })
    expect(store.snapshot().projects[0].folderIdentities).toEqual(identities(root))
  })

  it('upgrades a legacy grant after a remount renumbers the filesystem device', async () => {
    const { root, service, store } = setup()
    const current = identity(root)
    expect(current.birthtimeNs).toBeDefined()
    const legacy = { dev: (BigInt(current.dev) + 1n).toString(), ino: current.ino }
    await store.update((state) => { state.projects.push({
      id: 'legacy-remount', harness: 'prime', name: 'Legacy remount', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: { [realpathSync(root)]: legacy },
    }) })

    await expect(service.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    expect(store.snapshot().projects[0].folderIdentities?.[realpathSync(root)]).toEqual(current)
  })

  it('does not migrate a legacy cross-device identity when the folder postdates the grant', async () => {
    const { root, service, store } = setup()
    const current = identity(root)
    expect(current.birthtimeNs).toBeDefined()
    const legacy = { dev: (BigInt(current.dev) + 1n).toString(), ino: current.ino }
    await store.update((state) => { state.projects.push({
      id: 'legacy-replacement', harness: 'prime', name: 'Legacy replacement', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: new Date(0).toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: { [realpathSync(root)]: legacy },
    }) })

    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
    expect(store.snapshot().projects[0].folderIdentities?.[realpathSync(root)]).toEqual(legacy)
  })

  it('does not migrate a legacy same-device identity when the folder postdates the grant', async () => {
    const { root, service, store } = setup()
    const current = identity(root)
    expect(current.birthtimeNs).toBeDefined()
    const legacy = { dev: current.dev, ino: current.ino }
    await store.update((state) => { state.projects.push({
      id: 'legacy-same-device-replacement', harness: 'prime', name: 'Legacy same-device replacement', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: new Date(0).toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: { [realpathSync(root)]: legacy },
    }) })

    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
    expect(store.snapshot().projects[0].folderIdentities?.[realpathSync(root)]).toEqual(legacy)
  })

  it('rejects a project folder swapped while its canonical path is being resolved', async () => {
    const { root, store } = setup()
    const original = `${root}-original`
    const replacement = `${root}-replacement`
    mkdirSync(replacement)
    let swapped = false
    const service = new ProjectService(store, () => null, 'prime', {
      lstat: (path) => lstat(path, { bigint: true }),
      realpath: async (path) => {
        if (!swapped) {
          swapped = true
          renameSync(root, original)
          symlinkSync(replacement, root, 'dir')
        }
        return realpath(path)
      },
    })
    const captureFolderIdentity = (service as unknown as {
      captureFolderIdentity(path: string): Promise<unknown>
    }).captureFolderIdentity.bind(service)

    await expect(captureFolderIdentity(root)).rejects.toThrow(/identity changed while it was being verified/)
  })

  it('keeps a fingerprinted grant across a filesystem device renumber', async () => {
    const { root, service, store } = setup()
    const current = identity(root)
    expect(current.birthtimeNs).toBeDefined()
    const beforeRemount = { ...current, dev: (BigInt(current.dev) + 1n).toString() }
    await store.update((state) => { state.projects.push({
      id: 'fingerprinted-remount', harness: 'prime', name: 'Fingerprinted remount', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: { [realpathSync(root)]: beforeRemount },
    }) })

    await expect(service.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    expect(store.snapshot().projects[0].folderIdentities?.[realpathSync(root)]).toEqual(current)
  })

  it('rejects a same-inode folder whose persisted birth time does not match', async () => {
    const { root, service, store } = setup()
    const current = identity(root)
    expect(current.birthtimeNs).toBeDefined()
    const replaced = { ...current, birthtimeNs: (BigInt(current.birthtimeNs!) + 1n).toString() }
    await store.update((state) => { state.projects.push({
      id: 'replaced', harness: 'prime', name: 'Replaced', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: { [realpathSync(root)]: replaced },
    }) })

    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
    expect(store.snapshot().projects[0].folderIdentities?.[realpathSync(root)]).toEqual(replaced)
  })

  it('revokes a grant when its directory is replaced by a symlink, including after restart', async () => {
    const { root, service, store } = setup()
    const original = `${root}-original`
    const unrelated = `${root}-unrelated`
    mkdirSync(unrelated)
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root),
    }) })
    await service.list()
    expect(await service.authorizeCwd(root)).toBe(realpathSync(root))

    renameSync(root, original)
    symlinkSync(unrelated, root, 'dir')
    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
    await expect(service.listFiles(root)).rejects.toThrow(/identity changed/)

    const restarted = new ProjectService(new JsonStateStore(resolve(root, '..', 'state.json')), () => null)
    restarted.bindProviders({ sessions: async () => [], branch: async () => undefined })
    await restarted.list()
    await expect(restarted.authorizeCwd(root)).rejects.toThrow(/identity changed/)
  })

  it('revokes a grant when its directory is replaced by a regular file', async () => {
    const { root, service, store } = setup()
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root),
    }) })
    await service.list()
    expect(await service.authorizeCwd(root)).toBe(realpathSync(root))

    rmSync(root, { recursive: true })
    writeFileSync(root, 'not a directory')
    await expect(service.authorizeCwd(root)).rejects.toThrow(/cwd must be a directory|identity changed/)
  })

  it('serves authorization from the previous complete map while a list refresh is in flight', async () => {
    const { root, service, store } = setup()
    const second = `${root}-second`
    mkdirSync(second)
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      { id: 'project-a', harness: 'prime', name: 'A', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root) },
      { id: 'project-b', harness: 'prime', name: 'B', path: second, folders: [second], primaryFolder: second, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(second) },
    ) })
    let armed = false
    let markEntered!: () => void
    let releaseBranch!: () => void
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered })
    const release = new Promise<void>((resolveRelease) => { releaseBranch = resolveRelease })
    service.bindProviders({ sessions: async () => [], branch: async (cwd) => {
      if (armed && cwd === root) { markEntered(); await release }
      return 'main'
    } })

    await service.list()
    armed = true
    const refresh = service.list()
    await entered
    // The refresh is parked inside branch enrichment: lookups must keep
    // resolving against a complete authorization map.
    await expect(service.authorizeCwd(second)).resolves.toBe(realpathSync(second))
    await expect(service.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    releaseBranch()
    const records = await refresh
    expect(records.find((record) => record.id === 'project-a')?.gitBranch).toBe('main')
  })

  it('revokes a grant when a different directory is recreated at the same path', async () => {
    const { root, service, store } = setup()
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root, pinned: false,
      createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(root),
    }) })
    await service.list()
    const replacement = `${root}-replacement`
    // Allocate while the original exists so the replacement cannot reuse its inode.
    mkdirSync(replacement)
    rmSync(root, { recursive: true })
    renameSync(replacement, root)
    await expect(service.authorizeCwd(root)).rejects.toThrow(/identity changed/)
  })

})

describe('ProjectService harness scoping', () => {
  it('repairs remounted project grants for both harnesses without crossing scopes', async () => {
    const { root, service: primeService, store } = setup()
    const ompRoot = `${root}-omp`
    mkdirSync(ompRoot)
    const ompService = new ProjectService(store, () => null, 'omp')
    const primeCurrent = identity(root)
    const ompCurrent = identity(ompRoot)
    expect(primeCurrent.birthtimeNs).toBeDefined()
    expect(ompCurrent.birthtimeNs).toBeDefined()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      {
        id: 'prime-remount', harness: 'prime', name: 'Prime', path: root, folders: [root], primaryFolder: root,
        pinned: false, createdAt: now, lastOpenedAt: now,
        folderIdentities: { [realpathSync(root)]: { ...primeCurrent, dev: (BigInt(primeCurrent.dev) + 1n).toString() } },
      },
      {
        id: 'omp-remount', harness: 'omp', name: 'OMP', path: ompRoot, folders: [ompRoot], primaryFolder: ompRoot,
        pinned: false, createdAt: now, lastOpenedAt: now,
        folderIdentities: { [realpathSync(ompRoot)]: { ...ompCurrent, dev: (BigInt(ompCurrent.dev) + 1n).toString() } },
      },
    ) })

    await expect(primeService.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    await expect(ompService.authorizeCwd(ompRoot)).resolves.toBe(realpathSync(ompRoot))
    await expect(primeService.authorizeCwd(ompRoot)).rejects.toThrow(/Prime Work/)
    await expect(ompService.authorizeCwd(root)).rejects.toThrow(/OMP Work/)
    expect(store.snapshot().projects.find((project) => project.id === 'prime-remount')?.folderIdentities?.[realpathSync(root)]).toEqual(primeCurrent)
    expect(store.snapshot().projects.find((project) => project.id === 'omp-remount')?.folderIdentities?.[realpathSync(ompRoot)]).toEqual(ompCurrent)
  })

  it('never authorizes a cwd through the other harness\'s grants', async () => {
    const { root, service: primeService, store } = setup()
    const ompRoot = `${root}-omp`
    mkdirSync(ompRoot)
    const ompService = new ProjectService(store, () => null, 'omp')
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      { id: 'prime-project', harness: 'prime', name: 'Prime', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root) },
      { id: 'omp-project', harness: 'omp', name: 'OMP', path: ompRoot, folders: [ompRoot], primaryFolder: ompRoot, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(ompRoot) },
    ) })

    await expect(primeService.authorizeCwd(root)).resolves.toBe(realpathSync(root))
    await expect(primeService.authorizeCwd(ompRoot)).rejects.toThrow(/not inside an added Prime Work project/)
    await expect(ompService.authorizeCwd(ompRoot)).resolves.toBe(realpathSync(ompRoot))
    await expect(ompService.authorizeCwd(root)).rejects.toThrow(/not inside an added OMP Work project/)
  })

  it('lists, tags, and removes only its own harness\'s records against the shared store', async () => {
    const { root, service: primeService, store } = setup()
    const ompRoot = `${root}-omp`
    mkdirSync(ompRoot)
    const ompService = new ProjectService(store, () => null, 'omp')
    ompService.bindProviders({ sessions: async () => [], branch: async () => undefined })
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push(
      { id: 'prime-project', harness: 'prime', name: 'Prime', path: root, folders: [root], primaryFolder: root, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root) },
      { id: 'omp-project', harness: 'omp', name: 'OMP', path: ompRoot, folders: [ompRoot], primaryFolder: ompRoot, pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(ompRoot) },
    ) })

    expect((await primeService.list()).map((record) => `${record.harness}:${record.id}`)).toEqual(['prime:prime-project'])
    expect((await ompService.list()).map((record) => `${record.harness}:${record.id}`)).toEqual(['omp:omp-project'])

    // Removing through the wrong harness's service is a no-op that leaves the grant intact.
    await expect(primeService.remove('omp-project')).resolves.toBe(false)
    await expect(primeService.touch('omp-project')).resolves.toBe(false)
    expect(store.snapshot().projects.map((project) => project.id).sort()).toEqual(['omp-project', 'prime-project'])
    await expect(ompService.authorizeCwd(ompRoot)).resolves.toBe(realpathSync(ompRoot))

    await expect(ompService.remove('omp-project')).resolves.toBe(true)
    expect(store.snapshot().projects.map((project) => project.id)).toEqual(['prime-project'])
    await expect(primeService.authorizeCwd(root)).resolves.toBe(realpathSync(root))
  })

  it('revokes session-derived read-only authorization across sibling harnesses when dismissed on one harness', async () => {
    const { root, service: primeService, store } = setup()
    const ompService = new ProjectService(store, () => null, 'omp')
    const piService = new ProjectService(store, () => null, 'pi')
    writeFileSync(join(root, 'file.txt'), 'content')

    const sessions = [session('session-1', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')]
    primeService.bindProviders({ sessions: async () => sessions, branch: async () => undefined })
    ompService.bindProviders({ sessions: async () => sessions, branch: async () => undefined })
    piService.bindProviders({ sessions: async () => sessions, branch: async () => undefined })

    const [primeRecord] = await primeService.list()
    const [ompRecord] = await ompService.list()
    const [piRecord] = await piService.list()
    expect(primeRecord.inferred).toBe(true)
    expect(ompRecord.inferred).toBe(true)
    expect(piRecord.inferred).toBe(true)

    expect(await primeService.listFiles(root)).toEqual({ entries: [{ path: 'file.txt', type: 'file' }], skipped: 0 })
    expect(await ompService.listFiles(root)).toEqual({ entries: [{ path: 'file.txt', type: 'file' }], skipped: 0 })
    expect(await piService.listFiles(root)).toEqual({ entries: [{ path: 'file.txt', type: 'file' }], skipped: 0 })

    // Prime dismisses the inferred project -> shared dismissedProjectPaths is updated
    expect(await primeService.remove(primeRecord.id)).toBe(true)

    // OMP and Pi must immediately reject without needing an explicit list() call
    await expect(ompService.listFiles(root)).rejects.toThrow(/not inside an added OMP Work project/)
    await expect(ompService.authorizeReadOnlyCwd(root)).rejects.toThrow(/not inside an added OMP Work project/)
    await expect(piService.listFiles(root)).rejects.toThrow(/not inside an added Pi Work project/)
    await expect(piService.authorizeReadOnlyCwd(root)).rejects.toThrow(/not inside an added Pi Work project/)
  })

  it('does not revoke an independent persisted grant on a sibling harness when an inferred project is removed', async () => {
    const { root, service: primeService, store } = setup()
    const ompRoot = `${root}-omp`
    mkdirSync(ompRoot)
    const ompService = new ProjectService(store, () => null, 'omp')
    ompService.bindProviders({ sessions: async () => [], branch: async () => undefined })
    const now = new Date().toISOString()
    await store.update((state) => {
      state.projects.push({
        id: 'omp-project', harness: 'omp', name: 'OMP Persisted', path: ompRoot,
        folders: [ompRoot], primaryFolder: ompRoot, pinned: false, createdAt: now, lastOpenedAt: now,
        folderIdentities: identities(ompRoot),
      })
    })

    primeService.bindProviders({
      sessions: async () => [session('prime-inferred-session', root, '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z')],
      branch: async () => undefined,
    })

    const [inferred] = await primeService.list()
    expect(inferred.inferred).toBe(true)

    expect(await primeService.remove(inferred.id)).toBe(true)
    await expect(ompService.authorizeCwd(ompRoot)).resolves.toBe(realpathSync(ompRoot))
    await expect(ompService.authorizeReadOnlyCwd(ompRoot)).resolves.toBe(realpathSync(ompRoot))
  })
})


describe('ProjectService worktrees', () => {
  it('returns no checkout choices for an authorized non-Git project', async () => {
    const { root, service, store } = setup()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'plain-project', harness: 'prime', name: 'Plain project', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root),
    }) })
    await service.list()

    await expect(service.listWorktrees(root)).resolves.toEqual([])
  })

  it('lists linked worktrees and grants only paths registered to the authorized repository', async () => {
    const { root, service, store } = setup()
    const runGit = (...args: string[]): void => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
    runGit('init', '-q')
    runGit('config', 'user.name', 'Prime Work Test')
    runGit('config', 'user.email', 'test@example.com')
    writeFileSync(join(root, 'file.txt'), 'base\n')
    runGit('add', 'file.txt')
    runGit('commit', '-qm', 'base')
    const linked = join(resolve(root, '..'), 'linked-worktree')
    const outsider = join(resolve(root, '..'), 'not-a-worktree')
    dirs.push(linked, outsider)
    runGit('worktree', 'add', '-qb', 'linked-test', linked)
    mkdirSync(outsider)
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root),
    }) })
    await service.list()

    expect(await service.listWorktrees(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: realpathSync(root), current: true }),
      expect.objectContaining({ path: realpathSync(linked), branch: 'linked-test', current: false }),
    ]))
    const opened = await service.openWorktree(root, realpathSync(linked))
    expect(opened.path).toBe(realpathSync(linked))
    await expect(service.authorizeCwd(linked)).resolves.toBe(realpathSync(linked))
    await expect(service.openWorktree(root, outsider)).rejects.toThrow(/not linked to the authorized Git repository/i)
    expect(store.snapshot().projects.some((project) => resolve(project.path) === resolve(outsider))).toBe(false)
  })
})

describe('ProjectService scripts', () => {
  it('persists setup attempts and resets them when the setup command changes', async () => {
    const { root, service, store } = setup()
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'script-project', harness: 'prime', name: 'Script project', path: root, folders: [root], primaryFolder: root,
      pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: identities(root),
    }) })

    await expect(service.updateScripts('script-project', { setup: 'npm install', run: 'npm run dev' })).resolves.toEqual({
      setup: 'npm install',
      run: 'npm run dev',
      setupLastRun: undefined,
      setupLastExitCode: undefined,
    })
    await expect(service.markSetupStarted('script-project', 'npm install')).resolves.toMatchObject({ setupLastRun: 'npm install' })
    await expect(service.finishSetup('script-project', 'npm install', 0)).resolves.toMatchObject({ setupLastRun: 'npm install', setupLastExitCode: 0 })
    await expect(service.updateScripts('script-project', { setup: 'npm ci', run: 'npm run dev' })).resolves.toMatchObject({
      setup: 'npm ci',
      run: 'npm run dev',
      setupLastRun: undefined,
      setupLastExitCode: undefined,
    })
    await expect(service.finishSetup('script-project', 'npm install', 0)).rejects.toThrow(/changed before it finished/)
  })

  it('rejects script updates for inferred or differently scoped projects', async () => {
    const { service } = setup()
    await expect(service.updateScripts('missing', { setup: '', run: 'npm start' })).rejects.toThrow(/not explicitly granted/)
    await expect(service.updateScripts('missing', { setup: '', run: 'bad\0command' })).rejects.toThrow(/NUL/)
  })
})
