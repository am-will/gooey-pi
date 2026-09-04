import { watch, type Dirent, type Stats } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { HarnessId, SessionChangeEvent, SessionRecord, TranscriptMessage } from '../../src/types/api'
import { assertNoMcpAuthenticationCommand } from '../../src/lib/mcp-policy'
import { queueDaemonFollowUp } from './agent-daemon'
import { comparePaths, createAdmissionQueue, createSingleFlight, type AdmissionQueue } from './lib/async'
import { resolveExecutable, runProcess, type ExecutableSource } from './process-utils'
import { SessionMetadataCatalog, type SessionCatalogIo, type SessionNameTimestamp } from './sessions/catalog'
import { createSessionMetadataReader, type SessionMetadata, type SessionMetadataReader } from './sessions/metadata'
import { readTranscript } from './sessions/transcript'
import type { JsonStateStore } from './store'
import { isPathWithin, isRecord, requireBoolean, requireExistingDirectory, requireId, requireString } from './validation'

interface RuntimeSessionState { isStreaming: boolean; isCompacting?: boolean }

interface RuntimeSessionSnapshot extends RuntimeSessionState { sessionFile?: string }

const MAX_SESSION_FILES = 5_000
const MAX_SESSION_WATCH_DIRECTORIES = 512
const MAX_CONCURRENT_TRANSCRIPT_READS = 2
const MAX_PENDING_TRANSCRIPT_READS = 32

type TranscriptReader = (filePath: string, isStreaming: boolean) => Promise<TranscriptMessage[]>

type SessionPathAuthorizer = (sessionRootRealPath: string, sessionRealPath: string) => boolean

export interface SessionWatcher {
  close(): void
  on(event: 'error', listener: (error: Error) => void): SessionWatcher
}

