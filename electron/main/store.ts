import { LegacyStateMigrator, parseWindowsLegacyTombstone, type WindowsLegacyTombstone } from './store/legacy-migration'
import { DurableStateFile, nodeFileSystem, type JsonStateStoreFileSystem } from './store/durable-file'
export type { JsonStateStoreFileHandle, JsonStateStoreFileSystem } from './store/durable-file'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, CURRENT_DESKTOP_STATE_VERSION, StateCompatibilityError, StateMigrationError, MAX_STATE_FILE_BYTES, defaultState, parseState, capUnboundedCollections, type DesktopState, type PersistedProject } from './store/state-schema'
export { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, StateCompatibilityError, UnsupportedStateVersionError, StateMigrationError, MAX_SCHEDULED_TASKS } from './store/state-schema'
export type { DesktopState, FolderIdentity, PersistedProject } from './store/state-schema'
export { defaultSettings } from './store/settings-schema'
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppSettings, AutomationScheduleRecord } from '../../src/types/api'
import { errorMessage, errorCode } from './validation'

export class JsonStateStore {
  private state: DesktopState = defaultState()
  private queue: Promise<void> = Promise.resolve()
  private readyPromise: Promise<void> = Promise.resolve()
  private incompatibility: StateCompatibilityError | null = null
  private initializationFailure: Error | null = null
  private closed = false
  private readonly durable: DurableStateFile
  private readonly legacy: LegacyStateMigrator

