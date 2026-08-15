import { appendFileSync, chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, type Stats } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager } from '../../electron/main/agent-rpc'
import { ProjectService } from '../../electron/main/projects'
import { SessionService, type SessionServiceOptions } from '../../electron/main/sessions'
import { boundedSessionDiscoveryNames, SessionMetadataCatalog, type SessionCatalogIo } from '../../electron/main/sessions/catalog'
import { applyLiveMetadata, createSessionMetadataReader, METADATA_VERIFY_TAIL_BYTES, readSessionMetadata, type SessionMetadata } from '../../electron/main/sessions/metadata'
import { JsonStateStore } from '../../electron/main/store'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) })

function setup(
  maxSessionFiles?: number,
  options?: SessionServiceOptions,
): { root: string; project: string; service: SessionService; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-sessions-')); dirs.push(dir)
  const root = join(dir, 'sessions'); mkdirSync(root)
  const project = join(dir, 'project'); mkdirSync(project)
  const store = new JsonStateStore(join(dir, 'state.json'))
  const service = new SessionService(store, null, maxSessionFiles, options)
  Object.defineProperty(service, 'sessionRoot', { value: root })
  return { root, project, service, store }
}

function writeSession(path: string, project: string, id: string, timestamp = '2025-01-01T00:00:00.000Z'): void {
  writeFileSync(path, [
    JSON.stringify({ type: 'session', id, cwd: project, timestamp }),
    JSON.stringify({ type: 'message', id: `${id}-message`, parentId: null, message: { role: 'user', content: id, timestamp } }),
    '',
  ].join('\n'))
}

function metadata(filePath: string, projectPath: string, id: string): SessionMetadata {
  return {
    id,
    filePath,
    projectPath,
    title: id,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    status: 'idle',
    depth: 0,
    pinned: false,
    unread: false,
  }
}

describe('live session metadata', () => {
  const liveMetadata = (): SessionMetadata => ({
    id: 'session', filePath: '/sessions/session.jsonl', projectPath: '/project', title: 'Untitled session',
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
    status: 'unknown', depth: 0, pinned: false,
  })

  it('does not show stale inactive daemon work as running', () => {
    const record = liveMetadata()
    applyLiveMetadata(record, { lifecycle: 'live', isSessionActive: false, activity: 'working', isStreaming: true })
    expect(record.status).toBe('idle')
  })

  it('keeps active and legacy busy daemon sessions running', () => {
    const active = liveMetadata()
    const legacy = liveMetadata()
    applyLiveMetadata(active, { lifecycle: 'live', isSessionActive: true, activity: 'working' })
    applyLiveMetadata(legacy, { lifecycle: 'live', isStreaming: true })
    expect(active.status).toBe('running')
    expect(legacy.status).toBe('running')
  })
})

describe('session discovery work bounds', () => {
  it('uses UUIDv7 timestamps for deterministic bounded pre-I/O admission', () => {
    const names = [
      '01800000-0000-7000-8000-000000000000.jsonl',
      'legacy.jsonl',
      '01900000-0002-7000-8000-000000000000.jsonl',
      '01900000-0001-7000-8000-000000000000.jsonl',
    ]
    expect(boundedSessionDiscoveryNames(names, 2)).toEqual([
      '01900000-0002-7000-8000-000000000000.jsonl',
      '01900000-0001-7000-8000-000000000000.jsonl',
    ])
    expect(boundedSessionDiscoveryNames(names, 0)).toEqual([])
  })
})

