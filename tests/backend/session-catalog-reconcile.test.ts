import {
  appendFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBucketedCatalogIo } from '../../electron/main/sessions/bucketed'
import { SessionMetadataCatalog, type SessionCatalogEntry, type SessionCatalogIo } from '../../electron/main/sessions/catalog'
import type { SessionMetadata } from '../../electron/main/sessions/metadata'

const root = '/sessions'
const realDirectories: string[] = []

interface FileState {
  dev: number
  ino: number
  mtimeMs: number
  size: number
  version: number
  canonical?: string
  symbolicLink?: boolean
}

function sessionName(index: number): string {
  return `session-${index.toString().padStart(5, '0')}.jsonl`
}

function metadataFor(filePath: string, version: number): SessionMetadata {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1, -'.jsonl'.length)
  return {
    id: `${name}-v${version}`,
    filePath,
    projectPath: '/project',
    title: `${name} version ${version}`,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: new Date(Date.parse('2025-01-01T00:00:00.000Z') + version * 1_000).toISOString(),
    status: 'idle',
    depth: 0,
    pinned: false,
    unread: false,
  }
}

function fakeStats(state: FileState): Stats {
  return {
    dev: state.dev,
    ino: state.ino,
    mtimeMs: state.mtimeMs,
    size: state.size,
    isFile: () => true,
    isDirectory: () => false,
  } as Stats
}

function fakeDirectoryStats(state: FileState): Stats {
  return {
    ...fakeStats(state),
    isFile: () => false,
    isDirectory: () => true,
  } as Stats
}

function fixture(count: number, maxSessionFiles = count) {
  const files = new Map<string, FileState>()
  const rootState: FileState = { dev: 1, ino: 1_000_000, mtimeMs: 1, size: 0, version: 0 }
  for (let index = 0; index < count; index += 1) {
    files.set(sessionName(index), {
      dev: 1,
      ino: index + 1,
      mtimeMs: index + 1,
      size: 100,
      version: 0,
    })
  }
  const entries = vi.fn(async (): Promise<readonly SessionCatalogEntry[]> => [...files].map(([name, state]) => ({
    name,
    isFile: () => true,
    isSymbolicLink: () => state.symbolicLink === true,
  })))
  const canonicalize = vi.fn(async (path: string) => {
    if (path === root) return root
    const name = path.slice(path.lastIndexOf('/') + 1)
    const state = files.get(name)
    if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return state.canonical ?? path
  })
  const inspect = vi.fn(async (path: string) => {
    if (path === root) return fakeDirectoryStats(rootState)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const state = files.get(name)
    if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return fakeStats(state)
  })
  const inspectLink = vi.fn(async (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const state = files.get(name)
    if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return {
      ...fakeStats(state),
      isFile: () => state.symbolicLink !== true,
      isSymbolicLink: () => state.symbolicLink === true,
    } as Stats
  })
  const readMetadata = vi.fn(async (filePath: string) => {
    const name = filePath.slice(filePath.lastIndexOf('/') + 1)
    const state = files.get(name)
    if (!state) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return metadataFor(filePath, state.version)
  })
  const io: SessionCatalogIo = { readDirectory: entries, canonicalize, inspect, inspectLink }
  const catalog = new SessionMetadataCatalog(() => root, null, maxSessionFiles, readMetadata, io)
  return { catalog, files, entries, canonicalize, inspect, inspectLink, readMetadata }
}