  constructor(
    filePath: string,
    fileSystem: JsonStateStoreFileSystem = nodeFileSystem,
    private readonly legacyFilePath?: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.durable = new DurableStateFile(filePath, fileSystem, platform)
    this.legacy = new LegacyStateMigrator(filePath, legacyFilePath, platform, fileSystem, this.durable,
      () => this.durable.persist(this.state),
      (state) => { this.state = state },
    )
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    let sourcePath = filePath
    let sourceKind: 'current' | 'legacy' = 'current'
    let stateRead = false
    try {
      let size: number
      try {
        size = statSync(sourcePath).size
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        if (!legacyFilePath) {
          this.scheduleFreshInitialization()
          return
        }
        sourcePath = legacyFilePath
        sourceKind = 'legacy'
        try {
          size = statSync(sourcePath).size
        } catch (legacyError) {
          if (errorCode(legacyError) !== 'ENOENT') throw legacyError
          if (this.platform === 'win32') this.scheduleWindowsFreshInitialization()
          else this.scheduleFreshInitialization()
          return
        }
      }
      if (size > MAX_STATE_FILE_BYTES) {
        throw new StateCompatibilityError(`Desktop state file at ${sourcePath} is ${size} bytes, which exceeds the ${MAX_STATE_FILE_BYTES}-byte safe parse limit. It was left unchanged; use the GooeyPi version that created it, or move it aside only after making a backup.`)
      }
      const rawState = readFileSync(sourcePath)
      stateRead = true
      const serializedState: unknown = JSON.parse(rawState.toString('utf8'))
      if (this.platform === 'win32' && sourceKind === 'legacy') {
        const tombstone = parseWindowsLegacyTombstone(serializedState)
        if (tombstone) {
          this.scheduleWindowsTombstoneRecovery(tombstone)
          return
        }
      }
      const parsed = parseState(serializedState, sourcePath)
      this.state = parsed.state
      if (this.platform === 'win32' && legacyFilePath) {
        if (sourceKind === 'legacy') this.scheduleWindowsLegacyMigration(rawState)
        else this.scheduleWindowsLegacyProtection()
        return
      }
      const needsPersist = sourceKind === 'legacy' || (legacyFilePath !== undefined && parsed.sourceVersion !== CURRENT_DESKTOP_STATE_VERSION)
      if (needsPersist || legacyFilePath !== undefined) {
        this.scheduleInitialization(needsPersist, legacyFilePath !== undefined, 'GooeyPi desktop state migration could not be completed')
      }
    } catch (error) {
      if (error instanceof StateCompatibilityError) {
        this.incompatibility = error
        if (legacyFilePath && sourceKind === 'current') {
          if (this.platform === 'win32') {
            this.scheduleInitializationOperation(
              () => this.legacy.ensureWindowsLegacyProtection(false),
              'GooeyPi could not protect incompatible v4 state from a downgraded Windows binary',
            )
          } else {
            this.scheduleInitialization(
              false,
              true,
              'GooeyPi could not protect incompatible v4 state from a downgraded binary',
            )
          }
        }
        return
      }
      if (!stateRead && errorCode(error) !== 'ENOENT') {
        // A stat or read failure is not evidence of corruption, so the file is never quarantined for it.
        this.scheduleInitializationOperation(
          () => Promise.reject(error),
          `GooeyPi could not read desktop state at ${sourcePath}; the file was left unchanged`,
        )
        return
      }
      let recoveryPath: string | undefined
      let preservationFailure: unknown
      try {
        if (errorCode(error) !== 'ENOENT') {
          recoveryPath = `${sourcePath}.corrupt-${Date.now()}`
          renameSync(sourcePath, recoveryPath)
          console.error(`GooeyPi desktop state was reset and backed up to ${recoveryPath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      } catch (failure) {
        preservationFailure = failure
        recoveryPath = undefined
      }
      if (this.platform === 'win32' && legacyFilePath) {
        this.scheduleWindowsRecoveryInitialization(sourceKind, recoveryPath, preservationFailure)
      } else if (preservationFailure) {
        // Never persist defaults over state that could not be backed up first.
        this.scheduleInitializationOperation(
          () => Promise.reject(preservationFailure),
          `GooeyPi could not preserve unreadable desktop state at ${sourcePath} before reset`,
        )
      } else {
        this.scheduleInitialization(true, legacyFilePath !== undefined, 'GooeyPi desktop state could not be rewritten after the reset')
      }
    }
  }

  async ready(): Promise<void> {
    await this.readyPromise
    this.assertCompatible()
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

  getDismissedProjectPaths(): string[] {
    this.assertCompatible()
    return [...this.state.dismissedProjectPaths]
  }

  getSchedules(): AutomationScheduleRecord[] {
    this.assertCompatible()
    return structuredClone(this.state.schedules)
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
      // Detach before persisting: callers never hold live state, and an uncloneable result aborts the write.
      const detached = structuredClone(result)
      await this.durable.persist(draft)
      this.state = draft
      return detached
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
    this.scheduleInitializationOperation(async () => {
      if (persistState) await this.durable.persist(this.state, true)
      if (retireLegacy) await this.legacy.retireLegacyState()
    }, failurePrefix)
  }

  private scheduleFreshInitialization(): void {
    this.scheduleInitializationOperation(
      () => this.durable.persist(this.state),
      'GooeyPi desktop state could not be initialized',
    )
  }

  private scheduleWindowsFreshInitialization(): void {
    this.scheduleInitializationOperation(
      () => this.legacy.initializeWindowsFreshState(),
      'GooeyPi could not establish the Windows v4 compatibility marker',
    )
  }

  private scheduleWindowsLegacyMigration(rawLegacyState: Uint8Array): void {
    this.scheduleInitializationOperation(
      () => this.legacy.migrateWindowsLegacy(rawLegacyState),
      'GooeyPi could not complete the Windows desktop-state migration',
    )
  }

  private scheduleWindowsTombstoneRecovery(tombstone: WindowsLegacyTombstone): void {
    this.scheduleInitializationOperation(
      () => this.legacy.resumeWindowsTombstone(tombstone),
      'GooeyPi could not resume the interrupted Windows desktop-state migration',
    )
  }

  private scheduleWindowsLegacyProtection(): void {
    this.scheduleInitializationOperation(
      () => this.legacy.ensureWindowsLegacyProtection(true),
      'GooeyPi could not protect v4 state from a downgraded Windows binary',
    )
  }

  private scheduleWindowsRecoveryInitialization(
    sourceKind: 'current' | 'legacy',
    recoveryPath: string | undefined,
    preservationFailure: unknown,
  ): void {
    this.scheduleInitializationOperation(async () => {
      if (preservationFailure) {
        throw this.legacy.migrationError(`The unreadable ${sourceKind} state could not be preserved before recovery: ${errorMessage(preservationFailure)}`)
      }
      if (sourceKind === 'current') {
        await this.legacy.recoverWindowsAfterCorruptCurrent(recoveryPath)
        return
      }
      await this.legacy.initializeWindowsFreshState()
    }, 'GooeyPi desktop state could not be safely rewritten after reset')
  }

  private scheduleInitializationOperation(operation: () => Promise<void>, failurePrefix: string): void {
    const initialization = operation().catch((failure: unknown) => {
      if (failure instanceof StateCompatibilityError || failure instanceof StateMigrationError) throw failure
      if (this.legacyFilePath) throw this.legacy.migrationError(`${failurePrefix}: ${errorMessage(failure)}`)
      throw failure
    })
    this.readyPromise = initialization
    this.queue = initialization.catch((failure: unknown) => {
      this.initializationFailure = failure instanceof Error ? failure : new Error(String(failure))
      console.error(`${failurePrefix}: ${failure instanceof Error ? failure.message : String(failure)}`)
    })
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
