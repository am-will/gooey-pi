import type { Stats } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { comparePaths, createSingleFlight, mapLimit } from '../lib/async'
import { resolveExecutable, runProcess, type ExecutableSource } from '../process-utils'
import { isPathWithin, isRecord } from '../validation'
import { applyLiveMetadata, type JsonRecord, type SessionMetadata } from './metadata'

interface SessionFileCandidate {
  name: string
  filePath: string
  fileStat: Stats
  fingerprint: string
  symbolicLink: boolean
  ancestorPaths: readonly string[]
}

interface SessionPathIdentity {
  dev: number
  ino: number
}

interface SessionCatalogSnapshot {
  revision: number
  watchedRoot: string
  root: string
  ancestorIdentitiesByPath: ReadonlyMap<string, SessionPathIdentity>
  candidatesByName: Map<string, SessionFileCandidate>
  candidatesByPath: Map<string, SessionFileCandidate>
  indexByPath: Map<string, number>
  sessions: SessionMetadata[]
}

export type SessionCatalogReconcileResult =
  | { kind: 'reconciled'; paths: string[] }
  | { kind: 'full-scan' }

const LIVE_CATALOG_TTL_MS = 2_000
const LIVE_CATALOG_MIN_SPAWN_INTERVAL_MS = 2_000
const FULL_SCAN = { kind: 'full-scan' } as const

export interface SessionCatalogEntry {
  name: string
  isFile?(): boolean
  isSymbolicLink?(): boolean
}

export interface SessionCatalogIo {
  readDirectory(path: string): Promise<readonly SessionCatalogEntry[]>
  canonicalize(path: string): Promise<string>
  inspect(path: string): Promise<Stats>
  /** `lstat`-equivalent seam used to reject a known regular file that became a symlink. */
  inspectLink?(path: string): Promise<Stats>
}

const nodeSessionCatalogIo: SessionCatalogIo = {
  readDirectory: (path) => readdir(path, { withFileTypes: true }),
  canonicalize: realpath,
  inspect: stat,
  inspectLink: lstat,
}

/** Derives a creation timestamp from a session file name for pre-I/O ordering; `undefined` means no encoded timestamp. */
export type SessionNameTimestamp = (name: string) => number | undefined

function timestampFromSessionName(name: string): number | undefined {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/i.exec(name)
  if (!match) return undefined
  return Number.parseInt(`${match[1]}${match[2]}`, 16)
}

function compareCandidateNames(left: string, right: string, nameTimestamp: SessionNameTimestamp): number {
  const leftTimestamp = nameTimestamp(left)
  const rightTimestamp = nameTimestamp(right)
  if (leftTimestamp !== undefined && rightTimestamp !== undefined && leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp
  }
  if (leftTimestamp !== undefined && rightTimestamp === undefined) return -1
  if (leftTimestamp === undefined && rightTimestamp !== undefined) return 1
  return comparePaths(right, left)
}

function catalogNameKey(name: string): string {
  return sep === '/' ? name : name.split(sep).join('/')
}

function isSafeRelativeName(name: string): boolean {
  if (!name || name.length > 4_096 || name.includes('\0') || isAbsolute(name)) return false
  const segments = name.split('/')
  return segments.every((segment) => segment.length > 0 && segment.length <= 255
    && segment !== '.' && segment !== '..' && !segment.startsWith('.'))
}

