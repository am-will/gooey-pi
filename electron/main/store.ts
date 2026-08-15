import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { INTERFACE_FONT_SCALES, PRIME_THINKING_LEVELS, type AppSettings, type HarnessId, type ProjectRecord, type ScheduleExecution, type AutomationScheduleRecord, type ScheduleRunRecord, type ScheduleTarget, type ScheduleTiming } from '../../src/types/api'
import { isRecord } from './validation'

export interface FolderIdentity {
  dev: string
  ino: string
  /** Stable across filesystem device-number changes caused by a remount. */
  birthtimeNs?: string
}

export interface PersistedProject extends Omit<ProjectRecord, 'sessionCount' | 'gitBranch' | 'inferred'> {
  folderIdentities?: Record<string, FolderIdentity>
}

export interface DesktopState {
  version: 4
  projects: PersistedProject[]
  settings: AppSettings
  archivedSessions: string[]
  dismissedProjectPaths: string[]
  schedules: AutomationScheduleRecord[]
}

export const CURRENT_DESKTOP_STATE_FILENAME = 'prime-work-state-v4.json'
export const LEGACY_DESKTOP_STATE_FILENAME = 'prime-work-state.json'
const CURRENT_DESKTOP_STATE_VERSION = 4 as const
type SupportedDesktopStateVersion = 1 | 2 | 3 | typeof CURRENT_DESKTOP_STATE_VERSION

export class StateCompatibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StateCompatibilityError'
  }
}

export class UnsupportedStateVersionError extends StateCompatibilityError {
  constructor(
    readonly stateVersion: number,
    readonly statePath: string,
  ) {
    super(`Desktop state schema version ${stateVersion} at ${statePath} is newer than supported version ${CURRENT_DESKTOP_STATE_VERSION}. Upgrade GooeyPi to a compatible version; the state file was left unchanged.`)
    this.name = 'UnsupportedStateVersionError'
  }
}

export function defaultSettings(): AppSettings {
  const defaultShell = process.platform === 'win32'
    ? (process.env.ComSpec && isAbsolute(process.env.ComSpec) ? process.env.ComSpec : 'C:\\Windows\\System32\\cmd.exe')
    : (process.env.SHELL?.startsWith('/') ? process.env.SHELL : '/bin/zsh')
  return {
    theme: 'system',
    interfaceFontScale: 110,
    sidebarOpen: true,
    inspectorOpen: true,
    showFileChangesPopup: true,
    terminalOpen: false,
    defaultInspectorTab: 'summary',
    browserHome: 'https://www.google.com/',
    browserAskForDownloads: true,
    terminalShell: defaultShell,
    reduceMotion: false,
    showReasoningSummaries: true,
    showToolCalls: true,
    messageEnterAction: 'queue',
    runtimePaths: { prime: '', omp: '', pi: '' },
    enabledHarnesses: ['omp', 'prime', 'pi'],
    telemetry: false,
    askUserEnabled: false,
    browserEnabled: true,
    computerUseEnabled: false,
    disabledProviders: [],
    disabledModels: [],
    ompDisabledProviders: [],
    ompDisabledModels: [],
    piDisabledProviders: [],
    piDisabledModels: [],
    activeHarness: 'omp',
    ompApprovalMode: 'inherit',
    petEnabled: true,
    petId: 'orb',
    petSize: 75,
    voiceTranscriptionProvider: 'openai-live',
    voiceOpenAiLiveTranscriptionModel: 'gpt-live-transcribe',
    voiceOpenAiTranscriptionModel: 'gpt-4o-transcribe',
    voiceGroqTranscriptionModel: 'whisper-large-v3-turbo',
    voiceDeepgramTranscriptionModel: 'nova-3',
    voiceSelfHostedUrl: '',
    voiceSelfHostedModel: '',
    voiceLocalWhisperExecutable: '',
    voiceLocalWhisperModel: '',
    voiceRealtimeModel: 'gpt-realtime-2.1',
    voiceRealtimeVoice: 'marin',
  }
}