function byPath(records: readonly SessionMetadata[]): Map<string, SessionMetadata> {
  return new Map(records.map((record) => [record.filePath, record]))
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of realDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('SessionMetadataCatalog known-file reconciliation', () => {
  it('updates one known file in a 5,000-file snapshot with no enumeration and constant candidate inspection', async () => {
    const { catalog, files, entries, canonicalize, inspect, inspectLink, readMetadata } = fixture(5_000)
    const changedName = sessionName(2_500)
    const unchangedName = sessionName(1_000)
    const initial = await catalog.all()
    const initialByPath = byPath(initial)

    expect(entries).toHaveBeenCalledOnce()
    expect(canonicalize).toHaveBeenCalledTimes(5_001)
    expect(inspect).toHaveBeenCalledTimes(10_001)
    expect(readMetadata).toHaveBeenCalledTimes(5_000)

    const changed = files.get(changedName)!
    Object.assign(changed, { mtimeMs: 10_000, size: 150, version: 1 })
    await expect(catalog.reconcileKnownChanges([changedName])).resolves.toEqual({
      kind: 'reconciled',
      paths: [`${root}/${changedName}`],
    })
    const refreshed = await catalog.all()
    const refreshedByPath = byPath(refreshed)

    expect(entries).toHaveBeenCalledOnce()
    expect(canonicalize).toHaveBeenCalledTimes(5_003)
    expect(inspect).toHaveBeenCalledTimes(10_005)
    expect(inspectLink).toHaveBeenCalledTimes(2)
    expect(readMetadata).toHaveBeenCalledTimes(5_001)
    expect(refreshedByPath.get(`${root}/${changedName}`)?.id).toBe('session-02500-v1')
    expect(refreshedByPath.get(`${root}/${changedName}`)).not.toBe(initialByPath.get(`${root}/${changedName}`))
    expect(refreshedByPath.get(`${root}/${unchangedName}`)).toBe(initialByPath.get(`${root}/${unchangedName}`))
  })

  it('reconciles multiple known files in one batch and preserves every untouched metadata identity', async () => {
    const { catalog, files, entries, inspect } = fixture(4)
    const initial = await catalog.all()
    const initialByPath = byPath(initial)
    for (const index of [1, 3]) Object.assign(files.get(sessionName(index))!, {
      mtimeMs: 100 + index,
      size: 200 + index,
      version: 1,
    })

    const beforeInspect = inspect.mock.calls.length
    await expect(catalog.reconcileKnownChanges([sessionName(1), sessionName(3), sessionName(1)])).resolves.toMatchObject({
      kind: 'reconciled',
      paths: [`${root}/${sessionName(1)}`, `${root}/${sessionName(3)}`],
    })
    const refreshed = byPath(await catalog.all())

    expect(entries).toHaveBeenCalledOnce()
    // Two leaf checks per changed file plus one root-identity check before and
    // after the batch: constant in catalog size and deduplicated across files.
    expect(inspect.mock.calls.length - beforeInspect).toBe(6)
    expect(refreshed.get(`${root}/${sessionName(1)}`)?.id).toBe('session-00001-v1')
    expect(refreshed.get(`${root}/${sessionName(3)}`)?.id).toBe('session-00003-v1')
    expect(refreshed.get(`${root}/${sessionName(0)}`)).toBe(initialByPath.get(`${root}/${sessionName(0)}`))
    expect(refreshed.get(`${root}/${sessionName(2)}`)).toBe(initialByPath.get(`${root}/${sessionName(2)}`))
  })

  it('falls back to a full scan for absent baselines, admission changes, deletion, and identity changes', async () => {
    const absent = fixture(1)
    await expect(absent.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await absent.catalog.all()
    expect(absent.entries).toHaveBeenCalledOnce()

    const admission = fixture(1, 1)
    expect((await admission.catalog.all())[0]?.id).toBe('session-00000-v0')
    admission.files.set(sessionName(1), { dev: 1, ino: 2, mtimeMs: 2, size: 100, version: 0 })
    await expect(admission.catalog.reconcileKnownChanges([sessionName(1)])).resolves.toEqual({ kind: 'full-scan' })
    expect((await admission.catalog.all())[0]?.id).toBe('session-00001-v0')
    expect(admission.entries).toHaveBeenCalledTimes(2)

    const deletion = fixture(2)
    await deletion.catalog.all()
    deletion.files.delete(sessionName(0))
    await expect(deletion.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    expect((await deletion.catalog.all()).map(({ id }) => id)).not.toContain('session-00000-v0')
    expect(deletion.entries).toHaveBeenCalledTimes(2)

    const identity = fixture(1)
    await identity.catalog.all()
    Object.assign(identity.files.get(sessionName(0))!, { ino: 99, mtimeMs: 2, size: 101, version: 1 })
    await expect(identity.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    expect((await identity.catalog.all())[0]?.id).toBe('session-00000-v1')
    expect(identity.entries).toHaveBeenCalledTimes(2)
  })

  it('fully rescans invalid names, renames, and explicit invalidation after a prepared reconcile', async () => {
    const invalid = fixture(1)
    await invalid.catalog.all()
    await expect(invalid.catalog.reconcileKnownChanges(['../escape.jsonl'])).resolves.toEqual({ kind: 'full-scan' })
    await invalid.catalog.all()
    expect(invalid.entries).toHaveBeenCalledTimes(2)

    const renamed = fixture(1)
    await renamed.catalog.all()
    const previousName = sessionName(0)
    const replacementName = sessionName(1)
    renamed.files.delete(previousName)
    renamed.files.set(replacementName, { dev: 1, ino: 2, mtimeMs: 2, size: 100, version: 0 })
    await expect(renamed.catalog.reconcileKnownChanges([previousName, replacementName])).resolves.toEqual({ kind: 'full-scan' })
    expect((await renamed.catalog.all()).map(({ id }) => id)).toEqual(['session-00001-v0'])
    expect(renamed.entries).toHaveBeenCalledTimes(2)

    const forced = fixture(1)
    await forced.catalog.all()
    Object.assign(forced.files.get(sessionName(0))!, { mtimeMs: 2, size: 110, version: 1 })
    await expect(forced.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toMatchObject({ kind: 'reconciled' })
    forced.catalog.invalidateLiveCatalog()
    await forced.catalog.all()
    expect(forced.entries).toHaveBeenCalledTimes(2)
  })

  it('fully rescans symlinks and excludes a changed identity that escapes containment', async () => {
    const symlink = fixture(1)
    symlink.files.get(sessionName(0))!.symbolicLink = true
    await symlink.catalog.all()
    await expect(symlink.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await symlink.catalog.all()
    expect(symlink.entries).toHaveBeenCalledTimes(2)

    const escaped = fixture(1)
    await escaped.catalog.all()
    Object.assign(escaped.files.get(sessionName(0))!, {
      ino: 42,
      mtimeMs: 2,
      size: 101,
      version: 1,
      canonical: '/outside/session.jsonl',
    })
    await expect(escaped.catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await expect(escaped.catalog.all()).resolves.toEqual([])
    expect(escaped.entries).toHaveBeenCalledTimes(2)
  })

  it('falls back when canonical containment changes despite an unchanged file identity', async () => {
    const { catalog, files, entries } = fixture(1)
    await catalog.all()
    Object.assign(files.get(sessionName(0))!, {
      mtimeMs: 2,
      size: 101,
      version: 1,
      canonical: '/outside/session.jsonl',
    })

    await expect(catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await expect(catalog.all()).resolves.toEqual([])

    expect(entries).toHaveBeenCalledTimes(2)
  })

  it('falls back when the watched root alias changes its canonical target', async () => {
    const name = sessionName(0)
    let moved = false
    const fileState: FileState = { dev: 1, ino: 1, mtimeMs: 1, size: 100, version: 0 }
    const entries = vi.fn(async (): Promise<readonly SessionCatalogEntry[]> => [{ name, isFile: () => true }])
    const canonicalize = vi.fn(async (path: string) => {
      if (path === '/watch') return moved ? '/outside' : root
      if (path === `/watch/${name}`) return moved ? `/outside/${name}` : `${root}/${name}`
      return path
    })
    const io: SessionCatalogIo = {
      readDirectory: entries,
      canonicalize,
      inspect: async (path) => path === '/watch'
        ? fakeDirectoryStats({ dev: 1, ino: 2, mtimeMs: 1, size: 0, version: 0 })
        : fakeStats(fileState),
      inspectLink: async () => ({ ...fakeStats(fileState), isSymbolicLink: () => false } as Stats),
    }
    const catalog = new SessionMetadataCatalog(
      () => '/watch',
      null,
      1,
      async (filePath) => metadataFor(filePath, 0),
      io,
    )
    await catalog.all()
    moved = true

    await expect(catalog.reconcileKnownChanges([name])).resolves.toEqual({ kind: 'full-scan' })
    await catalog.all()

    expect(entries).toHaveBeenCalledTimes(2)
  })

  it('falls back when a previously regular watched file becomes a symlink without changing target identity', async () => {
    const { catalog, files, entries } = fixture(1)
    await catalog.all()
    files.get(sessionName(0))!.symbolicLink = true

    await expect(catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await catalog.all()

    expect(entries).toHaveBeenCalledTimes(2)
  })

  it('discards metadata when a regular file becomes a same-target symlink during reconciliation', async () => {
    const { catalog, files, entries, readMetadata } = fixture(1)
    await catalog.all()
    const state = files.get(sessionName(0))!
    Object.assign(state, { mtimeMs: 2, size: 110, version: 1 })
    readMetadata.mockImplementationOnce(async (filePath: string) => {
      state.symbolicLink = true
      return metadataFor(filePath, state.version)
    })

    await expect(catalog.reconcileKnownChanges([sessionName(0)])).resolves.toEqual({ kind: 'full-scan' })
    await catalog.all()

    expect(entries).toHaveBeenCalledTimes(2)
  })

  it('fully rescans when the watched root is replaced and the original leaf is hard-linked back', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gooeypi-session-root-identity-'))
    realDirectories.push(parent)
    const watchedRoot = join(parent, 'sessions')
    const displacedRoot = join(parent, 'sessions-displaced')
    const name = 'known.jsonl'
    const originalFile = join(watchedRoot, name)
    mkdirSync(watchedRoot)
    writeFileSync(originalFile, '0')

    const readDirectory = vi.fn(async (path: string): Promise<readonly SessionCatalogEntry[]> => readdirSync(path, { withFileTypes: true }))
    const io: SessionCatalogIo = {
      readDirectory,
      canonicalize: async (path) => realpathSync(path),
      inspect: async (path) => statSync(path),
      inspectLink: async (path) => lstatSync(path),
    }
    const catalog = new SessionMetadataCatalog(
      () => watchedRoot,
      null,
      1,
      async (filePath) => metadataFor(filePath, readFileSync(filePath, 'utf8').length),
      io,
    )
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'known-v1' }])

    appendFileSync(originalFile, '-changed')
    renameSync(watchedRoot, displacedRoot)
    mkdirSync(watchedRoot)
    const displacedFile = join(displacedRoot, name)
    const replacementFile = join(watchedRoot, name)
    linkSync(displacedFile, replacementFile)
    expect({ dev: statSync(replacementFile).dev, ino: statSync(replacementFile).ino }).toEqual({
      dev: statSync(displacedFile).dev,
      ino: statSync(displacedFile).ino,
    })

    await expect(catalog.reconcileKnownChanges([name])).resolves.toEqual({ kind: 'full-scan' })
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'known-v9' }])
    expect(readDirectory).toHaveBeenCalledTimes(2)
  })

  it('does not publish staged metadata when a bucket is replaced with a hard link during the read', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'gooeypi-session-bucket-identity-'))
    realDirectories.push(parent)
    const watchedRoot = join(parent, 'sessions')
    const bucket = join(watchedRoot, 'project-bucket')
    const displacedBucket = join(parent, 'project-bucket-displaced')
    const fileName = 'known.jsonl'
    const originalFile = join(bucket, fileName)
    mkdirSync(bucket, { recursive: true })
    writeFileSync(originalFile, '0')

    const bucketedIo = createBucketedCatalogIo()
    const readDirectory = vi.fn((path: string) => bucketedIo.readDirectory(path))
    const io: SessionCatalogIo = { ...bucketedIo, readDirectory }
    const readStarted = deferred<void>()
    const releaseRead = deferred<void>()
    let reads = 0
    const readMetadata = vi.fn(async (filePath: string) => {
      reads += 1
      if (reads === 1) return { ...metadataFor(filePath, 0), id: 'baseline' }
      if (reads === 2) {
        readStarted.resolve()
        await releaseRead.promise
        return { ...metadataFor(filePath, 1), id: 'staged-stale' }
      }
      return { ...metadataFor(filePath, 2), id: 'rescanned-fresh' }
    })
    const catalog = new SessionMetadataCatalog(() => watchedRoot, null, 1, readMetadata, io)
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'baseline' }])

    appendFileSync(originalFile, '-changed')
    const reconciliation = catalog.reconcileKnownChanges([`project-bucket/${fileName}`])
    await readStarted.promise
    renameSync(bucket, displacedBucket)
    mkdirSync(bucket)
    const displacedFile = join(displacedBucket, fileName)
    const replacementFile = join(bucket, fileName)
    linkSync(displacedFile, replacementFile)
    expect({ dev: statSync(replacementFile).dev, ino: statSync(replacementFile).ino }).toEqual({
      dev: statSync(displacedFile).dev,
      ino: statSync(displacedFile).ino,
    })
    releaseRead.resolve()

    await expect(reconciliation).resolves.toEqual({ kind: 'full-scan' })
    const current = await catalog.all()
    expect(current).toMatchObject([{ id: 'rescanned-fresh' }])
    expect(current.map(({ id }) => id)).not.toContain('staged-stale')
    expect(readDirectory).toHaveBeenCalledTimes(2)
    expect(readMetadata).toHaveBeenCalledTimes(3)
  })

  it('does not publish a truncated real-file read when the transcript is appended during reconciliation', async () => {
    const watchedRoot = mkdtempSync(join(tmpdir(), 'gooeypi-session-append-during-read-'))
    realDirectories.push(watchedRoot)
    const name = 'known.jsonl'
    const filePath = join(watchedRoot, name)
    writeFileSync(filePath, 'baseline')

    const readDirectory = vi.fn(async (path: string): Promise<readonly SessionCatalogEntry[]> => readdirSync(path, { withFileTypes: true }))
    const io: SessionCatalogIo = {
      readDirectory,
      canonicalize: async (path) => realpathSync(path),
      inspect: async (path) => statSync(path),
      inspectLink: async (path) => lstatSync(path),
    }
    const readStarted = deferred<void>()
    const releaseRead = deferred<void>()
    let reads = 0
    const readMetadata = vi.fn(async (path: string) => {
      reads += 1
      const capturedLength = readFileSync(path, 'utf8').length
      if (reads === 2) {
        readStarted.resolve()
        await releaseRead.promise
      }
      return { ...metadataFor(path, capturedLength), id: `content-v${capturedLength}` }
    })
    const catalog = new SessionMetadataCatalog(() => watchedRoot, null, 1, readMetadata, io)
    await expect(catalog.all()).resolves.toMatchObject([{ id: 'content-v8' }])

    appendFileSync(filePath, '-changed')
    const reconciliation = catalog.reconcileKnownChanges([name])
    await readStarted.promise
    appendFileSync(filePath, '-after-read')
    releaseRead.resolve()

    await expect(reconciliation).resolves.toEqual({ kind: 'full-scan' })
    const current = await catalog.all()
    expect(current).toMatchObject([{ id: 'content-v27' }])
    expect(current.map(({ id }) => id)).not.toContain('content-v16')
    expect(readDirectory).toHaveBeenCalledTimes(2)
    expect(readMetadata).toHaveBeenCalledTimes(3)
  })

  it('retains full-scan ordering semantics when a known candidate mtime changes', async () => {
    const { catalog, files, entries } = fixture(2)
    expect((await catalog.all()).map(({ id }) => id)).toEqual([
      'session-00001-v0',
      'session-00000-v0',
    ])
    Object.assign(files.get(sessionName(0))!, { mtimeMs: 10, size: 120, version: 1 })

    await expect(catalog.reconcileKnownChanges([sessionName(0)])).resolves.toMatchObject({ kind: 'reconciled' })
    expect((await catalog.all()).map(({ id }) => id)).toEqual([
      'session-00000-v1',
      'session-00001-v0',
    ])
    expect(entries).toHaveBeenCalledOnce()
  })

  it('serializes overlapping reconciles and falls back before an older read can publish', async () => {
    const { catalog, files, entries } = fixture(1)
    const readerHarness = catalog as unknown as {
      readMetadata: (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>
    }
    await catalog.all()
    const originalReader = readerHarness.readMetadata
    const gates: Array<ReturnType<typeof deferred<void>>> = []
    const started: number[] = []
    readerHarness.readMetadata = async (filePath, knownStat) => {
      const version = files.get(sessionName(0))!.version
      if (version === 0) return originalReader(filePath, knownStat)
      const gate = deferred<void>()
      gates.push(gate)
      started.push(version)
      await gate.promise
      return metadataFor(filePath, version)
    }

    Object.assign(files.get(sessionName(0))!, { mtimeMs: 2, size: 101, version: 1 })
    const first = catalog.reconcileKnownChanges([sessionName(0)])
    await vi.waitFor(() => expect(started).toEqual([1]))

    Object.assign(files.get(sessionName(0))!, { mtimeMs: 3, size: 102, version: 2 })
    const second = catalog.reconcileKnownChanges([sessionName(0)])
    const current = catalog.all()
    expect(started).toEqual([1])

    gates[0]!.resolve()
    await vi.waitFor(() => expect(started).toEqual([1, 2]))
    gates[1]!.resolve()

    await expect(first).resolves.toEqual({ kind: 'full-scan' })
    await expect(second).resolves.toEqual({ kind: 'full-scan' })
    await expect(current).resolves.toMatchObject([{ id: 'session-00000-v2' }])
    expect(entries).toHaveBeenCalledTimes(2)
  })
})