describe('SessionService catalog scaling', () => {
  it('forces a fresh scan when a just-created session has not emitted a watch event', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'new-session.jsonl')
    writeSession(file, project, 'new-session')
    const catalog = (service as unknown as { catalog: SessionMetadataCatalog }).catalog
    const invalidate = vi.spyOn(catalog, 'invalidateLiveCatalog')
    expect(await service.list(project, false, true)).toMatchObject([{ id: 'new-session' }])
    expect(invalidate).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent lists and reuses metadata by canonical path, mtime, and size', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'one.jsonl')
    writeSession(file, project, 'one')
    const readMetadata = vi.spyOn(service as unknown as { readMetadata(...args: unknown[]): Promise<unknown> }, 'readMetadata')

    const [all, archived, filtered] = await Promise.all([
      service.list(),
      service.list(undefined, true),
      service.list(project),
    ])
    expect(all).toHaveLength(1)
    expect(archived).toHaveLength(1)
    expect(filtered).toHaveLength(1)
    expect(readMetadata).toHaveBeenCalledTimes(1)

    await service.list()
    expect(readMetadata).toHaveBeenCalledTimes(1)
    writeSession(file, project, 'one-expanded', '2025-02-01T00:00:00.000Z')
    expect((await service.list())[0]?.id).toBe('one-expanded')
    expect(readMetadata).toHaveBeenCalledTimes(2)
  })

  it('returns canonical ownership for sessions created through a project alias', async () => {
    const { root, project, service, store } = setup()
    const alias = join(project, '..', 'project-alias')
    symlinkSync(project, alias, 'dir')
    const file = join(root, 'aliased.jsonl')
    writeSession(file, `${alias}/.`, 'aliased')

    const records = await service.list(alias)

    expect(records).toHaveLength(1)
    expect(records[0].projectPath).toBe(realpathSync(project))
    expect(await service.projectPaths()).toEqual([realpathSync(project)])

    const info = lstatSync(project, { bigint: true })
    const now = new Date().toISOString()
    await store.update((state) => { state.projects.push({
      id: 'project', harness: 'prime', name: 'Project', path: project, folders: [project], primaryFolder: project,
      pinned: false, createdAt: now, lastOpenedAt: now,
      folderIdentities: { [project]: { dev: info.dev.toString(), ino: info.ino.toString() } },
    }) })
    const projects = new ProjectService(store, () => null)
    projects.bindProviders({ sessions: () => service.list(), branch: async () => undefined })
    expect(await projects.list()).toEqual([expect.objectContaining({ id: 'project', sessionCount: 1 })])
  })

  it('selects the newest files before parsing with a deterministic canonical-path tie break', async () => {
    const { root, project, service } = setup(2)
    const oldest = join(root, '01800000-0000-7000-8000-000000000000.jsonl')
    const tiedA = join(root, '01900000-0001-7000-8000-000000000000.jsonl')
    const tiedB = join(root, '01900000-0002-7000-8000-000000000000.jsonl')
    writeSession(oldest, project, 'oldest')
    writeSession(tiedA, project, 'newest-a')
    writeSession(tiedB, project, 'newest-b')
    const oldTime = new Date('2024-01-01T00:00:00.000Z')
    const newTime = new Date('2025-01-01T00:00:00.000Z')
    utimesSync(oldest, oldTime, oldTime)
    utimesSync(tiedA, newTime, newTime)
    utimesSync(tiedB, newTime, newTime)

    const records = await service.list()
    expect(records.map((record) => record.id)).toEqual(['newest-a', 'newest-b'])
  })

  it('bounds canonicalize and stat work before scanning a huge directory', async () => {
    const root = '/sessions'
    const maxSessionFiles = 3
    const sessionName = (timestamp: number): string => {
      const prefix = timestamp.toString(16).padStart(12, '0')
      return `${prefix.slice(0, 8)}-${prefix.slice(8)}-7000-8000-${timestamp.toString(16).padStart(12, '0')}.jsonl`
    }
    const names = Array.from({ length: 50_000 }, (_, index) => sessionName(index))
    const canonicalize = vi.fn(async (path: string) => path)
    const inspect = vi.fn(async (path: string) => {
      if (path === root) {
        return { isFile: () => false, isDirectory: () => true, mtimeMs: 1, size: 0, dev: 1, ino: 1 } as Stats
      }
      const name = path.slice(path.lastIndexOf('/') + 1)
      const timestamp = Number.parseInt(name.slice(0, 8) + name.slice(9, 13), 16)
      return { isFile: () => true, isDirectory: () => false, mtimeMs: timestamp, size: 100, dev: 1, ino: timestamp + 2 } as Stats
    })
    const io: SessionCatalogIo = {
      readDirectory: vi.fn(async () => names.map((name) => ({ name }))),
      canonicalize,
      inspect,
    }
    const readMetadata = vi.fn(async (filePath: string) => ({
      id: filePath.slice(filePath.lastIndexOf('/') + 1, -'.jsonl'.length),
      filePath,
      projectPath: '/project',
      title: 'Session',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      status: 'idle' as const,
      depth: 0,
      pinned: false,
      unread: false,
      preview: '',
    }))
    const catalog = new SessionMetadataCatalog(() => root, null, maxSessionFiles, readMetadata, io)

    const records = await catalog.all()

    const selectedIds = [49_999, 49_998, 49_997].map((value) => sessionName(value).slice(0, -'.jsonl'.length))
    expect(records.map((record) => record.id).sort()).toEqual(selectedIds.sort())
    expect(canonicalize).toHaveBeenCalledTimes(1 + maxSessionFiles)
    expect(inspect).toHaveBeenCalledTimes(1 + 2 * maxSessionFiles)
    expect(readMetadata).toHaveBeenCalledTimes(maxSessionFiles)
    expect(inspect.mock.calls.flat().join(' ')).not.toContain(sessionName(0))
  })

  it('re-canonicalizes only entries whose file identity changed between scans', async () => {
    const root = '/sessions'
    const identities = new Map<string, { dev: number; ino: number }>([
      ['a.jsonl', { dev: 1, ino: 10 }],
      ['b.jsonl', { dev: 1, ino: 11 }],
    ])
    const canonicalize = vi.fn(async (path: string) => path)
    const io: SessionCatalogIo = {
      readDirectory: vi.fn(async () => [...identities.keys()].map((name) => ({ name }))),
      canonicalize,
      inspect: vi.fn(async (path: string) => {
        if (path === root) {
          return { isFile: () => false, isDirectory: () => true, mtimeMs: 1, size: 0, dev: 1, ino: 1 } as Stats
        }
        const name = path.slice(path.lastIndexOf('/') + 1)
        const identity = identities.get(name) ?? { dev: 1, ino: 99 }
        return { isFile: () => true, isDirectory: () => false, mtimeMs: 1, size: 100, dev: identity.dev, ino: identity.ino } as Stats
      }),
    }
    const catalog = new SessionMetadataCatalog(
      () => root,
      null,
      20,
      async (filePath) => metadata(filePath, '/project', filePath.slice(filePath.lastIndexOf('/') + 1)),
      io,
    )

    await catalog.all()
    // Root plus one call per newly discovered entry.
    expect(canonicalize).toHaveBeenCalledTimes(3)

    await catalog.all()
    // Unchanged identities reuse the cached canonical paths.
    expect(canonicalize).toHaveBeenCalledTimes(4)
    expect(canonicalize.mock.calls.slice(3).flat()).toEqual([root])

    identities.set('b.jsonl', { dev: 1, ino: 12 })
    await catalog.all()
    expect(canonicalize).toHaveBeenCalledTimes(6)
    expect(canonicalize.mock.calls.slice(4).flat().sort()).toEqual([root, `${root}/b.jsonl`])
  })
})