function defaultState(): DesktopState {
  return { version: CURRENT_DESKTOP_STATE_VERSION, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] }
}

/** Versions 1 and 2 predate harness scoping, so only an absent value migrates to Prime. */
function parseHarness(value: unknown, preHarnessState: boolean): HarnessId | null {
  if (value === 'prime' || value === 'omp' || value === 'pi') return value
  return preHarnessState && value === undefined ? 'prime' : null
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function parseProject(value: unknown, preHarnessState: boolean): PersistedProject | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.path !== 'string') return null
  const folders = Array.isArray(value.folders) ? value.folders.filter((item): item is string => typeof item === 'string') : [value.path]
  if (!folders.length || typeof value.primaryFolder !== 'string') return null
  const harness = parseHarness(value.harness, preHarnessState)
  if (!harness) return null
  const now = new Date().toISOString()
  const folderIdentities: Record<string, FolderIdentity> = {}
  if (isRecord(value.folderIdentities)) {
    for (const [path, identity] of Object.entries(value.folderIdentities)) {
      if (isRecord(identity) && typeof identity.dev === 'string' && typeof identity.ino === 'string') {
        folderIdentities[path] = {
          dev: identity.dev,
          ino: identity.ino,
          birthtimeNs: typeof identity.birthtimeNs === 'string' && /^\d{1,40}$/.test(identity.birthtimeNs) ? identity.birthtimeNs : undefined,
        }
      }
    }
  }
  return {
    id: value.id || randomUUID(),
    harness,
    name: value.name,
    path: value.path,
    folders,
    primaryFolder: value.primaryFolder,
    pinned: typeof value.pinned === 'boolean' ? value.pinned : false,
    createdAt: validDate(value.createdAt) ? value.createdAt : now,
    lastOpenedAt: validDate(value.lastOpenedAt) ? value.lastOpenedAt : now,
    folderIdentities: Object.keys(folderIdentities).length ? folderIdentities : undefined,
  }
}

