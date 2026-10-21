import { randomUUID } from 'node:crypto'
import { SCHEDULE_DEFINITION_STATUSES, SCHEDULE_RUN_STATUSES, HARNESS_IDS, PRIME_THINKING_LEVELS, type AppSettings, type HarnessId, type ProjectRecord, type ProjectScripts, type ScheduleExecution, type AutomationScheduleRecord, type ScheduleRunRecord, type ScheduleTarget, type ScheduleTiming } from '../../../src/types/api'
import { normalizeScheduleRunHistory } from '../schedules/retention'
import { isBoundedString, isOneOf, isRecord } from '../validation'
import { defaultSettings, parseSettings } from './settings-schema'

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
export const CURRENT_DESKTOP_STATE_VERSION = 4 as const
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

export class StateMigrationError extends Error {
  constructor(
    message: string,
    readonly currentStatePath: string,
    readonly legacyStatePath: string,
    readonly backupStatePath?: string,
  ) {
    const backup = backupStatePath ? ` Byte-exact recovery copy: ${backupStatePath}.` : ''
    super(`${message} Startup stopped before state became writable. Retry after checking that the state directory is writable. Current v4 state: ${currentStatePath}. Legacy compatibility state: ${legacyStatePath}.${backup} Do not delete or edit these files without making a separate backup.`)
    this.name = 'StateMigrationError'
  }
}

export function defaultState(): DesktopState {
  return { version: CURRENT_DESKTOP_STATE_VERSION, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] }
}

/** Versions 1 and 2 predate harness scoping, so only an absent value migrates to Prime. */
function parseHarness(value: unknown, preHarnessState: boolean): HarnessId | null {
  if (isOneOf(HARNESS_IDS, value)) return value
  return preHarnessState && value === undefined ? 'prime' : null
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function parseProjectScripts(value: unknown): ProjectScripts | undefined {
  if (!isRecord(value)) return undefined
  const setup = isBoundedString(value.setup, 64 * 1024, true) && !value.setup.includes('\0') ? value.setup : ''
  const run = isBoundedString(value.run, 64 * 1024, true) && !value.run.includes('\0') ? value.run : ''
  const setupLastExitCode = Number.isSafeInteger(value.setupLastExitCode)
    ? Number(value.setupLastExitCode)
    : undefined
  const setupLastRun = setupLastExitCode !== undefined && isBoundedString(value.setupLastRun, 64 * 1024, true) && !value.setupLastRun.includes('\0')
    ? value.setupLastRun
    : undefined
  return { setup, run, setupLastRun, setupLastExitCode }
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
    scripts: parseProjectScripts(value.scripts),
  }
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(['auto', ...PRIME_THINKING_LEVELS])


function parseScheduleTarget(value: unknown): ScheduleTarget | null {
  if (!isRecord(value) || !isBoundedString(value.projectId, 256)) return null
  if (value.kind === 'project') return { kind: 'project', projectId: value.projectId }
  if (value.kind === 'session' && isBoundedString(value.sessionId, 256)) return { kind: 'session', projectId: value.projectId, sessionId: value.sessionId }
  return null
}

function parseScheduleTiming(value: unknown): ScheduleTiming | null {
  if (!isRecord(value)) return null
  if (value.kind === 'once' && validDate(value.at)) return { kind: 'once', at: value.at }
  if (value.kind === 'rrule' && isBoundedString(value.dtstartLocal, 64) && isBoundedString(value.timeZone, 128) && isBoundedString(value.rrule, 2_048)) {
    return { kind: 'rrule', dtstartLocal: value.dtstartLocal, timeZone: value.timeZone, rrule: value.rrule }
  }
  return null
}

function parseScheduleExecution(value: unknown): ScheduleExecution | null {
  if (!isRecord(value) || !isBoundedString(value.model, 512) || !THINKING_LEVELS.has(String(value.thinking))) return null
  if (value.speed !== 'normal' && value.speed !== 'fast') return null
  return { model: value.model, thinking: value.thinking as ScheduleExecution['thinking'], speed: value.speed }
}

function parseScheduleRun(value: unknown): ScheduleRunRecord | null {
  if (!isRecord(value) || !isBoundedString(value.id, 256) || !isBoundedString(value.taskId, 256)) return null
  if (!Number.isSafeInteger(value.taskRevision) || Number(value.taskRevision) < 1 || !isOneOf(SCHEDULE_RUN_STATUSES, value.status)) return null
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
    status: value.status,
    execution,
    sessionId: isBoundedString(value.sessionId, 256) ? value.sessionId : undefined,
    sessionFile: isBoundedString(value.sessionFile, 4_096) ? value.sessionFile : undefined,
    error: isBoundedString(value.error, 4_000, true) ? value.error : undefined,
    skippedCount: Number.isSafeInteger(value.skippedCount) && Number(value.skippedCount) > 0 ? Number(value.skippedCount) : undefined,
  }
}

function parseSchedule(value: unknown, preHarnessState: boolean): AutomationScheduleRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isBoundedString(value.id, 256)) return null
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !isBoundedString(value.title, 200) || !isBoundedString(value.prompt, 1024 * 1024)) return null
  const target = parseScheduleTarget(value.target)
  const timing = parseScheduleTiming(value.timing)
  const execution = parseScheduleExecution(value.execution)
  const harness = parseHarness(value.harness, preHarnessState)
  if (!target || !timing || !execution || !harness || !isOneOf(SCHEDULE_DEFINITION_STATUSES, value.status)) return null
  if ((value.createdBy !== 'user' && value.createdBy !== 'agent') || !validDate(value.createdAt) || !validDate(value.updatedAt)) return null
  const runs = Array.isArray(value.runs) ? value.runs.map(parseScheduleRun).filter((run): run is ScheduleRunRecord => run !== null) : []
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
    status: value.status,
    createdBy: value.createdBy,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    nextRunAt: validDate(value.nextRunAt) ? value.nextRunAt : undefined,
    blockedReason: isBoundedString(value.blockedReason, 4_000, true) ? value.blockedReason : undefined,
    runs,
  }
}

const MAX_ARCHIVED_SESSIONS = 5_000
const MAX_DISMISSED_PROJECT_PATHS = 1_024
export const MAX_SCHEDULED_TASKS = 500
export const MAX_STATE_FILE_BYTES = 64 * 1024 * 1024

/** Normalize every persisted collection against its deterministic retention invariant. */
export function capUnboundedCollections(state: DesktopState): void {
  if (state.archivedSessions.length > MAX_ARCHIVED_SESSIONS) state.archivedSessions = state.archivedSessions.slice(-MAX_ARCHIVED_SESSIONS)
  if (state.dismissedProjectPaths.length > MAX_DISMISSED_PROJECT_PATHS) state.dismissedProjectPaths = state.dismissedProjectPaths.slice(-MAX_DISMISSED_PROJECT_PATHS)
  normalizeScheduleRunHistory(state.schedules)
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

export function parseState(value: unknown, statePath: string): { sourceVersion: SupportedDesktopStateVersion; state: DesktopState } {
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
    schedules: version !== 1 && Array.isArray(value.schedules) ? value.schedules.map((schedule) => parseSchedule(schedule, preHarnessScheduleState)).filter((item): item is AutomationScheduleRecord => item !== null).slice(0, MAX_SCHEDULED_TASKS) : [],
  }
  capUnboundedCollections(state)
  return { sourceVersion: version, state }
}