describe('incremental session metadata reads', () => {
  function trackedReader(): { reader: ReturnType<typeof createSessionMetadataReader>; opens: Array<{ start: number; end: number }> } {
    const opens: Array<{ start: number; end: number }> = []
    const reader = createSessionMetadataReader({
      inspect: stat,
      openStream: (path, start, end) => {
        opens.push({ start, end })
        return createReadStream(path, { start, end })
      },
    })
    return { reader, opens }
  }

  function writeLargeSession(file: string, id: string): void {
    writeSession(file, '/project', id)
    for (let index = 0; index < 8; index += 1) {
      appendFileSync(file, `${JSON.stringify({ type: 'message', id: `${id}-bulk-${index}`, message: { role: 'user', content: `${id} `.repeat(200) } })}\n`)
    }
    expect(statSync(file).size).toBeGreaterThan(METADATA_VERIFY_TAIL_BYTES)
  }

  it('reads only the appended byte range plus the verification tail after the initial parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-incremental-')); dirs.push(dir)
    const file = join(dir, 'incremental.jsonl')
    writeLargeSession(file, 'incremental')
    const { reader, opens } = trackedReader()

    const first = await reader(file)
    const firstSize = statSync(file).size
    expect(first.status).toBe('idle')
    expect(opens).toEqual([{ start: 0, end: firstSize - 1 }])

    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'reply', timestamp: '2025-06-01T00:00:00.000Z', message: { role: 'assistant', content: 'answered' } })}\n`)
    const second = await reader(file)
    const secondSize = statSync(file).size
    expect(second.preview).toBe('answered')
    expect(second.status).toBe('complete')
    expect(second.updatedAt).toBe('2025-06-01T00:00:00.000Z')
    expect(opens).toHaveLength(2)
    expect(opens[1]).toEqual({ start: firstSize - METADATA_VERIFY_TAIL_BYTES, end: secondSize - 1 })
    expect(opens[1]!.start).toBeGreaterThan(0)
    expect(second).toEqual(await readSessionMetadata(file))
  })

  it('resumes a verified partial line and matches the one-shot parser', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-partial-line-')); dirs.push(dir)
    const file = join(dir, 'partial.jsonl')
    writeLargeSession(file, 'partial')
    const { reader, opens } = trackedReader()
    await reader(file)
    const baseSize = statSync(file).size

    const record = JSON.stringify({ type: 'message', id: 'split', message: { role: 'assistant', content: 'split record' } })
    appendFileSync(file, record.slice(0, 25))
    const speculative = await reader(file)
    // The unterminated tail parses speculatively, exactly like a full read.
    expect(speculative).toEqual(await readSessionMetadata(file))
    expect(opens[1]?.start).toBe(baseSize - METADATA_VERIFY_TAIL_BYTES)

    appendFileSync(file, `${record.slice(25)}\n`)
    const completed = await reader(file)
    // Only the verification tail is re-read, nothing earlier.
    expect(opens[2]?.start).toBe(statSync(file).size - record.length - 1 - (METADATA_VERIFY_TAIL_BYTES - 25))
    expect(opens[2]!.start).toBeGreaterThan(0)
    expect(completed.preview).toBe('split record')
    expect(completed).toEqual(await readSessionMetadata(file))
  })

  it('falls back to a full re-read on truncation and rewritten tails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-truncate-')); dirs.push(dir)
    const file = join(dir, 'truncate.jsonl')
    writeSession(file, '/project', 'original')
    appendFileSync(file, JSON.stringify({ type: 'message', id: 'tail', message: { role: 'assistant', content: 'tail' } }).slice(0, 30))
    const { reader, opens } = trackedReader()
    await reader(file)

    writeSession(file, '/project', 'rewritten')
    const rewritten = await reader(file)
    expect(rewritten.preview).toBe('rewritten')
    expect(opens.at(-1)?.start).toBe(0)
    expect(rewritten).toEqual(await readSessionMetadata(file))

    const longer = [
      JSON.stringify({ type: 'session', id: 'replaced', cwd: '/project' }),
      JSON.stringify({ type: 'message', id: 'replaced-1', parentId: null, message: { role: 'user', content: 'a completely different transcript body' } }),
      '',
    ].join('\n')
    writeFileSync(file, longer)
    // Larger file whose retained-tail bytes no longer match: full re-read.
    const replaced = await reader(file)
    expect(replaced.preview).toBe('a completely different transcript body')
    expect(opens.at(-1)?.start).toBe(0)
    expect(replaced).toEqual(await readSessionMetadata(file))
  })
})

describe('SessionService user-message ordering', () => {
  it('ignores later assistant activity until a new user message is sent', async () => {
    const { root, project, service, store } = setup()
    const newerUser = join(root, 'newer-user.jsonl')
    const olderUser = join(root, 'older-user.jsonl')
    writeFileSync(newerUser, [
      JSON.stringify({ type: 'session', id: 'newer-user', cwd: project, timestamp: '2025-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'newer-user-message', parentId: null, timestamp: '2025-03-01T00:00:00.000Z', message: { role: 'user', content: 'newer prompt' } }),
      '',
    ].join('\n'))
    writeFileSync(olderUser, [
      JSON.stringify({ type: 'session', id: 'older-user', cwd: project, timestamp: '2025-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', id: 'older-user-message', parentId: null, message: { role: 'user', content: 'older prompt', timestamp: '2025-02-01T00:00:00.000Z' } }),
      JSON.stringify({ type: 'message', id: 'late-assistant', parentId: 'older-user-message', timestamp: '2025-04-01T00:00:00.000Z', message: { role: 'assistant', content: 'late completion' } }),
      '',
    ].join('\n'))

    const first = await service.list()
    expect(first.map((record) => record.id)).toEqual(['newer-user', 'older-user'])
    expect(first.map((record) => record.lastUserMessageAt)).toEqual([
      '2025-03-01T00:00:00.000Z',
      '2025-02-01T00:00:00.000Z',
    ])

    appendFileSync(olderUser, `${JSON.stringify({ type: 'message', id: 'follow-up', parentId: 'late-assistant', timestamp: '2025-05-01T00:00:00.000Z', message: { role: 'user', content: 'new follow-up' } })}\n`)
    const refreshed = new SessionService(store, null)
    Object.defineProperty(refreshed, 'sessionRoot', { value: root })
    expect((await refreshed.list()).map((record) => record.id)).toEqual(['older-user', 'newer-user'])
  })
})

describe('SessionMetadataCatalog live synchronization', () => {
  it('keeps live overlays when a known-file reconcile refreshes JSONL metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-live-reconcile-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'live.jsonl')
    writeSession(file, project, 'live-v0')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(file)}, isStreaming: true }] }))
`)
    chmodSync(executable, 0o755)
    const reader = createSessionMetadataReader()
    const catalog = new SessionMetadataCatalog(() => root, executable, 20, reader)
    expect(await catalog.all()).toMatchObject([{ id: 'live-v0', status: 'running' }])

    writeSession(file, project, 'live-v1', '2025-02-01T00:00:00.000Z')
    await expect(catalog.reconcileKnownChanges(['live.jsonl'])).resolves.toMatchObject({ kind: 'reconciled' })

    expect(await catalog.all()).toMatchObject([{ id: 'live-v1', status: 'running' }])
  })

  it('does not join an in-flight scan owned by the previous executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-scan-executable-race-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'scan.jsonl')
    writeSession(file, project, 'scan')
    const firstStarted = join(dir, 'first-started')
    const firstRelease = join(dir, 'first-release')
    const makeExecutable = (name: string, streaming: boolean, wait = false) => {
      const executable = join(dir, name)
      writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
${wait ? `fs.writeFileSync(${JSON.stringify(firstStarted)}, '')
const deadline = Date.now() + 5000
while (!fs.existsSync(${JSON.stringify(firstRelease)}) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)` : ''}
process.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(file)}, isStreaming: ${JSON.stringify(streaming)} }] }))
`)
      chmodSync(executable, 0o755)
      return executable
    }
    const firstExecutable = makeExecutable('first-agent.cjs', false, true)
    const secondExecutable = makeExecutable('second-agent.cjs', true)
    let executable = firstExecutable
    const catalog = new SessionMetadataCatalog(
      () => root,
      () => executable,
      20,
      async (filePath) => metadata(filePath, project, 'scan'),
    )

    const stale = catalog.all()
    await waitUntil(() => existsSync(firstStarted))
    executable = secondExecutable
    const current = catalog.all()
    await expect(current).resolves.toMatchObject([{ status: 'running' }])
    writeFileSync(firstRelease, '')
    await expect(stale).resolves.toMatchObject([{ status: 'idle' }])
  })

  it('does not reuse the previous executable cache after runtime discovery changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-catalog-executable-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const firstFile = join(root, 'first.jsonl')
    const secondFile = join(root, 'second.jsonl')
    writeSession(firstFile, project, 'first')
    writeSession(secondFile, project, 'second')
    const makeExecutable = (name: string, sessionFile: string) => {
      const executable = join(dir, name)
      writeFileSync(executable, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(sessionFile)}, isStreaming: true }] }))\n`)
      chmodSync(executable, 0o755)
      return executable
    }
    const firstExecutable = makeExecutable('first-agent.cjs', firstFile)
    const secondExecutable = makeExecutable('second-agent.cjs', secondFile)
    let executable = firstExecutable
    const catalog = new SessionMetadataCatalog(
      () => root,
      () => executable,
      20,
      async (filePath) => metadata(filePath, project, filePath === firstFile ? 'first' : 'second'),
    )

    expect((await catalog.liveSessions()).has(realpathSync(firstFile))).toBe(true)
    executable = secondExecutable
    const refreshed = await catalog.liveSessions()
    expect(refreshed.has(realpathSync(firstFile))).toBe(false)
    expect(refreshed.has(realpathSync(secondFile))).toBe(true)
  })

  it('canonicalizes daemon session paths and never regresses the JSONL update time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-live-catalog-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'live.jsonl')
    writeSession(file, project, 'live', '2025-02-01T00:00:00.000Z')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(file)}, isStreaming: true, modified: '2024-01-01T00:00:00.000Z' }] }))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    const record = (await service.list())[0]
    expect(record?.filePath).toBe(realpathSync(file))
    expect(record?.status).toBe('running')
    expect(record?.updatedAt).toBe('2025-02-01T00:00:00.000Z')
  })

  it('rate limits the live-catalog CLI spawn independently of change events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-catalog-throttle-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'burst.jsonl')
    writeSession(file, project, 'burst')
    const spawnLog = join(dir, 'spawns.log')
    writeFileSync(spawnLog, '')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(spawnLog)}, 'spawn\\n')