function parseSettings(value: unknown, legacyState = false): AppSettings {
  const defaults = defaultSettings()
  if (!isRecord(value)) return defaults
  const parseRuntimePath = (path: unknown, fallback: string): string => (
    typeof path === 'string' && path.length <= 4_096 && (!path || isAbsolute(path)) ? path : fallback
  )
  const runtimePaths = isRecord(value.runtimePaths)
    ? {
        prime: parseRuntimePath(value.runtimePaths.prime, defaults.runtimePaths.prime),
        omp: parseRuntimePath(value.runtimePaths.omp, defaults.runtimePaths.omp),
        pi: parseRuntimePath(value.runtimePaths.pi, defaults.runtimePaths.pi),
      }
    : defaults.runtimePaths
  const enabledHarnesses = Array.isArray(value.enabledHarnesses)
    ? [...new Set(value.enabledHarnesses.filter((item): item is HarnessId => item === 'prime' || item === 'omp' || item === 'pi'))]
    : defaults.enabledHarnesses
  const usableHarnesses = enabledHarnesses.length ? enabledHarnesses : defaults.enabledHarnesses
  const activeHarness = value.activeHarness === 'prime' || value.activeHarness === 'omp' || value.activeHarness === 'pi'
    ? value.activeHarness as HarnessId
    : legacyState ? 'prime' : defaults.activeHarness
  return {
    theme: value.theme === 'light' || value.theme === 'dark' || value.theme === 'system' ? value.theme : defaults.theme,
    interfaceFontScale: INTERFACE_FONT_SCALES.includes(value.interfaceFontScale as AppSettings['interfaceFontScale'])
      ? value.interfaceFontScale as AppSettings['interfaceFontScale']
      : defaults.interfaceFontScale,
    sidebarOpen: typeof value.sidebarOpen === 'boolean' ? value.sidebarOpen : defaults.sidebarOpen,
    inspectorOpen: typeof value.inspectorOpen === 'boolean' ? value.inspectorOpen : defaults.inspectorOpen,
    showFileChangesPopup: typeof value.showFileChangesPopup === 'boolean' ? value.showFileChangesPopup : defaults.showFileChangesPopup,
    terminalOpen: typeof value.terminalOpen === 'boolean' ? value.terminalOpen : defaults.terminalOpen,
    defaultInspectorTab: value.defaultInspectorTab === 'changes' || value.defaultInspectorTab === 'browser' || value.defaultInspectorTab === 'files' || value.defaultInspectorTab === 'summary' ? value.defaultInspectorTab : defaults.defaultInspectorTab,
    browserHome: typeof value.browserHome === 'string' ? value.browserHome : defaults.browserHome,
    browserAskForDownloads: typeof value.browserAskForDownloads === 'boolean' ? value.browserAskForDownloads : defaults.browserAskForDownloads,
    terminalShell: typeof value.terminalShell === 'string' ? value.terminalShell : defaults.terminalShell,
    reduceMotion: typeof value.reduceMotion === 'boolean' ? value.reduceMotion : defaults.reduceMotion,
    showReasoningSummaries: typeof value.showReasoningSummaries === 'boolean' ? value.showReasoningSummaries : defaults.showReasoningSummaries,
    showToolCalls: typeof value.showToolCalls === 'boolean' ? value.showToolCalls : defaults.showToolCalls,
    messageEnterAction: value.messageEnterAction === 'queue' || value.messageEnterAction === 'steer' ? value.messageEnterAction : defaults.messageEnterAction,
    runtimePaths,
    enabledHarnesses: usableHarnesses,
    telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : defaults.telemetry,
    askUserEnabled: typeof value.askUserEnabled === 'boolean' ? value.askUserEnabled : defaults.askUserEnabled,
    browserEnabled: typeof value.browserEnabled === 'boolean' ? value.browserEnabled : defaults.browserEnabled,
    computerUseEnabled: typeof value.computerUseEnabled === 'boolean' ? value.computerUseEnabled : defaults.computerUseEnabled,
    disabledProviders: Array.isArray(value.disabledProviders)
      ? [...new Set(value.disabledProviders.filter((item): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))].slice(0, 128)
      : defaults.disabledProviders,
    disabledModels: parseDisabledModels(value.disabledModels, defaults.disabledModels),
    ompDisabledProviders: Array.isArray(value.ompDisabledProviders)
      ? [...new Set(value.ompDisabledProviders.filter((item): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))].slice(0, 256)
      : defaults.ompDisabledProviders,
    ompDisabledModels: parseDisabledModels(value.ompDisabledModels, defaults.ompDisabledModels),
    piDisabledProviders: Array.isArray(value.piDisabledProviders)
      ? [...new Set(value.piDisabledProviders.filter((item): item is string => typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item)))].slice(0, 256)
      : defaults.piDisabledProviders,
    piDisabledModels: parseDisabledModels(value.piDisabledModels, defaults.piDisabledModels),
    activeHarness,
    ompApprovalMode: value.ompApprovalMode === 'inherit' || value.ompApprovalMode === 'always-ask' || value.ompApprovalMode === 'write' || value.ompApprovalMode === 'yolo' ? value.ompApprovalMode : defaults.ompApprovalMode,
    petEnabled: typeof value.petEnabled === 'boolean' ? value.petEnabled : defaults.petEnabled,
    petId: boundedString(value.petId, 128) && /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(value.petId) ? value.petId : defaults.petId,
    petSize: Number.isInteger(value.petSize) && (value.petSize as number) >= 50 && (value.petSize as number) <= 125 ? value.petSize as number : defaults.petSize,
    voiceTranscriptionProvider: value.voiceTranscriptionProvider === 'openai-live' || value.voiceTranscriptionProvider === 'openai' || value.voiceTranscriptionProvider === 'groq' || value.voiceTranscriptionProvider === 'deepgram' || value.voiceTranscriptionProvider === 'self-hosted' || value.voiceTranscriptionProvider === 'local-whisper' ? value.voiceTranscriptionProvider : defaults.voiceTranscriptionProvider,
    voiceOpenAiLiveTranscriptionModel: boundedString(value.voiceOpenAiLiveTranscriptionModel, 128) ? value.voiceOpenAiLiveTranscriptionModel : defaults.voiceOpenAiLiveTranscriptionModel,
    voiceOpenAiTranscriptionModel: boundedString(value.voiceOpenAiTranscriptionModel, 128) ? value.voiceOpenAiTranscriptionModel : defaults.voiceOpenAiTranscriptionModel,
    voiceGroqTranscriptionModel: boundedString(value.voiceGroqTranscriptionModel, 128) ? value.voiceGroqTranscriptionModel : defaults.voiceGroqTranscriptionModel,
    voiceDeepgramTranscriptionModel: boundedString(value.voiceDeepgramTranscriptionModel, 128) ? value.voiceDeepgramTranscriptionModel : defaults.voiceDeepgramTranscriptionModel,
    voiceSelfHostedUrl: boundedString(value.voiceSelfHostedUrl, 2_048, true) ? value.voiceSelfHostedUrl : defaults.voiceSelfHostedUrl,
    voiceSelfHostedModel: boundedString(value.voiceSelfHostedModel, 128, true) ? value.voiceSelfHostedModel : defaults.voiceSelfHostedModel,
    voiceLocalWhisperExecutable: boundedString(value.voiceLocalWhisperExecutable, 4096, true) ? value.voiceLocalWhisperExecutable : defaults.voiceLocalWhisperExecutable,
    voiceLocalWhisperModel: boundedString(value.voiceLocalWhisperModel, 4096, true) ? value.voiceLocalWhisperModel : defaults.voiceLocalWhisperModel,
    voiceRealtimeModel: boundedString(value.voiceRealtimeModel, 128) ? value.voiceRealtimeModel : defaults.voiceRealtimeModel,
    voiceRealtimeVoice: boundedString(value.voiceRealtimeVoice, 64) ? value.voiceRealtimeVoice : defaults.voiceRealtimeVoice,
  }
}