export type SessionWatchFactory = (
  path: string,
  options: { persistent: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => SessionWatcher

const watchSessionDirectory: SessionWatchFactory = (path, options, listener) => watch(
  path,
  options,
  (eventType, filename) => listener(eventType, filename),
)

const authorizePrimeSessionPath: SessionPathAuthorizer = (root, path) => isPathWithin(root, path) && path.endsWith('.jsonl')

export interface SessionServiceOptions {
  /** Harness stamped on every record and change event this service emits; defaults to 'prime'. */
  harness?: HarnessId
  /** Canonical-or-lexical session root; defaults to the Prime Agent session directory. */
  sessionRoot?: string
  catalogIo?: SessionCatalogIo
  /** Pre-I/O discovery ordering for a harness's file-name scheme; defaults to Prime UUIDv7 names. */
  catalogNameTimestamp?: SessionNameTimestamp
  metadataReader?: SessionMetadataReader
  transcriptReader?: TranscriptReader
  /** Containment rule applied to realpathed candidates; defaults to root containment plus a `.jsonl` suffix. */
  isSessionPathAuthorized?: SessionPathAuthorizer
  /**
   * Also watch a bounded set of session directories exactly one level below
   * the root (for harnesses that bucket sessions).
   */
  recursiveWatch?: boolean
  /** Injectable watch seam for deterministic filesystem-event tests. */
  watchDirectory?: SessionWatchFactory
  /**
   * File-level rename fallback for harnesses whose CLI does not expose a
   * `rename` subcommand (OMP, pi). Called when no live runtime is available
   * to accept `set_session_name` and no CLI fallback exists.
   */
  renameFile?: (filePath: string, title: string) => boolean
  maxConcurrentTranscriptReads?: number
  maxPendingTranscriptReads?: number
}

export class SessionService {
  readonly harness: HarnessId
  readonly sessionRoot: string
  private readonly recursiveWatch: boolean
  private runtimeForSession: (filePath: string) => RuntimeSessionState | undefined = () => undefined
  private listRuntimeSessions: (() => readonly RuntimeSessionSnapshot[]) | null = null
  private stopRuntimeForSession: (filePath: string) => Promise<void> = async () => undefined
  private renameRuntimeSession: (filePath: string, title: string) => Promise<boolean> = async () => false
  private readonly catalog: SessionMetadataCatalog
  private readonly metadataReader: SessionMetadataReader
  private readonly transcriptReads = createSingleFlight<string, TranscriptMessage[]>()
  private readonly transcriptAdmission: AdmissionQueue
  private readonly transcriptReader: TranscriptReader
  private readonly isSessionPathAuthorized: SessionPathAuthorizer
  private readonly watchDirectory: SessionWatchFactory
  private readonly renameFile: ((filePath: string, title: string) => boolean) | undefined
  private readonly changeListeners = new Set<(event: SessionChangeEvent) => void>()
  private sessionWatcher: SessionWatcher | null = null
  private readonly bucketWatchers = new Map<string, SessionWatcher>()
  private bucketWatcherRefresh: Promise<void> | null = null
  private bucketWatcherRefreshPending = false
  private watcherRetry: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  private readonly changedNames = new Set<string>()
  private catalogOnlyChange = false
  private followUpsInFlight = 0

  constructor(
    private readonly store: JsonStateStore,
    private readonly primeAgentPath: ExecutableSource,
    maxSessionFiles = MAX_SESSION_FILES,
    options: SessionServiceOptions = {},
  ) {
    const transcriptLimit = options.maxConcurrentTranscriptReads ?? MAX_CONCURRENT_TRANSCRIPT_READS
    const pendingLimit = options.maxPendingTranscriptReads ?? MAX_PENDING_TRANSCRIPT_READS
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 1) throw new RangeError('maxConcurrentTranscriptReads must be a positive integer')
    if (!Number.isInteger(pendingLimit) || pendingLimit < 0) throw new RangeError('maxPendingTranscriptReads must be a non-negative integer')
    this.transcriptAdmission = createAdmissionQueue({
      maxConcurrent: transcriptLimit,
      maxPending: pendingLimit,
      pendingLimitError: () => new Error('Too many transcript reads are pending'),
      closedError: () => new Error('Too many transcript reads are pending'),
    })
    this.harness = options.harness ?? 'prime'
    this.sessionRoot = options.sessionRoot ?? join(homedir(), '.prime', 'agent', 'sessions')
    this.recursiveWatch = options.recursiveWatch === true
    this.metadataReader = options.metadataReader ?? createSessionMetadataReader()
    this.transcriptReader = options.transcriptReader ?? readTranscript
    this.isSessionPathAuthorized = options.isSessionPathAuthorized ?? authorizePrimeSessionPath
    this.watchDirectory = options.watchDirectory ?? watchSessionDirectory
    this.catalog = new SessionMetadataCatalog(
      () => this.sessionRoot,
      primeAgentPath,
      maxSessionFiles,
      (filePath, knownStat) => this.readMetadata(filePath, knownStat),
      options.catalogIo,
      options.catalogNameTimestamp,
    )
    this.renameFile = options.renameFile
  }

  bindRuntimeHooks(hooks: {
    get(filePath: string): RuntimeSessionState | undefined
    all?(): readonly RuntimeSessionSnapshot[]
    stop(filePath: string): Promise<void>
    rename(filePath: string, title: string): Promise<boolean>
  }): void {
    this.runtimeForSession = hooks.get
    this.listRuntimeSessions = hooks.all ?? null
    this.stopRuntimeForSession = hooks.stop
    this.renameRuntimeSession = hooks.rename
  }

  onDidChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.changeListeners.add(listener)
    this.startWatcher()
    return () => {
      this.changeListeners.delete(listener)
      if (!this.changeListeners.size) this.stopWatcher()
    }
  }

  async list(projectPath?: unknown, includeArchivedValue: unknown = false, forceValue: unknown = false): Promise<SessionRecord[]> {
    const includeArchived = requireBoolean(includeArchivedValue, 'includeArchived')
    const force = requireBoolean(forceValue, 'force')
    const requestedProject = projectPath ? requireString(projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
    let project = requestedProject ? resolve(requestedProject) : undefined
    if (requestedProject) {
      try { project = await requireExistingDirectory(requestedProject, 'projectPath') } catch { /* Preserve stale lexical filtering. */ }
    }
    // A caller reconciling a just-created session cannot rely on fs.watch:
    // recursive delivery varies by platform and an event may still be queued.
    // Force advances the scan revision while retaining metadata-level caches.
    if (force) this.catalog.invalidateLiveCatalog()
    const sessions = await this.catalog.all()
    const archived = new Set(this.store.getArchivedSessions().map((path) => resolve(path)))
    // One runtime snapshot per list call; each session then resolves in O(1).
    const runtimeBySession = this.snapshotRuntimeSessions()
    const records: SessionRecord[] = []
    for (const original of sessions) {
      const metadata = { ...original }
      const isArchived = archived.has(resolve(metadata.filePath))
      if ((isArchived && !includeArchived) || (project && resolve(metadata.projectPath) !== project)) continue
      const runtime = runtimeBySession
        ? runtimeBySession.get(resolve(metadata.filePath))
        : this.runtimeForSession(metadata.filePath)
      if (runtime) metadata.status = runtime.isStreaming || runtime.isCompacting ? 'running' : 'idle'
      const { sessionName: _sessionName, ...record } = metadata
      records.push({ ...record, harness: this.harness, archived: isArchived })
    }
    return records.sort((a, b) => Date.parse(b.lastUserMessageAt ?? b.createdAt) - Date.parse(a.lastUserMessageAt ?? a.createdAt) || comparePaths(a.filePath, b.filePath))
  }

  private snapshotRuntimeSessions(): Map<string, RuntimeSessionState> | null {
    if (!this.listRuntimeSessions) return null
    const bySession = new Map<string, RuntimeSessionState>()
    for (const runtime of this.listRuntimeSessions()) {
      if (!runtime.sessionFile) continue
      const key = resolve(runtime.sessionFile)
      if (!bySession.has(key)) bySession.set(key, runtime)
    }
    return bySession
  }

  async projectPaths(): Promise<string[]> {
    const sessions = await this.list()
    return [...new Set(sessions.map((session) => session.projectPath).filter((path) => path.startsWith('/')))]
  }

  async read(filePath: unknown): Promise<TranscriptMessage[]> {
    const requested = requireString(filePath, 'filePath', { min: 1, max: 4096 })
    const safePath = await this.requireSessionPath(requested)
    // Coalesced callers share one immutable result; the IPC boundary clones it
    // for the renderer, so a pre-IPC structuredClone would be a second copy.
    return this.transcriptReads.run(safePath, () => this.transcriptAdmission.run(async () => {
      const runtime = this.runtimeForSession(safePath)
      return this.transcriptReader(safePath, runtime?.isStreaming === true || runtime?.isCompacting === true)
    }))
  }

  async followUp(filePath: unknown, message: unknown, intent: unknown = 'queue'): Promise<boolean> {
    if (intent !== 'queue' && intent !== 'steer') throw new TypeError('Invalid active-session message intent')
    const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
    assertNoMcpAuthenticationCommand(safeMessage, this.harness)
    if (this.followUpsInFlight >= 4) throw new Error('Too many active-session replies are in flight')
    this.followUpsInFlight += 1
    try { return await this.queueActiveFollowUp(filePath, safeMessage, intent) }
    finally { this.followUpsInFlight -= 1 }
  }

  private async queueActiveFollowUp(filePath: unknown, message: unknown, intent: 'queue' | 'steer'): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeMessage = requireString(message, 'message', { min: 1, max: 64 * 1024 })
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    if (!primeAgentPath) throw new Error('Prime Agent executable was not found')

    // The catalog canonicalizes candidate session files with bounded
    // parallelism and caches the result; reuse it instead of re-listing with
    // up to MAX_SESSION_FILES * 4 serial realpath calls.
    const active = (await this.catalog.liveSessions()).get(safePath)
    if (active?.lifecycle !== 'live' || active.isSessionActive !== true) return false
    const activeSessionId = requireId(active.activeSessionId ?? active.id, 'activeSessionId')
    if (activeSessionId.startsWith('-')) throw new Error('Prime Agent returned an invalid active session identifier')

    const status = await runProcess(primeAgentPath, ['status', '--json'], { timeoutMs: 15_000, maxBytes: 1024 * 1024 })
    if (status.code !== 0 || status.timedOut || status.outputExceeded) throw new Error('GooeyPi could not inspect the Prime Agent daemon')
    let statuses: unknown
    try { statuses = JSON.parse(status.stdout) } catch { throw new Error('Prime Agent returned an invalid daemon status') }
    if (!Array.isArray(statuses) || statuses.length > 64) throw new Error('Prime Agent returned an invalid daemon status')
    const current = statuses.find((value) => isRecord(value) && value.status === 'current' && value.isDefault === true)
    if (!isRecord(current) || typeof current.socketPath !== 'string') throw new Error('Prime Agent did not report its active daemon socket')
    await queueDaemonFollowUp(current.socketPath, activeSessionId, safeMessage, intent === 'steer' ? 'steer' : 'follow_up')
    return true
  }

  async rename(filePath: unknown, title: unknown): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const safeTitle = requireString(title, 'title', { min: 1, max: 200, trim: true })
    if (safeTitle.startsWith('-') || /[\r\n]/.test(safeTitle)) throw new TypeError('title contains invalid characters')
    if (await this.renameRuntimeSession(safePath, safeTitle)) return true
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    // OMP/pi services are constructed with a null CLI path (electron/main/index.ts).
    if (!primeAgentPath) return this.renameFile?.(safePath, safeTitle) ?? false
    const metadata = await this.readMetadata(safePath)
    const result = await runProcess(primeAgentPath, ['rename', metadata.id, safeTitle, '--json'], { timeoutMs: 30_000 })
    return result.code === 0
  }

  async archive(filePath: unknown, archivedValue: unknown = true): Promise<boolean> {
    const safePath = await this.requireSessionPath(filePath)
    const archived = requireBoolean(archivedValue, 'archived')
    if (archived) await this.stopRuntimeForSession(safePath)
    await this.store.update((state) => {
      state.archivedSessions = state.archivedSessions.filter((path) => resolve(path) !== resolve(safePath))
      if (archived) state.archivedSessions.push(safePath)
    })
    return true
  }

  async requireSessionPath(value: unknown): Promise<string> {
    const requested = requireString(value, 'filePath', { min: 1, max: 4096 })
    const root = await realpath(this.sessionRoot)
    const path = await realpath(requested)
    if (!this.isSessionPathAuthorized(root, path)) throw new TypeError('Session path is outside the Prime session directory')
    return path
  }

  private startWatcher(): void {
    if (this.sessionWatcher || this.watcherRetry || !this.changeListeners.size) return
    try {
      // A missing session root (harness never used on this machine) throws
      // here and lands in the retry below, which watches once the root appears.
      const watcher = this.watchDirectory(this.sessionRoot, { persistent: false }, (_eventType, filename) => {
        this.queueSessionChange(filename)
        if (this.recursiveWatch) this.refreshBucketWatchers(watcher)
      })
      this.sessionWatcher = watcher
      if (this.recursiveWatch) this.refreshBucketWatchers(watcher)
      watcher.on('error', () => {
        if (this.sessionWatcher !== watcher) return
        watcher.close()
        this.sessionWatcher = null
        this.closeBucketWatchers()
        this.queueSessionChange(null)
        this.scheduleWatcherRetry()
      })
    } catch {
      this.scheduleWatcherRetry()
    }
  }

  private scheduleWatcherRetry(): void {
    if (this.watcherRetry || !this.changeListeners.size) return
    this.watcherRetry = setTimeout(() => {
      this.watcherRetry = null
      this.startWatcher()
    }, 1_000)
    this.watcherRetry.unref()
  }

  private stopWatcher(): void {
    this.sessionWatcher?.close()
    this.sessionWatcher = null
    this.closeBucketWatchers()
    if (this.watcherRetry) clearTimeout(this.watcherRetry)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.watcherRetry = null
    this.changeTimer = null
    this.changedNames.clear()
    this.catalogOnlyChange = false
    this.bucketWatcherRefreshPending = false
  }

  /**
   * Pi and OMP keep JSONL files exactly one bucket below the session root, so
   * watch a bounded set of real child directories and feed their root-relative
   * names through the same containment checks as root events. Using this on
   * every platform keeps behavior identical where recursive `fs.watch` is not
   * implemented (notably Linux).
   */
  private refreshBucketWatchers(rootWatcher: SessionWatcher): void {
    if (this.bucketWatcherRefresh) {
      this.bucketWatcherRefreshPending = true
      return
    }
    this.bucketWatcherRefresh = this.performBucketWatcherRefresh(rootWatcher)
      .finally(() => {
        const refreshAgain = this.bucketWatcherRefreshPending
        this.bucketWatcherRefreshPending = false
        this.bucketWatcherRefresh = null
        const currentWatcher = this.sessionWatcher
        if (refreshAgain && currentWatcher && this.changeListeners.size) this.refreshBucketWatchers(currentWatcher)
      })
  }

  private async performBucketWatcherRefresh(rootWatcher: SessionWatcher): Promise<void> {
    let entries: Dirent<string>[]
    let root: string
    try {
      [entries, root] = await Promise.all([
        readdir(this.sessionRoot, { withFileTypes: true }),
        realpath(this.sessionRoot),
      ])
    } catch { return }
    if (this.sessionWatcher !== rootWatcher || !this.changeListeners.size) return

    const bucketNames = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()
        && entry.name.length > 0 && entry.name.length <= 255 && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_SESSION_WATCH_DIRECTORIES)
    const wanted = new Set(bucketNames)
    for (const [name, watcher] of this.bucketWatchers) {
      if (wanted.has(name)) continue
      watcher.close()
      this.bucketWatchers.delete(name)
    }

    for (const name of bucketNames) {
      if (this.bucketWatchers.has(name)) continue
      try {
        const bucketPath = await realpath(join(root, name))
        if (this.sessionWatcher !== rootWatcher || !this.changeListeners.size) return
        if (!isPathWithin(root, bucketPath) || bucketPath === root) continue
        const watcher = this.watchDirectory(bucketPath, { persistent: false }, (_eventType, filename) => {
          if (this.sessionWatcher !== rootWatcher) return
          const leaf = typeof filename === 'string' ? filename : ''
          this.queueSessionChange(leaf ? join(name, leaf) : null)
        })
        this.bucketWatchers.set(name, watcher)
        watcher.on('error', () => {
          if (this.bucketWatchers.get(name) !== watcher) return
          watcher.close()
          this.bucketWatchers.delete(name)
          this.queueSessionChange(null)
        })
      } catch { /* The root watcher will report replacements and retry discovery. */ }
    }
  }

  private closeBucketWatchers(): void {
    for (const watcher of this.bucketWatchers.values()) watcher.close()
    this.bucketWatchers.clear()
  }

  /**
   * Root-relative watch names this watcher can resolve to one session file:
   * a bare file name, plus exactly one bucket-directory level when watching
   * recursively. Everything else coalesces into a catalog-wide refresh.
   */
  private isWatchedSessionName(name: string): boolean {
    if (!name.endsWith('.jsonl')) return false
    const segments = name.split(sep)
    if (segments.length > (this.recursiveWatch ? 2 : 1)) return false
    return segments.every((segment) => segment.length > 0 && !segment.startsWith('.'))
  }

  private queueSessionChange(filename: string | Buffer | null): void {
    const name = typeof filename === 'string' ? filename : Buffer.isBuffer(filename) ? filename.toString('utf8') : ''
    if (!name || !this.isWatchedSessionName(name)) {
      this.catalogOnlyChange = true
    } else if (this.changedNames.size < 256) {
      this.changedNames.add(name)
    } else {
      this.catalogOnlyChange = true
    }
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = null
        void this.flushSessionChanges()
      }, 120)
      this.changeTimer.unref()
    }
  }

  private async flushSessionChanges(): Promise<void> {
    const names = [...this.changedNames]
    let catalogOnly = this.catalogOnlyChange
    this.changedNames.clear()
    this.catalogOnlyChange = false

    let paths: string[]
    if (!catalogOnly && names.length) {
      const result = await this.catalog.reconcileKnownChanges(names)
      if (result.kind === 'reconciled') {
        paths = result.paths
      } else {
        paths = await this.resolveChangedSessionPaths(names)
        if (paths.length !== names.length) catalogOnly = true
      }
    } else {
      // Missing/invalid names, watcher errors, and admission overflow leave
      // the changed catalog membership unknowable, so retain the full-scan path.
      this.catalog.invalidateLiveCatalog()
      paths = await this.resolveChangedSessionPaths(names)
      if (paths.length !== names.length) catalogOnly = true
    }
    if (!this.changeListeners.size) return
    for (const filePath of paths) this.emitChange({ filePath, harness: this.harness })
    if (catalogOnly) this.emitChange({ harness: this.harness })
  }

  private async resolveChangedSessionPaths(names: readonly string[]): Promise<string[]> {
    return (await Promise.all(names.map(async (name) => {
      try { return await this.requireSessionPath(join(this.sessionRoot, name)) } catch { return null }
    }))).filter((path): path is string => path !== null)
  }

  private emitChange(event: SessionChangeEvent): void {
    for (const listener of this.changeListeners) {
      try { listener(event) } catch { /* A renderer listener cannot break session watching. */ }
    }
  }

  private async readMetadata(filePath: string, knownStat?: Stats): Promise<SessionMetadata> {
    const metadata = await this.metadataReader(filePath, knownStat)
    if (metadata.projectPath) {
      try { metadata.projectPath = await requireExistingDirectory(metadata.projectPath, 'session project path') }
      catch { if (metadata.projectPath.startsWith('/')) metadata.projectPath = resolve(metadata.projectPath) }
    }
    return metadata
  }
}