process.stdout.write(JSON.stringify({ sessions: [{ sessionFile: ${JSON.stringify(file)}, isStreaming: true }] }))
process.exit(0)
`)
    chmodSync(executable, 0o755)
    const catalog = new SessionMetadataCatalog(
      () => root,
      executable,
      20,
      async (filePath) => metadata(filePath, project, 'burst'),
    )
    const spawnCount = () => readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean).length

    expect((await catalog.all())[0]?.status).toBe('running')
    expect(spawnCount()).toBe(1)
    // A burst of change events within the throttle window serves the previous
    // live snapshot instead of respawning the CLI.
    for (let round = 0; round < 5; round += 1) {
      appendFileSync(file, `${JSON.stringify({ type: 'message', id: `burst-${round}`, message: { role: 'user', content: 'burst' } })}\n`)
      catalog.invalidateLiveCatalog()
      expect((await catalog.all())[0]?.status).toBe('running')
    }
    expect(spawnCount()).toBe(1)

    // Once the minimum spawn interval elapses, the next stale read respawns.
    const throttleHarness = catalog as unknown as { lastCatalogSpawn: { executable: string; at: number } }
    throttleHarness.lastCatalogSpawn.at = Date.now() - 60_000
    catalog.invalidateLiveCatalog()
    await catalog.all()
    expect(spawnCount()).toBe(2)
  })

  it('does not let an in-flight pre-append scan satisfy a post-invalidation refresh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-scan-race-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'race.jsonl')
    writeSession(file, project, 'old')
    const canonical = realpathSync(file)
    const releases: Array<(value: SessionMetadata) => void> = []
    const catalog = new SessionMetadataCatalog(
      () => root,
      null,
      20,
      async () => new Promise<SessionMetadata>((resolveMetadata) => releases.push(resolveMetadata)),
    )

    const stale = catalog.all()
    await waitUntil(() => releases.length === 1)
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'new', message: { role: 'user', content: 'new' } })}\n`)
    catalog.invalidateLiveCatalog()
    const refreshed = catalog.all()
    await waitUntil(() => releases.length === 2)
    releases[1](metadata(canonical, project, 'new'))
    await expect(refreshed).resolves.toMatchObject([{ id: 'new' }])
    releases[0](metadata(canonical, project, 'old'))
    await expect(stale).resolves.toMatchObject([{ id: 'old' }])
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'new' }])
    expect(releases).toHaveLength(2)
  })
})