function parseDisabledModels(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.filter((item): item is string => (
    typeof item === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9._:/+-]{1,256}$/i.test(item)
  )))].slice(0, 5_000)
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(['auto', ...PRIME_THINKING_LEVELS])
const RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted'])
const SCHEDULE_STATUSES = new Set(['active', 'paused', 'completed', 'blocked'])

function boundedString(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0)
}

function parseScheduleTarget(value: unknown): ScheduleTarget | null {
  if (!isRecord(value) || !boundedString(value.projectId, 256)) return null
  if (value.kind === 'project') return { kind: 'project', projectId: value.projectId }
  if (value.kind === 'session' && boundedString(value.sessionId, 256)) return { kind: 'session', projectId: value.projectId, sessionId: value.sessionId }
  return null
}

function parseScheduleTiming(value: unknown): ScheduleTiming | null {
  if (!isRecord(value)) return null
  if (value.kind === 'once' && validDate(value.at)) return { kind: 'once', at: value.at }
  if (value.kind === 'rrule' && boundedString(value.dtstartLocal, 64) && boundedString(value.timeZone, 128) && boundedString(value.rrule, 2_048)) {
    return { kind: 'rrule', dtstartLocal: value.dtstartLocal, timeZone: value.timeZone, rrule: value.rrule }
  }
  return null
}

function parseScheduleExecution(value: unknown): ScheduleExecution | null {
  if (!isRecord(value) || !boundedString(value.model, 512) || !THINKING_LEVELS.has(String(value.thinking))) return null
  if (value.speed !== 'normal' && value.speed !== 'fast') return null
  return { model: value.model, thinking: value.thinking as ScheduleExecution['thinking'], speed: value.speed }
}

