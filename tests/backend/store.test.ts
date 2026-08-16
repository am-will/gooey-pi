import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CURRENT_DESKTOP_STATE_FILENAME,
  defaultSettings,
  JsonStateStore,
  LEGACY_DESKTOP_STATE_FILENAME,
  openDesktopStateStore,
  StateCompatibilityError,
  StateMigrationError,
  UnsupportedStateVersionError,
} from '../../electron/main/store'
import type { JsonStateStoreFileHandle, JsonStateStoreFileSystem } from '../../electron/main/store'
import { SessionService } from '../../electron/main/sessions'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function makeDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-store-'))
  dirs.push(dir)
  return dir
}

function writeValidState(path: string): void {
  writeFileSync(path, JSON.stringify({
    version: 1,
    projects: [],
    settings: defaultSettings(),
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))
}

const realFileSystem: JsonStateStoreFileSystem = {
  open: (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
}

describe('JsonStateStore', () => {
  it('keeps ask_user off on a fresh install and preserves an explicit opt-in', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const store = new JsonStateStore(path)
    expect(store.getSettings().askUserEnabled).toBe(false)

    await store.update((state) => { state.settings.askUserEnabled = true })
    await store.beginShutdown()

    expect(new JsonStateStore(path).getSettings().askUserEnabled).toBe(true)
  })

  it('defaults, persists, and validates the locale preference', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const settings = { ...defaultSettings(), locale: 'zh-CN' as const }
    writeFileSync(path, JSON.stringify({ version: 4, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).getSettings().locale).toBe('zh-CN')

    writeFileSync(path, JSON.stringify({ version: 4, projects: [], settings: { ...settings, locale: 'fr' }, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).getSettings().locale).toBe('system')
  })

  it('serializes concurrent updates without losing data', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const store = new JsonStateStore(path)
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.update((state) => { state.archivedSessions.push(String(index)) })))
    expect(store.snapshot().archivedSessions).toHaveLength(20)
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toHaveLength(20)
  })

  it('defaults to Orb and preserves the selected pet across a full store restart', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const store = new JsonStateStore(path)
    expect(store.getSettings().petId).toBe('orb')

    await store.update((state) => { state.settings.petId = 'codex/rocky' })
    await store.beginShutdown()

    expect(new JsonStateStore(path).getSettings().petId).toBe('codex/rocky')
  })

  it('defaults and validates the configurable message Enter action', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const settings = { ...defaultSettings(), messageEnterAction: 'steer' }
    writeFileSync(path, JSON.stringify({ version: 1, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [] }))
    expect(new JsonStateStore(path).snapshot().settings.messageEnterAction).toBe('steer')

    settings.messageEnterAction = 'invalid' as typeof settings.messageEnterAction
    writeFileSync(path, JSON.stringify({ version: 1, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [] }))
    expect(new JsonStateStore(path).snapshot().settings.messageEnterAction).toBe('queue')
  })

  it('keeps supported interface font scales and resets values outside the bounded choices', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const settings = { ...defaultSettings(), interfaceFontScale: 115 }
    writeFileSync(path, JSON.stringify({ version: 3, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).snapshot().settings.interfaceFontScale).toBe(115)

    settings.interfaceFontScale = 100 as typeof settings.interfaceFontScale
    writeFileSync(path, JSON.stringify({ version: 3, projects: [], settings, archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    expect(new JsonStateStore(path).snapshot().settings.interfaceFontScale).toBe(110)
  })

  it('stops update admission and drains a write when shutdown starts immediately', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve })
    const file: JsonStateStoreFileHandle = {
      writeFile: async () => { markWriteStarted(); await writeGate },
      sync: async () => undefined,
      close: async () => undefined,
    }
    const directory: JsonStateStoreFileHandle = {
      writeFile: async () => { throw new Error('unexpected directory write') },
      sync: async () => undefined,
      close: async () => undefined,
    }
    const store = new JsonStateStore(path, {
      open: async (_openedPath, flags) => flags === 'w' ? file : directory,
      rename: async () => undefined,
      unlink: async () => undefined,
    })

    const update = store.update((state) => { state.archivedSessions.push('before-quit') })
    const drain = store.beginShutdown()
    await writeStarted
    await expect(store.update((state) => { state.archivedSessions.push('after-quit') })).rejects.toThrow(/shutting down/)
    let drained = false
    void drain.then(() => { drained = true })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(drained).toBe(false)

    releaseWrite()
    await Promise.all([update, drain])
    expect(store.snapshot().archivedSessions).toEqual(['before-quit'])
  })

  it('publishes a snapshot only after the file and containing directory are durable', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    const events: string[] = []
    let releaseDirectorySync!: () => void
    let markDirectorySyncStarted!: () => void
    const directorySyncGate = new Promise<void>((resolve) => { releaseDirectorySync = resolve })
    const directorySyncStarted = new Promise<void>((resolve) => { markDirectorySyncStarted = resolve })
    const file: JsonStateStoreFileHandle = {
      writeFile: async () => { events.push('file-write') },
      sync: async () => { events.push('file-sync') },
      close: async () => { events.push('file-close') },
    }
    const directory: JsonStateStoreFileHandle = {
      writeFile: async () => { throw new Error('unexpected directory write') },
      sync: async () => {
        events.push('directory-sync')
        markDirectorySyncStarted()
        await directorySyncGate
      },
      close: async () => { events.push('directory-close') },
    }
    const fileSystem: JsonStateStoreFileSystem = {
      open: async (_openedPath, flags) => {
        events.push(flags === 'w' ? 'file-open' : 'directory-open')
        return flags === 'w' ? file : directory
      },
      rename: async () => { events.push('rename') },
      unlink: async () => { events.push('unlink') },
    }
    const store = new JsonStateStore(path, fileSystem)

    const operation = store.update((state) => {
      state.archivedSessions.push('durable')
      return 42
    })
    await directorySyncStarted

    expect(store.snapshot().archivedSessions).toEqual([])
    expect(events).toEqual([
      'file-open',
      'file-write',
      'file-sync',
      'file-close',
      'rename',
      'directory-open',
      'directory-sync',
    ])

    releaseDirectorySync()
    await expect(operation).resolves.toBe(42)
    expect(events).toEqual([
      'file-open',
      'file-write',
      'file-sync',
      'file-close',
      'rename',
      'directory-open',
      'directory-sync',
      'directory-close',
      'unlink',
    ])
    expect(store.snapshot().archivedSessions).toEqual(['durable'])
  })

  for (const stage of ['open', 'write', 'file-sync', 'file-close', 'rename'] as const) {
    it(`does not publish state and attempts temp cleanup when ${stage} fails`, async () => {
      const dir = makeDirectory()
      const path = join(dir, 'state.json')
      writeValidState(path)
      const events: string[] = []
      const file: JsonStateStoreFileHandle = {
        writeFile: async () => {
          events.push('write')
          if (stage === 'write') throw new Error('injected write failure')
        },
        sync: async () => {
          events.push('file-sync')
          if (stage === 'file-sync') throw new Error('injected file sync failure')
        },
        close: async () => {
          events.push('file-close')
          if (stage === 'file-close') throw new Error('injected close failure')
        },
      }
      const fileSystem: JsonStateStoreFileSystem = {
        open: async () => {
          events.push('open')
          if (stage === 'open') throw new Error('injected open failure')
          return file
        },
        rename: async () => {
          events.push('rename')
          if (stage === 'rename') throw new Error('injected rename failure')
        },
        unlink: async () => { events.push('unlink') },
      }
      const store = new JsonStateStore(path, fileSystem)

      await expect(store.update((state) => { state.archivedSessions.push('lost') })).rejects.toThrow('injected')
      expect(events.at(-1)).toBe('unlink')
      expect(store.snapshot().archivedSessions).toEqual([])
    })
  }

  it('removes a real temp file after a failed write and continues with the next queued update', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeValidState(path)
    let failNextWrite = true
    const fileSystem: JsonStateStoreFileSystem = {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        const handle = await open(openedPath, flags, mode)
        if (flags !== 'w' || !failNextWrite) return handle
        failNextWrite = false
        return {
          writeFile: async (data, options) => {
            await handle.writeFile(data, options)
            throw new Error('injected write failure')
          },
          sync: () => handle.sync(),
          close: () => handle.close(),
        }
      },
    }
    const store = new JsonStateStore(path, fileSystem)

    await expect(store.update((state) => { state.archivedSessions.push('failed') })).rejects.toThrow('injected write failure')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(store.snapshot().archivedSessions).toEqual([])
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual([])

    await store.update((state) => { state.archivedSessions.push('succeeded') })
    expect(store.snapshot().archivedSessions).toEqual(['succeeded'])
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual(['succeeded'])
  })

  it('creates private state files and directories', async () => {
    const dir = makeDirectory()
    const stateDirectory = join(dir, 'nested')
    const path = join(stateDirectory, 'state.json')
    const store = new JsonStateStore(path)
    await store.update((state) => { state.archivedSessions.push('saved') })

    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('caps archived sessions and dismissed project paths on load and write', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [],
      settings: defaultSettings(),
      archivedSessions: Array.from({ length: 5_200 }, (_, index) => `/sessions/${index}.jsonl`),
      dismissedProjectPaths: Array.from({ length: 1_500 }, (_, index) => `/projects/${index}`),
    }))
    const store = new JsonStateStore(path)
    const loaded = store.snapshot()
    expect(loaded.archivedSessions).toHaveLength(5_000)
    expect(loaded.archivedSessions[0]).toBe('/sessions/200.jsonl')
    expect(loaded.archivedSessions.at(-1)).toBe('/sessions/5199.jsonl')
    expect(loaded.dismissedProjectPaths).toHaveLength(1_024)
    expect(loaded.dismissedProjectPaths.at(-1)).toBe('/projects/1499')

    await store.update((state) => {
      state.archivedSessions.push('/sessions/newest.jsonl')
      state.dismissedProjectPaths.push('/projects/newest')
    })
    const written = JSON.parse(readFileSync(path, 'utf8')) as { archivedSessions: string[]; dismissedProjectPaths: string[] }
    expect(written.archivedSessions).toHaveLength(5_000)
    expect(written.archivedSessions.at(-1)).toBe('/sessions/newest.jsonl')
    expect(written.dismissedProjectPaths).toHaveLength(1_024)
    expect(written.dismissedProjectPaths.at(-1)).toBe('/projects/newest')
  })

  it('exposes narrow slice accessors that clone only their slice', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [{ id: 'p1', name: 'One', path: '/one', folders: ['/one'], primaryFolder: '/one' }],
      settings: { ...defaultSettings(), terminalShell: '/bin/bash' },
      archivedSessions: ['/sessions/kept.jsonl'],
      dismissedProjectPaths: [],
    }))
    const store = new JsonStateStore(path)

    const settings = store.getSettings()
    expect(settings.terminalShell).toBe('/bin/bash')
    settings.terminalShell = '/bin/tampered'
    expect(store.getSettings().terminalShell).toBe('/bin/bash')

    const projects = store.getProjects()
    expect(projects.map((project) => project.id)).toEqual(['p1'])
    projects[0].name = 'tampered'
    expect(store.getProjects()[0].name).toBe('One')

    const archived = store.getArchivedSessions()
    expect(archived).toEqual(['/sessions/kept.jsonl'])
    archived.push('/sessions/tampered.jsonl')
    expect(store.getArchivedSessions()).toEqual(['/sessions/kept.jsonl'])
  })

  it('migrates version 2 state: projects gain the prime harness and settings gain harness defaults', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    const { activeHarness: _activeHarness, ompApprovalMode: _ompApprovalMode, ...legacySettings } = defaultSettings()
    writeFileSync(path, JSON.stringify({
      version: 2,
      projects: [{ id: 'legacy', name: 'Legacy', path: '/legacy', folders: ['/legacy'], primaryFolder: '/legacy' }],
      settings: legacySettings,
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const state = new JsonStateStore(path).snapshot()
    expect(state.version).toBe(4)
    expect(state.projects.map((project) => project.harness)).toEqual(['prime'])
    expect(state.settings.activeHarness).toBe('prime')
    expect(state.settings.ompApprovalMode).toBe('inherit')
    expect(state.settings.askUserEnabled).toBe(false)
  })

  it('keeps valid harness fields and drops projects with hostile harnesses', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [
        { id: 'omp-project', harness: 'omp', name: 'OMP', path: '/omp', folders: ['/omp'], primaryFolder: '/omp' },
        { id: 'hostile', harness: { toString: 'omp' }, name: 'Hostile', path: '/hostile', folders: ['/hostile'], primaryFolder: '/hostile' },
      ],
      settings: { ...defaultSettings(), activeHarness: 'omp', ompApprovalMode: 'yolo' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const kept = new JsonStateStore(path).snapshot()
    expect(kept.projects.map((project) => project.harness)).toEqual(['omp'])
    expect(kept.settings.activeHarness).toBe('omp')
    expect(kept.settings.ompApprovalMode).toBe('yolo')

    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), activeHarness: 'prime' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    expect(new JsonStateStore(path).snapshot().settings.activeHarness).toBe('prime')

    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), activeHarness: 'codex', ompApprovalMode: 'sudo' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const reset = new JsonStateStore(path).snapshot()
    expect(reset.settings.activeHarness).toBe('omp')
    expect(reset.settings.ompApprovalMode).toBe('inherit')
  })

  it('accepts the pi harness for projects and the active workspace', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [
        { id: 'pi-project', harness: 'pi', name: 'Pi', path: '/pi', folders: ['/pi'], primaryFolder: '/pi' },
        { id: 'hostile', harness: 'PI', name: 'Hostile', path: '/hostile', folders: ['/hostile'], primaryFolder: '/hostile' },
      ],
      settings: { ...defaultSettings(), activeHarness: 'pi' },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const state = new JsonStateStore(path).snapshot()
    expect(state.version).toBe(4)
    expect(state.projects.map((project) => project.harness)).toEqual(['pi'])
    expect(state.settings.activeHarness).toBe('pi')
  })

  it('bounds piDisabledProviders and defaults the field when absent', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), piDisabledProviders: ['openai', 'openai', '../evil', 42, 'anthropic'] },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    expect(new JsonStateStore(path).snapshot().settings.piDisabledProviders).toEqual(['openai', 'anthropic'])

    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: { ...defaultSettings(), piDisabledProviders: Array.from({ length: 400 }, (_, index) => `provider-${index}`) },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    expect(new JsonStateStore(path).snapshot().settings.piDisabledProviders).toHaveLength(256)

    // A version-3 state written before pi support keeps its version and gains the default.
    const { piDisabledProviders: _piDisabledProviders, ...prePiSettings } = defaultSettings()
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: prePiSettings,
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const state = new JsonStateStore(path).snapshot()
    expect(state.version).toBe(4)
    expect(state.settings.piDisabledProviders).toEqual([])
  })

  it('preserves an unsupported future state byte-for-byte and refuses updates', async () => {
    const dir = makeDirectory()
    const path = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const raw = '{\n  "version": 99,\n  "futureAuthority": { "leave": "exactly as written" }\n}\n'
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(path, raw)
    writeFileSync(legacyPath, legacyRaw)
    const store = new JsonStateStore(path, realFileSystem, legacyPath, 'linux')
    const mutator = vi.fn()

    expect(() => store.snapshot()).toThrow(UnsupportedStateVersionError)
    expect(() => store.getSettings()).toThrow(UnsupportedStateVersionError)
    expect(() => store.getProjects()).toThrow(UnsupportedStateVersionError)
    expect(() => store.getArchivedSessions()).toThrow(UnsupportedStateVersionError)
    await expect(store.ready()).rejects.toBeInstanceOf(UnsupportedStateVersionError)
    await expect(store.ready()).rejects.toThrow(/version 99.*newer.*version 4.*upgrade GooeyPi/i)
    await expect(store.update(mutator)).rejects.toBeInstanceOf(UnsupportedStateVersionError)
    expect(mutator).not.toHaveBeenCalled()
    await store.beginShutdown()

    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(existsSync(legacyPath)).toBe(false)
    const backup = readdirSync(dir).find((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))
    expect(backup).toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe(legacyRaw)
  })

  it('restores recreated POSIX legacy authority when retiring it beside incompatible current state cannot be synchronized', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentRaw = '{\n  "version": 99,\n  "futureAuthority": true\n}\n'
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(currentPath, currentRaw)
    writeFileSync(legacyPath, legacyRaw)
    let directorySyncs = 0
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => {
            directorySyncs += 1
            if (directorySyncs === 1) throw Object.assign(new Error('injected incompatible-state retirement sync failure'), { code: 'EIO' })
          },
          close: async () => undefined,
        }
      },
    }, legacyPath, 'linux')
    const mutator = vi.fn()
    const readiness = store.ready()

    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/retirement was not durable.*legacy filename was restored/i)
    await expect(readiness).rejects.toMatchObject({ currentStatePath: currentPath, legacyStatePath: legacyPath, backupStatePath: undefined })
    await expect(store.update(mutator)).rejects.toBeInstanceOf(UnsupportedStateVersionError)
    expect(mutator).not.toHaveBeenCalled()
    expect(directorySyncs).toBe(2)
    expect(readFileSync(currentPath, 'utf8')).toBe(currentRaw)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyRaw)
    expect(readdirSync(dir).filter((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))).toEqual([])
  })

  it('atomically migrates the legacy authority to the versioned filename and ignores later downgrade writes', async () => {
    const dir = makeDirectory()
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyRaw = JSON.stringify({
      version: 3,
      projects: [
        { id: 'omp-project', harness: 'omp', name: 'OMP', path: '/omp', folders: ['/omp'], primaryFolder: '/omp' },
        { id: 'missing-harness', name: 'Missing', path: '/missing', folders: ['/missing'], primaryFolder: '/missing' },
      ],
      settings: defaultSettings(),
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }, null, 2)
    writeFileSync(legacyPath, legacyRaw)

    const migrated = await openDesktopStateStore(dir)
    expect(migrated.snapshot().projects.map(({ id, harness }) => ({ id, harness }))).toEqual([{ id: 'omp-project', harness: 'omp' }])
    await migrated.beginShutdown()
    expect(JSON.parse(readFileSync(currentPath, 'utf8'))).toMatchObject({ version: 4, projects: [{ id: 'omp-project', harness: 'omp' }] })
    expect(existsSync(legacyPath)).toBe(false)
    const firstBackup = readdirSync(dir).find((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))
    expect(firstBackup).toBeDefined()
    expect(readFileSync(join(dir, firstBackup!), 'utf8')).toBe(legacyRaw)

    const currentRaw = readFileSync(currentPath, 'utf8')
    const downgradedRaw = JSON.stringify({
      version: 2,
      projects: [{ id: 'downgrade-write', name: 'Downgrade write', path: '/downgrade', folders: ['/downgrade'], primaryFolder: '/downgrade' }],
      settings: defaultSettings(),
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    })
    writeFileSync(legacyPath, downgradedRaw)

    const reopened = await openDesktopStateStore(dir)
    expect(reopened.snapshot().projects.map(({ id, harness }) => ({ id, harness }))).toEqual([{ id: 'omp-project', harness: 'omp' }])
    expect(readFileSync(currentPath, 'utf8')).toBe(currentRaw)
    expect(existsSync(legacyPath)).toBe(false)
    const backups = readdirSync(dir).filter((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))
    expect(backups).toHaveLength(2)
    expect(backups.map((name) => readFileSync(join(dir, name), 'utf8'))).toContain(downgradedRaw)
    await reopened.update((state) => { state.archivedSessions.push('/sessions/new.jsonl') })
    await reopened.beginShutdown()
    expect(JSON.parse(readFileSync(currentPath, 'utf8')).archivedSessions).toEqual(['/sessions/new.jsonl'])
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('fails readiness and updates when a recreated legacy authority cannot be retired', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentRaw = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(currentPath, currentRaw)
    writeFileSync(legacyPath, legacyRaw)
    const retirementError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      rename: async (oldPath, newPath) => {
        if (oldPath === legacyPath) throw retirementError
        await rename(oldPath, newPath)
      },
    }, legacyPath)

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toMatchObject({ currentStatePath: currentPath, legacyStatePath: legacyPath })
    await expect(readiness).rejects.toThrow(/legacy.*retire.*permission denied.*retry/i)
    await expect(store.update((state) => { state.archivedSessions.push('/must-not-write') })).rejects.toThrow(/legacy.*retire.*permission denied/i)
    expect(readFileSync(currentPath, 'utf8')).toBe(currentRaw)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyRaw)
  })

  it('fsyncs the legacy parent directory after retiring its authority filename', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    writeFileSync(currentPath, JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    writeFileSync(legacyPath, JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] }))
    const events: string[] = []
    const directory: JsonStateStoreFileHandle = {
      writeFile: async () => { throw new Error('unexpected directory write') },
      sync: async () => { events.push('directory-sync') },
      close: async () => { events.push('directory-close') },
    }
    const store = new JsonStateStore(currentPath, {
      open: async (openedPath, flags) => {
        expect(openedPath).toBe(dir)
        expect(flags).toBe('r')
        events.push('directory-open')
        return directory
      },
      rename: async (oldPath, newPath) => {
        expect(oldPath).toBe(legacyPath)
        expect(newPath).toContain(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`)
        events.push('legacy-rename')
        await rename(oldPath, newPath)
      },
      unlink,
    }, legacyPath)

    await store.ready()
    expect(events).toEqual(['legacy-rename', 'directory-open', 'directory-sync', 'directory-close'])
  })

  it('does not require directory fsync on a fresh install with no legacy authority', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => { throw Object.assign(new Error('directory fsync unavailable'), { code: 'EINVAL' }) },
          close: async () => undefined,
        }
      },
    }, legacyPath)

    await store.ready()
    expect(JSON.parse(readFileSync(currentPath, 'utf8'))).toMatchObject({ version: 4, projects: [] })
    expect(existsSync(legacyPath)).toBe(false)
  })

  it('keeps the legacy authority when publishing v4 cannot fsync its directory', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(legacyPath, legacyRaw)
    const directorySyncError = Object.assign(new Error('injected directory I/O failure'), { code: 'EIO' })
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => { throw directorySyncError },
          close: async () => undefined,
        }
      },
    }, legacyPath)

    await expect(store.ready()).rejects.toThrow(/directory could not be synchronized.*I\/O failure/i)
    await expect(store.update((state) => { state.archivedSessions.push('/must-not-write') })).rejects.toThrow(/directory could not be synchronized/i)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyRaw)
    expect(readdirSync(dir).some((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))).toBe(false)
  })

  it('restores the legacy filename when its retirement directory fsync fails', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentRaw = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(currentPath, currentRaw)
    writeFileSync(legacyPath, legacyRaw)
    let syncAttempts = 0
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => {
            syncAttempts += 1
            if (syncAttempts === 1) throw Object.assign(new Error('injected retirement sync failure'), { code: 'EIO' })
          },
          close: async () => undefined,
        }
      },
    }, legacyPath)

    await expect(store.ready()).rejects.toThrow(/retirement was not durable.*legacy filename was restored/i)
    await expect(store.update((state) => { state.archivedSessions.push('/must-not-write') })).rejects.toThrow(/retirement was not durable/i)
    expect(readFileSync(currentPath, 'utf8')).toBe(currentRaw)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyRaw)
    expect(readdirSync(dir).filter((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))).toEqual([])

    const retried = await openDesktopStateStore(dir)
    expect(existsSync(legacyPath)).toBe(false)
    await retried.beginShutdown()
  })

  it('reports a rollback rename failure separately and preserves the migrated backup path', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentRaw = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(currentPath, currentRaw)
    writeFileSync(legacyPath, legacyRaw)
    let backupPath = ''
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => { throw Object.assign(new Error('injected retirement sync failure'), { code: 'EIO' }) },
          close: async () => undefined,
        }
      },
      rename: async (oldPath, newPath) => {
        if (oldPath === legacyPath) {
          backupPath = newPath
          await rename(oldPath, newPath)
          return
        }
        throw Object.assign(new Error('injected rollback rename failure'), { code: 'EACCES' })
      },
    }, legacyPath)

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/rollback rename failed.*injected rollback rename failure/i)
    await expect(readiness).rejects.toMatchObject({ backupStatePath: expect.stringContaining(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`) })
    expect(existsSync(legacyPath)).toBe(false)
    expect(readFileSync(backupPath, 'utf8')).toBe(legacyRaw)
  })

  it('reports rollback fsync failure after restoring the legacy filename', async () => {
    const dir = makeDirectory()
    const currentPath = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const currentRaw = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(currentPath, currentRaw)
    writeFileSync(legacyPath, legacyRaw)
    let syncAttempts = 0
    const store = new JsonStateStore(currentPath, {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        if (openedPath !== dir || flags !== 'r') return open(openedPath, flags, mode)
        return {
          writeFile: async () => { throw new Error('unexpected directory write') },
          sync: async () => {
            syncAttempts += 1
            throw Object.assign(new Error(`injected directory sync failure ${syncAttempts}`), { code: 'EIO' })
          },
          close: async () => undefined,
        }
      },
    }, legacyPath)

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/legacy filename was restored.*rollback directory sync failed.*failure 2/i)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacyRaw)
  })

  it('keeps only bounded absolute runtime path overrides without changing the active harness', () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, JSON.stringify({
      version: 3,
      projects: [],
      settings: {
        ...defaultSettings(),
        runtimePaths: { prime: '/opt/prime-agent', omp: 'relative/omp', pi: 'x'.repeat(4_097) },
        enabledHarnesses: ['pi', 'pi', 'invalid'],
        activeHarness: 'omp',
      },
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
    }))
    const state = new JsonStateStore(path).snapshot()
    expect(state.settings.runtimePaths).toEqual({ prime: '/opt/prime-agent', omp: '', pi: '' })
    expect(state.settings.enabledHarnesses).toEqual(['pi'])
    expect(state.settings.activeHarness).toBe('omp')
  })

  it('preserves an oversized state file and fails closed without rewriting it', async () => {
    const dir = makeDirectory()
    const path = join(dir, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(dir, LEGACY_DESKTOP_STATE_FILENAME)
    const raw = `{"version":99,"padding":"${'x'.repeat(64 * 1024 * 1024)}"}`
    const legacyRaw = JSON.stringify({ version: 2, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    writeFileSync(path, raw)
    writeFileSync(legacyPath, legacyRaw)
    const store = new JsonStateStore(path, realFileSystem, legacyPath, 'linux')
    const mutator = vi.fn()

    expect(() => store.snapshot()).toThrow(StateCompatibilityError)
    await expect(store.ready()).rejects.toThrow(/exceeds.*safe.*left unchanged/i)
    await expect(store.update(mutator)).rejects.toBeInstanceOf(StateCompatibilityError)
    expect(mutator).not.toHaveBeenCalled()
    await store.beginShutdown()
    expect(readFileSync(path, 'utf8')).toBe(raw)
    expect(existsSync(legacyPath)).toBe(false)
    const backup = readdirSync(dir).find((name) => name.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`))
    expect(backup).toBeDefined()
    expect(readFileSync(join(dir, backup!), 'utf8')).toBe(legacyRaw)
  })

  it('backs up corrupt state, returns defaults, and serializes recovery before later updates', async () => {
    const dir = makeDirectory()
    const path = join(dir, 'state.json')
    writeFileSync(path, '{broken')
    const store = new JsonStateStore(path)
    expect(store.snapshot().version).toBe(4)
    expect(store.snapshot().projects).toEqual([])

    await store.update((state) => { state.archivedSessions.push('after-recovery') })
    expect(readdirSync(dir).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).archivedSessions).toEqual(['after-recovery'])
  })
  it('archives and restores session visibility metadata without touching the transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-session-')); dirs.push(dir)
    const sessionRoot = join(dir, 'sessions')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(sessionRoot)
    const transcript = join(sessionRoot, 'session.jsonl')
    writeFileSync(transcript, '{"type":"session"}\n')
    const store = new JsonStateStore(join(dir, 'state.json'))
    const sessions = new SessionService(store, null)
    Object.defineProperty(sessions, 'sessionRoot', { value: sessionRoot })
    await sessions.archive(transcript, true)
    expect(store.snapshot().archivedSessions).toContain(realpathSync(transcript))
    expect(await sessions.list()).toHaveLength(0)
    expect((await sessions.list(undefined, true))[0]?.archived).toBe(true)
    await sessions.archive(transcript, false)
    expect(store.snapshot().archivedSessions).not.toContain(realpathSync(transcript))
    expect((await sessions.list())[0]?.archived).toBe(false)
    expect(readFileSync(transcript, 'utf8')).toBe('{"type":"session"}\n')
  })

})