describe('SessionService live changes', () => {
  it('reconciles a known watched file without enumerating the session directory again', async () => {
    const readDirectory = vi.fn(async (path: string) => readdir(path, { withFileTypes: true }))
    const canonicalize = vi.fn(async (path: string): Promise<string> => realpath(path))
    const inspect = vi.fn(async (path: string): Promise<Stats> => stat(path))
    const inspectLink = vi.fn(async (path: string): Promise<Stats> => lstat(path))
    const watchDirectory: NonNullable<SessionServiceOptions['watchDirectory']> = () => {
      const watcher = { close: vi.fn(), on: () => watcher }
      return watcher
    }
    const { root, project, service } = setup(undefined, {
      catalogIo: { readDirectory, canonicalize, inspect, inspectLink },
      watchDirectory,
    })
    const file = join(root, 'known.jsonl')
    writeSession(file, project, 'known-v0')
    expect(await service.list()).toMatchObject([{ id: 'known-v0' }])
    const enumerationCount = readDirectory.mock.calls.length
    const canonicalizationCount = canonicalize.mock.calls.length

    const events: Array<{ filePath?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    try {
      writeSession(file, project, 'known-v1', '2025-02-01T00:00:00.000Z')
      const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
      watcherHarness.queueSessionChange('known.jsonl')
      await waitUntil(() => events.some((event) => event.filePath === realpathSync(file)), 4_000)

      expect(await service.list()).toMatchObject([{ id: 'known-v1' }])
      expect(readDirectory).toHaveBeenCalledTimes(enumerationCount)
      expect(canonicalize).toHaveBeenCalledTimes(canonicalizationCount + 2)
    } finally {
      unsubscribe()
    }
  })

  it('falls back to a full scan after a watcher error loses the changed file name', async () => {
    const readDirectory = vi.fn(async (path: string) => readdir(path, { withFileTypes: true }))
    let reportWatchError: ((error: Error) => void) | undefined
    const watchDirectory: NonNullable<SessionServiceOptions['watchDirectory']> = () => {
      const watcher = {
        close: vi.fn(),
        on: (_event: 'error', listener: (error: Error) => void) => {
          reportWatchError = listener
          return watcher
        },
      }
      return watcher
    }
    const { root, project, service } = setup(undefined, {
      catalogIo: {
        readDirectory,
        canonicalize: async (path) => realpath(path),
        inspect: async (path) => stat(path),
        inspectLink: async (path) => lstat(path),
      },
      watchDirectory,
    })
    writeSession(join(root, 'known.jsonl'), project, 'known')
    await service.list()
    expect(readDirectory).toHaveBeenCalledOnce()

    const events: Array<{ filePath?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    try {
      reportWatchError?.(new Error('watch overflow'))
      await waitUntil(() => events.some((event) => event.filePath === undefined), 4_000)
      await service.list()
      expect(readDirectory).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
    }
  })

  it('installs a one-level watcher and resolves bucketed session changes', async () => {
    const watched = new Map<string, (eventType: string, filename: string | Buffer | null) => void>()
    const { root, project, service } = setup(undefined, {
      recursiveWatch: true,
      watchDirectory: (path, _options, listener) => {
        watched.set(path, listener)
        const watcher = {
          close: () => { watched.delete(path) },
          on: () => watcher,
        }
        return watcher
      },
    })
    const bucket = join(root, 'project-bucket')
    mkdirSync(bucket)
    const file = join(bucket, 'bucketed.jsonl')
    writeSession(file, project, 'bucketed')
    const events: Array<{ filePath?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))

    try {
      const watcherHarness = service as unknown as { bucketWatchers: Map<string, unknown> }
      await waitUntil(() => watcherHarness.bucketWatchers.has('project-bucket'), 4_000)
      watched.get(realpathSync(bucket))?.('change', 'bucketed.jsonl')
      await waitUntil(() => events.some((event) => event.filePath === realpathSync(file)), 4_000)
    } finally {
      unsubscribe()
    }
  })

  it('emits refreshes during continuous JSONL writes instead of waiting for the stream to stop', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'streaming.jsonl')
    writeSession(file, project, 'streaming')
    const events: Array<{ filePath?: string }> = []
    const unsubscribe = service.onDidChange((event) => events.push(event))
    let index = 0
    const writes = setInterval(() => {
      appendFileSync(file, `${JSON.stringify({ type: 'message', id: `stream-${index++}`, message: { role: 'user', content: 'stream' } })}
`)
    }, 25)

    try {
      await new Promise((resolveWait) => setTimeout(resolveWait, 350))
      expect(events.some((event) => event.filePath === realpathSync(file))).toBe(true)
    } finally {
      clearInterval(writes)
      unsubscribe()
    }
  })

  it('debounces canonical JSONL changes, rejects outside aliases, and stops after unsubscribe', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'watched.jsonl')
    writeSession(file, project, 'watched')
    const events: Array<{ filePath?: string }> = []
    const unsubscribeThrowing = service.onDidChange(() => { throw new Error('listener failure') })
    const unsubscribe = service.onDidChange((event) => events.push(event))

    // Continuous writes above cover the real fs.watch path. Drive the private
    // debounce admission directly here so parallel coverage load cannot drop the
    // single kernel event that this deterministic coalescing assertion needs.
    const watcherHarness = service as unknown as { queueSessionChange(filename: string): void }
    watcherHarness.queueSessionChange('watched.jsonl')
    watcherHarness.queueSessionChange('watched.jsonl')
    await waitUntil(() => events.some((event) => event.filePath === realpathSync(file)), 4_000)
    expect(events.filter((event) => event.filePath === realpathSync(file))).toHaveLength(1)

    const outside = join(root, '..', 'outside.jsonl')
    writeSession(outside, project, 'outside')
    symlinkSync(outside, join(root, 'outside-alias.jsonl'))
    watcherHarness.queueSessionChange('outside-alias.jsonl')
    await waitUntil(() => events.some((event) => event.filePath === undefined), 4_000)
    expect(events.some((event) => event.filePath === realpathSync(outside))).toBe(false)

    unsubscribeThrowing()
    unsubscribe()
    const count = events.length
    appendFileSync(file, `${JSON.stringify({ type: 'message', id: 'after-unsubscribe', message: { role: 'user', content: 'ignored' } })}\n`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 300))
    expect(events).toHaveLength(count)
  })
})