function parseScheduleRun(value: unknown): ScheduleRunRecord | null {
  if (!isRecord(value) || !boundedString(value.id, 256) || !boundedString(value.taskId, 256)) return null
  if (!Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || !RUN_STATUSES.has(String(value.status))) return null
  if ((value.trigger !== 'scheduled' && value.trigger !== 'manual') || !validDate(value.scheduledFor) || !validDate(value.queuedAt)) return null
  const execution = parseScheduleExecution(value.execution)
  if (!execution) return null
  return {
    id: value.id,
    taskId: value.taskId,
    taskRevision: Number(value.taskRevision),
    trigger: value.trigger,
    scheduledFor: value.scheduledFor,
    queuedAt: value.queuedAt,
    startedAt: validDate(value.startedAt) ? value.startedAt : undefined,
    finishedAt: validDate(value.finishedAt) ? value.finishedAt : undefined,
    status: value.status as ScheduleRunRecord['status'],
    execution,
    sessionId: boundedString(value.sessionId, 256) ? value.sessionId : undefined,
    sessionFile: boundedString(value.sessionFile, 4_096) ? value.sessionFile : undefined,
    error: boundedString(value.error, 4_000, true) ? value.error : undefined,
    skippedCount: Number.isSafeInteger(value.skippedCount) && Number(value.skippedCount) > 0 ? Number(value.skippedCount) : undefined,
  }
}

function parseSchedule(value: unknown, preHarnessState: boolean): AutomationScheduleRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !boundedString(value.id, 256)) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !boundedString(value.title, 200) || !boundedString(value.prompt, 1024 * 1024)) return null
  const target = parseScheduleTarget(value.target)
  const timing = parseScheduleTiming(value.timing)
  const execution = parseScheduleExecution(value.execution)
  const harness = parseHarness(value.harness, preHarnessState)
  if (!target || !timing || !execution || !harness || !SCHEDULE_STATUSES.has(String(value.status))) return null
  if ((value.createdBy !== 'user' && value.createdBy !== 'agent') || !validDate(value.createdAt) || !validDate(value.updatedAt)) return null
  const runs = Array.isArray(value.runs) ? value.runs.map(parseScheduleRun).filter((run): run is ScheduleRunRecord => run !== null).slice(-50) : []
  return {
    schemaVersion: 1,
    id: value.id,
    harness,
    revision: Number(value.revision),
    title: value.title,
    prompt: value.prompt,
    target,
    timing,
    execution,
    status: value.status as AutomationScheduleRecord['status'],
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextRunAt: validDate(value.nextRunAt) ? value.nextRunAt : undefined,
    blockedReason: boundedString(value.blockedReason, 4_000, true) ? value.blockedReason : undefined,
    runs,
  }
}

const MAX_ARCHIVED_SESSIONS = 5_000
const MAX_DISMISSED_PROJECT_PATHS = 1_024
const MAX_STATE_FILE_BYTES = 64 * 1024 * 1024

/** Entries append chronologically, so trimming from the front keeps the most recent. */
function capUnboundedCollections(state: DesktopState): void {
  if (state.archivedSessions.length > MAX_ARCHIVED_SESSIONS) state.archivedSessions = state.archivedSessions.slice(-MAX_ARCHIVED_SESSIONS)
  if (state.dismissedProjectPaths.length > MAX_DISMISSED_PROJECT_PATHS) state.dismissedProjectPaths = state.dismissedProjectPaths.slice(-MAX_DISMISSED_PROJECT_PATHS)
}

function parseStateVersion(value: Record<string, unknown>, statePath: string): SupportedDesktopStateVersion {
  if (!Number.isSafeInteger(value.version)) throw new Error('Desktop state is missing a supported integer schema version')
  const version = Number(value.version)
  if (version > CURRENT_DESKTOP_STATE_VERSION) throw new UnsupportedStateVersionError(version, statePath)
  if (version !== 1 && version !== 2 && version !== 3 && version !== CURRENT_DESKTOP_STATE_VERSION) {
    throw new Error(`Desktop state schema version ${version} is not supported`)
  }
  return version
}