function sameIdentity(left: SessionPathIdentity, right: SessionPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function pathIdentity(stat: Stats): SessionPathIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

function sameLeafSnapshot(expected: Stats, current: Stats): boolean {
  return current.isFile()
    && expected.dev === current.dev
    && expected.ino === current.ino
    && expected.size === current.size
    && expected.mtimeMs === current.mtimeMs
    && expected.ctimeMs === current.ctimeMs
    && expected.mode === current.mode
}

function ancestorPathsForName(watchedRoot: string, name: string): string[] {
  const ancestors = [watchedRoot]
  let current = watchedRoot
  for (const segment of name.split('/').slice(0, -1)) {
    current = join(current, segment)
    ancestors.push(current)
  }
  return ancestors
}

export function boundedSessionDiscoveryNames(names: readonly string[], maxSessionFiles: number, nameTimestamp: SessionNameTimestamp = timestampFromSessionName): string[] {
  const budget = Math.max(0, Math.ceil(maxSessionFiles))
  return [...names].sort((left, right) => compareCandidateNames(left, right, nameTimestamp)).slice(0, budget)
}

export class SessionMetadataCatalog {
  private catalogCache: { executable: string; fetchedAt: number; revision: number; sessions: Map<string, JsonRecord> } | null = null
  // Deduplicate only calls to the same executable. A refreshed runtime path
  // must never inherit the previous executable's cache or in-flight request.
  private readonly catalogRequests = createSingleFlight<string, Map<string, JsonRecord>>()
  private catalogRevision = 0
  private lastCatalogSpawn: { executable: string; at: number } | null = null
  private readonly sessionScanRequests = createSingleFlight<string, SessionMetadata[]>()
  private readonly metadataCache = new Map<string, SessionMetadata>()
  private readonly metadataRequests = createSingleFlight<string, SessionMetadata>()
  private readonly canonicalByName = new Map<string, { canonical: string; dev: number; ino: number }>()
  private snapshot: SessionCatalogSnapshot | null = null
  private preparedRevision: number | null = null
  private preparedView: { revision: number; promise: Promise<SessionMetadata[]> } | null = null
  private reconcileTail: Promise<void> = Promise.resolve()
  private pendingReconciles = 0
  private viewCache: {
    snapshot: SessionCatalogSnapshot
    live: ReadonlyMap<string, JsonRecord>
    sessions: SessionMetadata[]
  } | null = null

  constructor(
    private readonly sessionRoot: () => string,
    private readonly primeAgentPath: ExecutableSource,
    private readonly maxSessionFiles: number,
    private readonly readMetadata: (filePath: string, knownStat?: Stats) => Promise<SessionMetadata>,
    private readonly io: SessionCatalogIo = nodeSessionCatalogIo,
    private readonly nameTimestamp: SessionNameTimestamp = timestampFromSessionName,
  ) {}

  /**
   * Marks the catalog content stale without discarding the last snapshot: the
   * `prime-agent list` spawn stays rate limited independently of change events,
   * so append bursts keep serving the previous snapshot instead of respawning.
   */
  invalidateLiveCatalog(): void {
    this.catalogRevision += 1
    this.preparedRevision = null
    this.preparedView = null
  }

  /** Live Prime Agent session records keyed by canonical session file path. */
  liveSessions(): Promise<ReadonlyMap<string, JsonRecord>> {
    return this.liveCatalog()
  }

  async all(): Promise<SessionMetadata[]> {
    await this.waitForReconciliations()
    const revision = this.catalogRevision
    const executable = resolveExecutable(this.primeAgentPath)
    const snapshot = this.snapshot
    if (snapshot?.revision === revision && this.preparedRevision === revision) {
      const prepared = this.preparedView
      if (prepared?.revision === revision) return prepared.promise
      const promise = this.materialize(snapshot, executable).finally(() => {
        if (this.preparedView?.promise !== promise) return
        this.preparedView = null
        if (this.preparedRevision === revision) this.preparedRevision = null
      })
      this.preparedView = { revision, promise }
      return promise
    }
    return this.sessionScanRequests.run(`${revision}\0${executable ?? ''}`, () => this.scan(revision, executable))
  }

  // Reconcile known watcher paths; uncertainty falls back to a full scan.
  reconcileKnownChanges(names: readonly string[]): Promise<SessionCatalogReconcileResult> {
    const normalized = [...new Set(names.map(catalogNameKey))]
    const revision = ++this.catalogRevision
    this.preparedRevision = null
    this.preparedView = null
    this.pendingReconciles += 1
    const operation = this.reconcileTail.then(async () => {
      try {
        return await this.performReconciliation(normalized, revision)
      } catch {
        return FULL_SCAN
      } finally {
        this.pendingReconciles -= 1
      }
    })
    this.reconcileTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async waitForReconciliations(): Promise<void> {
    while (true) {
      const tail = this.reconcileTail
      await tail
      if (tail === this.reconcileTail && this.pendingReconciles === 0) return
    }
  }

  private async performReconciliation(names: readonly string[], revision: number): Promise<SessionCatalogReconcileResult> {
    const baseline = this.snapshot
    if (!names.length || !baseline || baseline.revision !== revision - 1) return FULL_SCAN
    const candidates = names.map((name) => baseline.candidatesByName.get(name))
    if (candidates.some((candidate) => !candidate || candidate.symbolicLink)) {
      for (const [index, candidate] of candidates.entries()) {
        if (!candidate) continue
        this.metadataCache.delete(candidate.fingerprint)
        if (candidate.symbolicLink) this.canonicalByName.delete(names[index])
      }
      return FULL_SCAN
    }
    const knownCandidates = candidates as SessionFileCandidate[]
    if (!await this.ancestorsUnchanged(baseline, knownCandidates)) {
      for (const name of names) this.canonicalByName.delete(name)
      return FULL_SCAN
    }

    for (const candidate of knownCandidates) this.metadataCache.delete(candidate.fingerprint)
    const refreshed = await mapLimit(names, 6, async (name) => {
      const previous = baseline.candidatesByName.get(name)!
      const watchedPath = join(baseline.watchedRoot, name)
      if (!this.io.inspectLink) return null
      let linkStat: Stats
      let fileStat: Stats
      let canonical: string
      try {
        linkStat = await this.io.inspectLink(watchedPath)
        if (!linkStat.isFile() || linkStat.isSymbolicLink()) {
          this.canonicalByName.delete(name)
          return null
        }
        fileStat = await this.io.inspect(watchedPath)
        canonical = await this.io.canonicalize(watchedPath)
      } catch {
        this.canonicalByName.delete(name)
        return null
      }
      if (!fileStat.isFile() || !sameIdentity(linkStat, fileStat) || !sameIdentity(previous.fileStat, fileStat)
        || baseline.candidatesByPath.get(previous.filePath) !== previous
        || canonical !== previous.filePath || !isPathWithin(baseline.root, canonical)) {
        this.canonicalByName.delete(name)
        return null
      }

      const candidate: SessionFileCandidate = {
        name,
        filePath: previous.filePath,
        fileStat,
        fingerprint: `${previous.filePath}\0${fileStat.mtimeMs}\0${fileStat.size}`,
        symbolicLink: false,
        ancestorPaths: previous.ancestorPaths,
      }
      let metadata: SessionMetadata
      try { metadata = await this.readMetadata(candidate.filePath, fileStat) } catch { return null }

      let verifiedLink: Stats
      let verified: Stats
      let verifiedCanonical: string
      try {
        [verifiedLink, verified, verifiedCanonical] = await Promise.all([
          this.io.inspectLink(watchedPath),
          this.io.inspect(watchedPath),
          this.io.canonicalize(watchedPath),
        ])
      } catch {
        this.canonicalByName.delete(name)
        return null
      }
      if (!verifiedLink.isFile() || verifiedLink.isSymbolicLink()
        || !sameIdentity(verifiedLink, verified) || !sameLeafSnapshot(fileStat, verified)
        || verifiedCanonical !== previous.filePath || !isPathWithin(baseline.root, verifiedCanonical)) {
        this.canonicalByName.delete(name)
        return null
      }
      return { name, previous, candidate, metadata: { ...metadata } }
    })
    if (refreshed.length !== names.length) return FULL_SCAN
    if (!await this.ancestorsUnchanged(baseline, knownCandidates)) {
      for (const name of names) this.canonicalByName.delete(name)
      return FULL_SCAN
    }

    const candidatesByName = new Map(baseline.candidatesByName)
    const candidatesByPath = new Map(baseline.candidatesByPath)
    const metadataByPath = new Map(baseline.sessions.map((session) => [session.filePath, session]))
    for (const update of refreshed) {
      if (!baseline.indexByPath.has(update.previous.filePath)) return FULL_SCAN
      candidatesByName.set(update.name, update.candidate)
      candidatesByPath.set(update.candidate.filePath, update.candidate)
      metadataByPath.set(update.candidate.filePath, update.metadata)
      this.canonicalByName.set(update.name, {
        canonical: update.candidate.filePath,
        dev: update.candidate.fileStat.dev,
        ino: update.candidate.fileStat.ino,
      })
      this.metadataCache.set(update.candidate.fingerprint, update.metadata)
    }
    const orderedCandidates = [...candidatesByPath.values()]
      .sort((left, right) => right.fileStat.mtimeMs - left.fileStat.mtimeMs || comparePaths(left.filePath, right.filePath))
    const sessions = orderedCandidates.map((candidate) => metadataByPath.get(candidate.filePath)!)
    const next: SessionCatalogSnapshot = {
      revision,
      watchedRoot: baseline.watchedRoot,
      root: baseline.root,
      ancestorIdentitiesByPath: baseline.ancestorIdentitiesByPath,
      candidatesByName,
      candidatesByPath,
      indexByPath: new Map(sessions.map((session, index) => [session.filePath, index])),
      sessions,
    }
    // Reconciles are serialized. An older result remains a private base for a
    // queued newer result, but only the newest revision is prepared for readers.
    this.snapshot = next
    if (this.catalogRevision === revision) this.preparedRevision = revision
    return { kind: 'reconciled', paths: names.map((name) => candidatesByName.get(name)!.filePath) }
  }

  private async scan(revision: number, executable: string | null): Promise<SessionMetadata[]> {
    let entries: readonly SessionCatalogEntry[]
    let root: string
    let rootStat: Stats
    const watchedRoot = this.sessionRoot()
    try {
      [entries, root, rootStat] = await Promise.all([
        this.io.readDirectory(watchedRoot),
        this.io.canonicalize(watchedRoot),
        this.io.inspect(watchedRoot),
      ])
    } catch { return [] }
    if (!rootStat.isDirectory()) return []

    // Timestamp-encoding names (Prime UUIDv7, OMP ISO prefixes) expose creation
    // order without per-entry I/O. Admit a bounded deterministic set before
    // canonicalization and stat; legacy names fall back to reverse lexical order.
    const entriesByName = new Map<string, { symbolicLink: boolean }>()
    for (const entry of entries) {
      if (!((entry.isFile?.() ?? true) || (entry.isSymbolicLink?.() ?? false))) continue
      const name = catalogNameKey(entry.name)
      if (!name.endsWith('.jsonl') || !isSafeRelativeName(name) || entriesByName.has(name)) continue
      entriesByName.set(name, { symbolicLink: entry.isSymbolicLink?.() === true })
    }
    const names = boundedSessionDiscoveryNames(
      [...entriesByName.keys()],
      this.maxSessionFiles,
      this.nameTimestamp,
    )
    const ancestorPathsByName = new Map(names.map((name) => [name, ancestorPathsForName(watchedRoot, name)]))
    const intermediatePaths = [...new Set([...ancestorPathsByName.values()].flatMap((paths) => paths.slice(1)))]
    const inspectedIntermediates = await mapLimit(intermediatePaths, 32, async (path) => {
      try {
        const pathStat = await this.io.inspect(path)
        return pathStat.isDirectory() ? { path, identity: pathIdentity(pathStat) } : null
      } catch { return null }
    })
    const ancestorIdentitiesByPath = new Map<string, SessionPathIdentity>([
      [watchedRoot, pathIdentity(rootStat)],
      ...inspectedIntermediates.map(({ path, identity }) => [path, identity] as const),
    ])
    const discovered = await mapLimit(names, 32, async (name): Promise<SessionFileCandidate | null> => {
      try {
        // stat() follows symlinks, so an unchanged dev/ino identity lets the
        // cached canonical path stand in for a realpath call per entry.
        const watchedPath = join(watchedRoot, name)
        const ancestorPaths = ancestorPathsByName.get(name)!
        if (ancestorPaths.some((path) => !ancestorIdentitiesByPath.has(path))) return null
        const fileStat = await this.io.inspect(watchedPath)
        if (!fileStat.isFile()) {
          this.canonicalByName.delete(name)
          return null
        }
        const symbolicLink = entriesByName.get(name)?.symbolicLink === true
        const known = symbolicLink ? undefined : this.canonicalByName.get(name)
        const filePath = known && known.dev === fileStat.dev && known.ino === fileStat.ino
          ? known.canonical
          : await this.io.canonicalize(watchedPath)
        this.canonicalByName.set(name, { canonical: filePath, dev: fileStat.dev, ino: fileStat.ino })
        if (!isPathWithin(root, filePath)) {
          this.canonicalByName.delete(name)
          return null
        }
        return {
          name,
          filePath,
          fileStat,
          fingerprint: `${filePath}\0${fileStat.mtimeMs}\0${fileStat.size}`,
          symbolicLink,
          ancestorPaths,
        }
      } catch {
        this.canonicalByName.delete(name)
        return null
      }
    })
    if (this.canonicalByName.size > names.length) {
      const listed = new Set(names)
      for (const name of this.canonicalByName.keys()) {
        if (!listed.has(name)) this.canonicalByName.delete(name)
      }
    }
    const byCanonicalPath = new Map<string, SessionFileCandidate>()
    for (const candidate of discovered.sort((left, right) => comparePaths(left.name, right.name))) {
      if (!byCanonicalPath.has(candidate.filePath)) byCanonicalPath.set(candidate.filePath, candidate)
    }
    const selected = [...byCanonicalPath.values()]
      .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs || comparePaths(a.filePath, b.filePath))
      .slice(0, this.maxSessionFiles)
    if (this.catalogRevision === revision) {
      const activeFingerprints = new Set(selected.map((candidate) => candidate.fingerprint))
      for (const fingerprint of this.metadataCache.keys()) {
        if (!activeFingerprints.has(fingerprint)) this.metadataCache.delete(fingerprint)
      }
    }

    const catalogPromise = this.liveCatalog(executable)
    const metadata = await mapLimit(selected, 6, async (candidate) => {
      try { return { candidate, metadata: await this.cachedMetadata(candidate, revision) } } catch { return null }
    })
    const catalog = await catalogPromise
    const metadataByPath = new Map(metadata.map((entry) => [entry.candidate.filePath, entry.metadata]))
    const successful = selected.filter((candidate) => metadataByPath.has(candidate.filePath))
    const sessions = successful.map((candidate) => metadataByPath.get(candidate.filePath)!)
    const activeAncestorPaths = new Set(successful.flatMap((candidate) => candidate.ancestorPaths))
    const snapshot: SessionCatalogSnapshot = {
      revision,
      watchedRoot,
      root,
      ancestorIdentitiesByPath: new Map([...ancestorIdentitiesByPath].filter(([path]) => activeAncestorPaths.has(path))),
      candidatesByName: new Map(successful.map((candidate) => [candidate.name, candidate])),
      candidatesByPath: new Map(successful.map((candidate) => [candidate.filePath, candidate])),
      indexByPath: new Map(sessions.map((session, index) => [session.filePath, index])),
      sessions,
    }
    if (this.catalogRevision === revision) this.snapshot = snapshot
    return this.materialize(snapshot, executable, catalog)
  }

  private async ancestorsUnchanged(snapshot: SessionCatalogSnapshot, candidates: readonly SessionFileCandidate[]): Promise<boolean> {
    const paths = [...new Set(candidates.flatMap((candidate) => candidate.ancestorPaths))]
    const current = await mapLimit(paths, 8, async (path) => {
      const expected = snapshot.ancestorIdentitiesByPath.get(path)
      if (!expected) return null
      try {
        const pathStat = await this.io.inspect(path)
        return pathStat.isDirectory() && sameIdentity(expected, pathStat) ? path : null
      } catch { return null }
    })
    return current.length === paths.length
  }

  private async materialize(
    snapshot: SessionCatalogSnapshot,
    executable: string | null,
    knownLive?: ReadonlyMap<string, JsonRecord>,
  ): Promise<SessionMetadata[]> {
    const live = knownLive ?? await this.liveCatalog(executable)
    if (!live.size) return snapshot.sessions
    const previous = this.viewCache
    const sessions = snapshot.sessions.map((original) => {
      const overlay = live.get(original.filePath)
      if (!overlay) return original
      const previousIndex = previous?.snapshot.indexByPath.get(original.filePath)
      if (previous && previous.live === live && previousIndex !== undefined
        && previous.snapshot.sessions[previousIndex] === original) return previous.sessions[previousIndex]
      const item = { ...original }
      applyLiveMetadata(item, overlay)
      return item
    })
    this.viewCache = { snapshot, live, sessions }
    return sessions
  }

  private async cachedMetadata(candidate: SessionFileCandidate, revision: number): Promise<SessionMetadata> {
    const cached = this.metadataCache.get(candidate.fingerprint)
    if (cached) return { ...cached }
    const metadata = await this.metadataRequests.run(candidate.fingerprint, async () => {
      const read = await this.readMetadata(candidate.filePath, candidate.fileStat)
      const current = await this.io.inspect(candidate.filePath)
      if (this.catalogRevision === revision
        && current.mtimeMs === candidate.fileStat.mtimeMs && current.size === candidate.fileStat.size) {
        this.metadataCache.set(candidate.fingerprint, read)
      }
      return read
    })
    return { ...metadata }
  }

  private async liveCatalog(executable = resolveExecutable(this.primeAgentPath)): Promise<Map<string, JsonRecord>> {
    const primeAgentPath = executable
    if (!primeAgentPath) return new Map()
    const revision = this.catalogRevision
    const cache = this.catalogCache
    const now = Date.now()
    if (cache && cache.executable === primeAgentPath && cache.revision === revision
      && now - cache.fetchedAt < LIVE_CATALOG_TTL_MS) return cache.sessions
    const inFlight = this.catalogRequests.get(primeAgentPath)
    if (inFlight) return inFlight
    // Invalidation marks content stale; the CLI spawn is throttled on its own
    // clock so change-event bursts reuse the last snapshot.
    if (cache && cache.executable === primeAgentPath && this.lastCatalogSpawn?.executable === primeAgentPath
      && now - this.lastCatalogSpawn.at < LIVE_CATALOG_MIN_SPAWN_INTERVAL_MS) return cache.sessions
    this.lastCatalogSpawn = { executable: primeAgentPath, at: now }
    return this.catalogRequests.run(primeAgentPath, async () => {
      const sessions = new Map<string, JsonRecord>()
      try {
        const result = await runProcess(primeAgentPath, ['list', '--all', '--json'], { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024 })
        if (result.code === 0) {
          const parsed: unknown = JSON.parse(result.stdout)
          if (isRecord(parsed) && Array.isArray(parsed.sessions)
            && parsed.sessions.length <= this.maxSessionFiles * 4) {
            await mapLimit(parsed.sessions, 32, async (raw) => {
              if (!isRecord(raw) || typeof raw.sessionFile !== 'string'
                || raw.sessionFile.length > 4_096 || !isAbsolute(raw.sessionFile)) return null
              try {
                sessions.set(await realpath(raw.sessionFile), raw)
                return true
              } catch { return null }
            })
          }
        }
      } catch { /* JSONL remains authoritative when the live catalog is unavailable. */ }
      if (resolveExecutable(this.primeAgentPath) === primeAgentPath && this.catalogRevision === revision) {
        this.catalogCache = { executable: primeAgentPath, fetchedAt: Date.now(), revision, sessions }
      }
      return sessions
    })
  }
}