describe('SessionService transcript read admission', () => {
  it('authorizes every caller, coalesces canonical reads, bounds global admission, and isolates results', async () => {
    let active = 0
    let peak = 0
    let releaseReads: (() => void) | undefined
    const gate = new Promise<void>((resolveGate) => { releaseReads = resolveGate })
    const transcriptReader = vi.fn(async (filePath: string) => {
      active += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
      return [{ id: filePath, role: 'user' as const, parts: [{ type: 'text' as const, text: 'original' }] }]
    })
    const { root, project, service } = setup(undefined, {
      maxPendingTranscriptReads: 2,
      transcriptReader,
    })
    const files = Array.from({ length: 5 }, (_, index) => join(root, `${index}.jsonl`))
    for (const [index, file] of files.entries()) writeSession(file, project, String(index))
    const alias = join(root, 'alias.jsonl')
    symlinkSync(files[0], alias)
    const authorize = vi.spyOn(service, 'requireSessionPath')

    const first = service.read(files[0])
    const duplicate = service.read(files[0])
    const aliased = service.read(alias)
    await vi.waitFor(() => {
      expect(authorize).toHaveBeenCalledTimes(3)
      expect(transcriptReader).toHaveBeenCalledTimes(1)
    })
    const second = service.read(files[1])
    await vi.waitFor(() => expect(transcriptReader).toHaveBeenCalledTimes(2))
    const third = service.read(files[2])
    const fourth = service.read(files[3])
    const admission = service as unknown as { transcriptAdmission: { pendingCount: number } }
    await vi.waitFor(() => expect(admission.transcriptAdmission.pendingCount).toBe(2))

    // Attach the rejection assertion immediately: retaining an already-rejected
    // overflow promise while waiting on the reader gate would leak an unhandled rejection.
    const overflow = service.read(files[4])
    await expect(overflow).rejects.toThrow('Too many transcript reads are pending')
    expect(authorize).toHaveBeenCalledTimes(7)
    expect(admission.transcriptAdmission.pendingCount).toBe(2)
    expect(peak).toBe(2)

    releaseReads?.()
    const results = await Promise.all([first, duplicate, aliased, second, third, fourth])
    expect(transcriptReader).toHaveBeenCalledTimes(4)
    expect(peak).toBeLessThanOrEqual(2)
    // Coalesced canonical reads share one immutable result: the IPC boundary
    // clones per renderer, so main-side pre-clones would be redundant copies.
    expect(results[0]).toBe(results[1])
    expect(results[0]).toBe(results[2])
    expect(results[3]).not.toBe(results[0])
    expect(results[0][0]?.parts).toEqual([{ type: 'text', text: 'original' }])
  })
})