function parseState(value: unknown, statePath: string): { sourceVersion: SupportedDesktopStateVersion; state: DesktopState } {
  if (!isRecord(value)) throw new Error('Desktop state is missing a supported integer schema version')
  const version = parseStateVersion(value, statePath)
  const preHarnessProjectState = version === 1 || version === 2
  const preHarnessScheduleState = version === 2
  // Versions 1 and 2 predate harness scoping. Their absent harness fields are
  // the only project records allowed to inherit Prime; schedules first existed
  // in v2, so a v1 schedule is never eligible for legacy authority migration.
  const state: DesktopState = {
    version: CURRENT_DESKTOP_STATE_VERSION,
    projects: Array.isArray(value.projects) ? value.projects.map((project) => parseProject(project, preHarnessProjectState)).filter((item): item is PersistedProject => item !== null) : [],
    settings: parseSettings(value.settings, preHarnessProjectState),
    archivedSessions: Array.isArray(value.archivedSessions) ? value.archivedSessions.filter((item): item is string => typeof item === 'string') : [],
    dismissedProjectPaths: Array.isArray(value.dismissedProjectPaths) ? value.dismissedProjectPaths.filter((item): item is string => typeof item === 'string') : [],
    schedules: version !== 1 && Array.isArray(value.schedules) ? value.schedules.map((schedule) => parseSchedule(schedule, preHarnessScheduleState)).filter((item): item is AutomationScheduleRecord => item !== null).slice(0, 500) : [],
  }
  capUnboundedCollections(state)
  return { sourceVersion: version, state }
}