describe('SessionService transcript bounds', () => {
  it('returns a bounded recent suffix of long conversations', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'long.jsonl')
    const lines = [JSON.stringify({ type: 'session', id: 'long', cwd: project })]
    let parentId: string | null = null
    for (let index = 0; index < 450; index += 1) {
      const id = `message-${index}`
      lines.push(JSON.stringify({ type: 'message', id, parentId, message: { role: 'user', content: `recent-${index}` } }))
      parentId = id
    }
    writeFileSync(file, `${lines.join('\n')}\n`)

    const transcript = await service.read(file)
    expect(transcript).toHaveLength(400)
    expect(transcript[0]?.id).toBe('message-50')
    expect(transcript.at(-1)?.id).toBe('message-449')
    expect(transcript.at(-1)?.parts).toEqual([{ type: 'text', text: 'recent-449' }])
  })

  it('caps tool arguments, tool output, and image data before IPC return', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'large-parts.jsonl')
    const largeArgs = `args-start-${'a'.repeat(300_000)}-args-end`
    const largeImage = `image-start-${'i'.repeat(3_000_000)}-image-end`
    const largeOutput = `output-start-${'o'.repeat(300_000)}-output-end`
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'large-parts', cwd: project }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: null,
        message: { role: 'assistant', content: [
          { type: 'toolCall', id: 'tool', name: 'large-tool', arguments: largeArgs },
          { type: 'image', mimeType: 'image/png', data: largeImage },
        ] },
      }),
      JSON.stringify({
        type: 'message', id: 'tool-result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'tool', toolName: 'large-tool', content: largeOutput },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    const parts = transcript[0]?.parts ?? []
    const call = parts.find((part) => part.type === 'toolCall')
    const result = parts.find((part) => part.type === 'toolResult')
    const image = parts.find((part) => part.type === 'image')
    expect(typeof call?.args).toBe('string')
    expect((call!.args as string).length).toBeLessThanOrEqual(128 * 1024)
    expect(result?.text.length).toBeLessThanOrEqual(128 * 1024)
    expect(image?.data?.length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(call?.args).toContain('[truncated]')
    expect(result?.text).toContain('[truncated]')
    expect(image?.data).toContain('[truncated]')
    expect(image?.dataTruncated).toBe(true)
  })


  it('preserves agent messages as a distinct transcript role with only the readable body', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'agent-message.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'agent-message', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Delegate this task' } }),
      JSON.stringify({
        type: 'custom_message', id: 'handoff', parentId: 'root', customType: 'agent_message', display: true,
        content: '[from child:reviewer]\nAgent-to-agent message received.\n\nThe full envelope should not be shown.',
        details: {
          message: 'Review complete. The project authorization gate was the root cause.',
          from: { sessionName: 'project-reviewer', runtimeKind: 'subagent' },
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'handoff',
      role: 'agent',
      agentName: 'project-reviewer',
      parts: [{ type: 'text', text: 'Review complete. The project authorization gate was the root cause.' }],
    })
  })

  it('nests agent messages inside an assistant work block', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'nested-agent-message.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'nested-agent-message', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Delegate this task' } }),
      JSON.stringify({ type: 'message', id: 'assistant', parentId: 'root', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Coordinating work' }] } }),
      JSON.stringify({
        type: 'custom_message', id: 'handoff', parentId: 'assistant', customType: 'agent_message', display: true,
        details: { message: 'Review complete.', from: { sessionName: 'project-reviewer' } },
      }),
      JSON.stringify({ type: 'message', id: 'continuation', parentId: 'handoff', message: { role: 'assistant', content: 'Continuing after the review.' } }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript).toHaveLength(2)
    expect(transcript[1]).toMatchObject({
      role: 'assistant',
      parts: [
        { type: 'thinking', text: 'Coordinating work' },
        { type: 'agentMessage', text: 'Review complete.', agentName: 'project-reviewer' },
        { type: 'text', text: 'Continuing after the review.' },
      ],
    })
  })

  it('keeps late agent activity nested after an assistant final answer', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'late-agent-message.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'late-agent-message', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Delegate this task' } }),
      JSON.stringify({ type: 'message', id: 'assistant', parentId: 'root', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Work' }, { type: 'text', text: 'Final answer' }] } }),
      JSON.stringify({ type: 'custom_message', id: 'late', parentId: 'assistant', customType: 'agent_message', display: true, details: { message: 'Late review', from: { sessionName: 'reviewer' } } }),
      '',
    ].join('\n'))

    expect((await service.read(file))[1]?.parts).toEqual([
      { type: 'thinking', text: 'Work' },
      { type: 'text', text: 'Final answer' },
      { type: 'agentMessage', text: 'Late review', agentName: 'reviewer' },
    ])
  })

  it('maps informational custom messages to tool activity instead of system errors', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'ipython-state.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'ipython-state', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Restore state' } }),
      JSON.stringify({ type: 'custom_message', id: 'state', parentId: 'root', customType: 'ipython_state_restored', display: true, content: 'Kernel state restored.' }),
      '',
    ].join('\n'))

    expect((await service.read(file)).at(-1)).toMatchObject({
      role: 'tool',
      parts: [
        { type: 'toolCall', name: 'IPython State Restored' },
        { type: 'toolResult', name: 'IPython State Restored', text: 'Kernel state restored.' },
      ],
    })
  })

  it('preserves goal summaries as a distinct readable transcript role', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'goal-summary.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'goal-summary', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start a goal' } }),
      JSON.stringify({
        type: 'custom_message', id: 'goal', parentId: 'root', customType: 'goal_context', display: true,
        content: '<goal_context>Internal control envelope that should stay hidden.</goal_context>',
        details: {
          kind: 'created',
          goalId: 'goal-1',
          objective: 'Ship the transcript activity refinements.',
          status: 'active',
          continuationsUsed: 0,
        },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.at(-1)).toMatchObject({
      id: 'goal',
      role: 'goal',
      parts: [{ type: 'text', text: 'Ship the transcript activity refinements.' }],
    })
    expect(JSON.stringify(transcript)).not.toContain('<goal_context>')
  })

  it('reconstructs only the final parent branch and merges assistant tool activity', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'branch.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'branch', cwd: project }),
      JSON.stringify({ type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'keep-root' } }),
      JSON.stringify({ type: 'message', id: 'discarded', parentId: 'root', message: { role: 'user', content: 'discard-me' } }),
      JSON.stringify({
        type: 'message', id: 'assistant', parentId: 'root',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call', name: 'lookup', arguments: { query: 'value' } }] },
      }),
      JSON.stringify({
        type: 'message', id: 'result', parentId: 'assistant',
        message: { role: 'toolResult', toolCallId: 'call', toolName: 'lookup', content: 'tool-output' },
      }),
      JSON.stringify({
        type: 'message', id: 'continuation', parentId: 'result',
        message: { role: 'assistant', content: [{ type: 'text', text: 'final-answer' }] },
      }),
      '',
    ].join('\n'))

    const transcript = await service.read(file)
    expect(transcript.map((message) => message.id)).toEqual(['root', 'assistant'])
    expect(transcript[1]?.parts.map((part) => part.type)).toEqual(['toolCall', 'toolResult', 'text'])
    expect(transcript[1]?.parts.at(-1)).toEqual({ type: 'text', text: 'final-answer' })
  })
})


describe('SessionService orchestration', () => {
  it('rejects a Prime MCP auth command before daemon or session-path work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-auth-command-')); dirs.push(dir)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), null)

    await expect(service.followUp(join(dir, 'missing.jsonl'), '/mcp login notion'))
      .rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
  })

  it('queues a follow-up through the active Prime Agent daemon instead of resuming its locked session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-active-session-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'active.jsonl')
    writeSession(file, project, 'active')
    const socketPath = join(dir, 'daemon.sock')
    const deliveredMessages: Array<Record<string, unknown>> = []
    const daemon = createServer((socket) => {
      socket.write(`${JSON.stringify({ type: 'daemon_hello', protocol: { name: 'prime-agent.daemon', version: 7 }, serverCapabilities: ['session_input_admission'] })}\n`)
      let buffer = ''
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n')
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          const envelope = JSON.parse(line) as { id?: string; command?: Record<string, unknown> }
          if (envelope.command?.type !== 'follow_up' && envelope.command?.type !== 'steer') continue
          deliveredMessages.push(envelope)
          socket.write(`${JSON.stringify({ id: envelope.id, type: 'response', command: envelope.command.type, success: true, data: {} })}\n`)
        }
      })
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      daemon.once('error', rejectListen)
      daemon.listen(socketPath, resolveListen)
    })

    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'active-worker', activeSessionId: 'active-worker', lifecycle: 'live', isSessionActive: true, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify([{ isDefault: true, status: 'current', socketPath: ${JSON.stringify(socketPath)} }]))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    try {
      await expect(service.followUp(file, 'queue this reply')).resolves.toBe(true)
      await expect(service.followUp(file, 'change direction', 'steer')).resolves.toBe(true)
      expect(deliveredMessages).toHaveLength(2)
      expect(deliveredMessages[0]).toMatchObject({
        type: 'command',
        protocol: { name: 'prime-agent.daemon', version: 7 },
        command: { type: 'follow_up', activeSessionId: 'active-worker', message: 'queue this reply' },
      })
      expect(deliveredMessages[1]).toMatchObject({
        command: { type: 'steer', activeSessionId: 'active-worker', message: 'change direction' },
      })
      await expect(service.followUp(file, 'invalid', 'later')).rejects.toThrow('Invalid active-session message intent')
    } finally {
      await new Promise<void>((resolveClose) => daemon.close(() => resolveClose()))
    }
  })

  it('rejects a daemon endpoint that is not a same-user Unix socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-untrusted-daemon-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'active.jsonl')
    writeSession(file, project, 'active')
    const socketPath = join(dir, 'not-a-socket')
    writeFileSync(socketPath, 'not a daemon')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'active-worker', lifecycle: 'live', isSessionActive: true, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
if (args[0] === 'status') {
  process.stdout.write(JSON.stringify([{ status: 'current', isDefault: true, socketPath: ${JSON.stringify(socketPath)} }]))
  process.exit(0)
}
process.exit(2)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    await expect(service.followUp(file, 'do not disclose this')).rejects.toThrow('untrusted daemon socket')
  })

  it('resolves follow-up candidates through the cached live catalog instead of a second listing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-followup-catalog-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'busy.jsonl')
    writeSession(file, project, 'busy')
    const countFile = join(dir, 'list-count')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === 'list') {
  fs.appendFileSync(${JSON.stringify(countFile)}, 'x')
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'busy-worker', activeSessionId: 'busy-worker', lifecycle: 'live', isSessionActive: false, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
process.exit(9)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    await service.list()
    await expect(service.followUp(file, 'reuse the catalog')).resolves.toBe(false)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(countFile, 'utf8')).toBe('x')
  })

  it('does not send a follow-up when the session is no longer active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-inactive-session-')); dirs.push(dir)
    const root = join(dir, 'sessions'); mkdirSync(root)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(root, 'inactive.jsonl')
    writeSession(file, project, 'inactive')
    const executable = join(dir, 'prime-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === 'list') {
  process.stdout.write(JSON.stringify({ sessions: [{ id: 'inactive-worker', activeSessionId: 'inactive-worker', lifecycle: 'live', isSessionActive: false, sessionFile: ${JSON.stringify(file)} }] }))
  process.exit(0)
}
process.exit(9)
`)
    chmodSync(executable, 0o755)
    const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), executable)
    Object.defineProperty(service, 'sessionRoot', { value: root })

    await expect(service.followUp(file, 'start normally instead')).resolves.toBe(false)
  })

  it('snapshots runtimes once per list() instead of once per session', async () => {
    const { root, project, service } = setup()
    for (let index = 0; index < 5; index += 1) writeSession(join(root, `snapshot-${index}.jsonl`), project, `snapshot-${index}`)
    const running = await service.requireSessionPath(join(root, 'snapshot-0.jsonl'))
    const get = vi.fn(() => undefined)
    const all = vi.fn(() => [{ sessionFile: running, isStreaming: true }])
    service.bindRuntimeHooks({ get, all, stop: async () => undefined, rename: async () => false })

    const records = await service.list()

    expect(records).toHaveLength(5)
    expect(records.find((record) => record.filePath === running)?.status).toBe('running')
    expect(records.filter((record) => record.status === 'running')).toHaveLength(1)
    expect(all).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
  })

  it('marks a session running and stops its runtime when the agent reports the file via a symlinked root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-sessions-symlink-')); dirs.push(dir)
    const realRoot = join(dir, 'real-sessions'); mkdirSync(realRoot)
    const aliasRoot = join(dir, 'alias-sessions'); symlinkSync(realRoot, aliasRoot)
    const project = join(dir, 'project'); mkdirSync(project)
    const file = join(realRoot, 'runtime.jsonl')
    writeSession(file, project, 'runtime')
    const aliasFile = join(aliasRoot, 'runtime.jsonl')

    const executable = join(dir, 'symlink-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'runtime', sessionFile: ${JSON.stringify(aliasFile)}, isStreaming: true } })
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path)
    try {
      const runtime = await manager.start({ cwd: project })
      expect(runtime.sessionFile).toBe(realpathSync(file))

      const service = new SessionService(new JsonStateStore(join(dir, 'state.json')), null)
      Object.defineProperty(service, 'sessionRoot', { value: realRoot })
      service.bindRuntimeHooks({
        get: (path) => manager.getForSession(path),
        stop: async (path) => { await manager.stopForSession(path) },
        rename: async () => false,
      })

      expect((await service.list())[0]?.status).toBe('running')
      await expect(service.archive(file)).resolves.toBe(true)
      await waitUntil(() => manager.list().length === 0, 8_000)
    } finally {
      await manager.stopAll()
    }
  }, 15_000)

  it('overlays runtime state and preserves archive and rename hook semantics', async () => {
    const { root, project, service } = setup()
    const file = join(root, 'runtime.jsonl')
    writeSession(file, project, 'runtime')
    const safePath = await service.requireSessionPath(file)
    const stop = vi.fn(async () => undefined)
    const rename = vi.fn(async () => true)
    service.bindRuntimeHooks({
      get: (candidate) => candidate === safePath ? { isStreaming: true } : undefined,
      stop,
      rename,
    })

    expect((await service.list())[0]?.status).toBe('running')
    await expect(service.rename(file, '  Renamed session  ')).resolves.toBe(true)
    expect(rename).toHaveBeenCalledWith(safePath, 'Renamed session')
    await expect(service.rename(file, '-invalid')).rejects.toThrow('title contains invalid characters')

    await expect(service.archive(file)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await service.list()).toEqual([])
    expect((await service.list(undefined, true))[0]?.archived).toBe(true)

    await expect(service.archive(file, false)).resolves.toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
    expect((await service.list())[0]?.archived).toBe(false)
  })
})