export interface JsonStateStoreFileHandle {
  writeFile(data: string, options: { encoding: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface JsonStateStoreFileSystem {
  open(path: string, flags: string, mode?: number): Promise<JsonStateStoreFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

const nodeFileSystem: JsonStateStoreFileSystem = {
  open: (path, flags, mode) => open(path, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
}

export class JsonStateStore {
  private state: DesktopState = defaultState()
  private queue: Promise<void> = Promise.resolve()
  private readyPromise: Promise<void> = Promise.resolve()
  private incompatibility: StateCompatibilityError | null = null
  private initializationFailure: Error | null = null
  private closed = false

  constructor(
    private readonly filePath: string,
    private readonly fileSystem: JsonStateStoreFileSystem = nodeFileSystem,
    private readonly legacyFilePath?: string,
  ) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    let sourcePath = filePath
    try {
      let size: number
      try {
        size = statSync(sourcePath).size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !legacyFilePath) throw error
        sourcePath = legacyFilePath
        size = statSync(sourcePath).size
      }
      if (size > MAX_STATE_FILE_BYTES) {
        throw new StateCompatibilityError(`Desktop state file at ${sourcePath} is ${size} bytes, which exceeds the ${MAX_STATE_FILE_BYTES}-byte safe parse limit. It was left unchanged; use the GooeyPi version that created it, or move it aside only after making a backup.`)
      }
      const parsed = parseState(JSON.parse(readFileSync(sourcePath, 'utf8')), sourcePath)
      this.state = parsed.state
      const needsPersist = sourcePath !== filePath || (legacyFilePath !== undefined && parsed.sourceVersion !== CURRENT_DESKTOP_STATE_VERSION)
      if (needsPersist || legacyFilePath !== undefined) {
        this.scheduleInitialization(needsPersist, legacyFilePath !== undefined, 'GooeyPi desktop state migration could not be completed')
      }
    } catch (error) {
      if (error instanceof StateCompatibilityError) {
        this.incompatibility = error
        return
      }
      try {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`GooeyPi desktop state was reset and backed up: ${error instanceof Error ? error.message : String(error)}`)
          renameSync(sourcePath, `${sourcePath}.corrupt-${Date.now()}`)
        }
      } catch { /* The valid in-memory fallback remains usable. */ }
      this.scheduleInitialization(true, legacyFilePath !== undefined, 'GooeyPi desktop state could not be rewritten after the reset')
    }
  }

  async ready(): Promise<void> {
    this.assertCompatible()
    await this.readyPromise
  }

  snapshot(): DesktopState {
    this.assertCompatible()
    return structuredClone(this.state)
  }

  getSettings(): AppSettings {
    this.assertCompatible()
    return structuredClone(this.state.settings)
  }

  getProjects(): PersistedProject[] {
    this.assertCompatible()
    return structuredClone(this.state.projects)
  }

  getArchivedSessions(): string[] {
    this.assertCompatible()
    return [...this.state.archivedSessions]
  }

  async update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
    this.assertCompatible()
    if (this.initializationFailure) throw this.initializationFailure
    if (this.closed) throw new Error('Desktop state store is shutting down')
    const operation = this.queue.then(async () => {
      if (this.initializationFailure) throw this.initializationFailure
      const draft = structuredClone(this.state)
      const result = mutator(draft)
      capUnboundedCollections(draft)
      await this.persist(draft)
      this.state = draft
      return result
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async beginShutdown(): Promise<void> {
    this.closed = true
    await this.queue
  }

  private assertCompatible(): void {
    if (this.incompatibility) throw this.incompatibility
  }

  private scheduleInitialization(persistState: boolean, retireLegacy: boolean, failurePrefix: string): void {
    const initialization = (async () => {
      if (persistState) await this.persist(this.state, true)
      if (retireLegacy) await this.retireLegacyState()
    })()
    this.readyPromise = initialization
    this.queue = initialization.catch((failure: unknown) => {
      this.initializationFailure = failure instanceof Error ? failure : new Error(String(failure))
      console.error(`${failurePrefix}: ${failure instanceof Error ? failure.message : String(failure)}`)
    })
  }

  private async retireLegacyState(): Promise<void> {
    if (!this.legacyFilePath) return
    const backupPath = `${this.legacyFilePath}.migrated-v4-${Date.now()}-${randomUUID()}`
    try {
      await this.fileSystem.rename(this.legacyFilePath, backupPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error(`Legacy desktop state could not be retired before startup: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      await this.syncParentDirectory(this.legacyFilePath, true)
    } catch (error) {
      let rollbackFailure: unknown
      try {
        await this.fileSystem.rename(backupPath, this.legacyFilePath)
        await this.syncParentDirectory(this.legacyFilePath, true)
      } catch (failure) {
        rollbackFailure = failure
      }
      const rollback = rollbackFailure
        ? `; restoring the legacy filename also failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`
        : '; the legacy filename was restored for a safe retry'
      throw new Error(`Legacy desktop state retirement was not durable: ${error instanceof Error ? error.message : String(error)}${rollback}`)
    }
  }

  private async persist(state: DesktopState, requireDirectorySync = false): Promise<void> {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const file = await this.fileSystem.open(temp, 'w', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8' })
        await file.sync()
      } finally {
        await file.close()
      }

      await this.fileSystem.rename(temp, this.filePath)

      await this.syncParentDirectory(this.filePath, requireDirectorySync)
    } finally {
      await this.fileSystem.unlink(temp).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private async syncParentDirectory(path: string, required = false): Promise<void> {
    try {
      const directory = await this.fileSystem.open(dirname(path), 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      if (required) {
        throw new Error(`Desktop state directory could not be synchronized: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Ordinary updates retain the pre-v4 best-effort behavior on filesystems
      // that cannot open or sync directory handles. Authority migration passes
      // `required` and fails readiness instead of claiming false durability.
    }
  }
}

/** Opens the versioned authority file and durably completes any one-way legacy migration. */
export async function openDesktopStateStore(userDataPath: string): Promise<JsonStateStore> {
  const store = new JsonStateStore(
    join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME),
    nodeFileSystem,
    join(userDataPath, LEGACY_DESKTOP_STATE_FILENAME),
  )
  await store.ready()
  return store
}
