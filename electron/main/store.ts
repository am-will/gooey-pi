import { DurableStateFile, nodeFileSystem, type JsonStateStoreFileSystem } from './store/durable-file'
export type { JsonStateStoreFileHandle, JsonStateStoreFileSystem } from './store/durable-file'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, CURRENT_DESKTOP_STATE_VERSION, StateCompatibilityError, StateMigrationError, MAX_STATE_FILE_BYTES, defaultState, parseState, capUnboundedCollections, type DesktopState, type PersistedProject } from './store/state-schema'
export { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, StateCompatibilityError, UnsupportedStateVersionError, StateMigrationError, MAX_SCHEDULED_TASKS } from './store/state-schema'
export type { DesktopState, FolderIdentity, PersistedProject } from './store/state-schema'
export { defaultSettings } from './store/settings-schema'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { AppSettings, AutomationScheduleRecord } from '../../src/types/api'
import { renameWithWindowsRetry } from './lib/durable-write'
import { errorMessage, errorCode, isRecord } from './validation'

type WindowsLegacyTombstoneReason = 'fresh' | 'migration' | 'quarantine'

interface WindowsLegacyTombstone {
  schemaVersion: 1
  status: 'pending' | 'complete'
  currentStateFile: typeof CURRENT_DESKTOP_STATE_FILENAME
  backupFile: string | null
  reason: WindowsLegacyTombstoneReason
}

const WINDOWS_LEGACY_TOMBSTONE_KEY = 'gooeyPiV4Migration'

function parseWindowsLegacyTombstone(value: unknown): WindowsLegacyTombstone | null {
  if (!isRecord(value) || value.version !== 3) return null
  if (!Array.isArray(value.projects) || value.projects.length !== 0 || !Array.isArray(value.schedules) || value.schedules.length !== 0) return null
  const marker = value[WINDOWS_LEGACY_TOMBSTONE_KEY]
  if (!isRecord(marker) || marker.schemaVersion !== 1 || marker.currentStateFile !== CURRENT_DESKTOP_STATE_FILENAME) return null
  if (marker.status !== 'pending' && marker.status !== 'complete') return null
  if (marker.reason !== 'fresh' && marker.reason !== 'migration' && marker.reason !== 'quarantine') return null
  const backupFile = marker.backupFile
  if (backupFile !== null && (typeof backupFile !== 'string' || basename(backupFile) !== backupFile || !backupFile.startsWith(`${LEGACY_DESKTOP_STATE_FILENAME}.migrated-v4-`) || backupFile.length > 512)) return null
  if (marker.reason === 'fresh' && backupFile !== null) return null
  if (marker.reason === 'migration' && backupFile === null) return null
  if (marker.reason === 'quarantine' && (marker.status !== 'complete' || backupFile === null)) return null
  return {
    schemaVersion: 1,
    status: marker.status,
    currentStateFile: CURRENT_DESKTOP_STATE_FILENAME,
    backupFile,
    reason: marker.reason,
  }
}


export class JsonStateStore {
  private state: DesktopState = defaultState()
  private queue: Promise<void> = Promise.resolve()
  private readyPromise: Promise<void> = Promise.resolve()
  private incompatibility: StateCompatibilityError | null = null
  private initializationFailure: Error | null = null
  private closed = false
  private readonly durable: DurableStateFile

  constructor(
    private readonly filePath: string,
    private readonly fileSystem: JsonStateStoreFileSystem = nodeFileSystem,
    private readonly legacyFilePath?: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.durable = new DurableStateFile(filePath, fileSystem, platform)
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
          if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError
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
              () => this.ensureWindowsLegacyProtection(false),
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
      if (retireLegacy) await this.retireLegacyState()
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
      () => this.initializeWindowsFreshState(),
      'GooeyPi could not establish the Windows v4 compatibility marker',
    )
  }

  private async initializeWindowsFreshState(): Promise<void> {
    const pending = this.windowsLegacyTombstone('pending', null, 'fresh')
    await this.publishWindowsLegacyTombstone(pending)
    await this.durable.persist(this.state)
    await this.publishWindowsLegacyTombstone({ ...pending, status: 'complete' })
  }

  private scheduleWindowsLegacyMigration(rawLegacyState: Uint8Array): void {
    const backupPath = this.nextLegacyBackupPath()
    const pending = this.windowsLegacyTombstone('pending', basename(backupPath), 'migration')
    this.scheduleInitializationOperation(async () => {
      try {
        await this.durable.writeDurableFile(backupPath, rawLegacyState, 'wx')
        await this.publishWindowsLegacyTombstone(pending)
        await this.durable.persist(this.state)
        await this.publishWindowsLegacyTombstone({ ...pending, status: 'complete' })
      } catch (error) {
        if (error instanceof StateCompatibilityError || error instanceof StateMigrationError) throw error
        throw this.migrationError(`The Windows desktop-state migration was interrupted: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
      }
    }, 'GooeyPi could not complete the Windows desktop-state migration')
  }

  private scheduleWindowsTombstoneRecovery(tombstone: WindowsLegacyTombstone): void {
    this.scheduleInitializationOperation(
      () => this.resumeWindowsTombstone(tombstone),
      'GooeyPi could not resume the interrupted Windows desktop-state migration',
    )
  }

  private async resumeWindowsTombstone(tombstone: WindowsLegacyTombstone): Promise<void> {
    if (tombstone.status === 'complete') {
      const verifiedBackup = tombstone.backupFile
        ? this.verifiedBackupFile(join(dirname(this.legacyFilePath!), tombstone.backupFile))
        : undefined
      throw this.migrationError('The completed Windows compatibility marker exists, but the authoritative v4 state is missing. Automatic import was refused to avoid restoring stale grants', verifiedBackup)
    }
    if (tombstone.backupFile) {
      const backupPath = join(dirname(this.legacyFilePath!), tombstone.backupFile)
      try {
        const { size } = statSync(backupPath)
        if (size > MAX_STATE_FILE_BYTES) {
          throw new StateCompatibilityError(`Desktop state recovery file at ${backupPath} is ${size} bytes, which exceeds the ${MAX_STATE_FILE_BYTES}-byte safe parse limit. It was left unchanged.`)
        }
        const recovered = parseState(JSON.parse(readFileSync(backupPath, 'utf8')), backupPath)
        this.state = recovered.state
      } catch (error) {
        if (error instanceof StateCompatibilityError) throw error
        throw this.migrationError(`The pending Windows migration backup at ${backupPath} could not be read safely: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
      }
    } else if (tombstone.reason !== 'fresh') {
      throw this.migrationError('The pending Windows compatibility marker has no recovery backup')
    }
    try {
      await this.durable.persist(this.state)
      await this.publishWindowsLegacyTombstone({ ...tombstone, status: 'complete' })
    } catch (error) {
      if (error instanceof StateCompatibilityError || error instanceof StateMigrationError) throw error
      const verifiedBackup = tombstone.backupFile
        ? this.verifiedBackupFile(join(dirname(this.legacyFilePath!), tombstone.backupFile))
        : undefined
      throw this.migrationError(`The interrupted Windows migration could not publish recovered v4 state: ${errorMessage(error)}`, verifiedBackup)
    }
  }

  private scheduleWindowsLegacyProtection(): void {
    this.scheduleInitializationOperation(
      () => this.ensureWindowsLegacyProtection(true),
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
        throw this.migrationError(`The unreadable ${sourceKind} state could not be preserved before recovery: ${errorMessage(preservationFailure)}`)
      }
      if (sourceKind === 'current') {
        await this.recoverWindowsAfterCorruptCurrent(recoveryPath)
        return
      }
      await this.initializeWindowsFreshState()
    }, 'GooeyPi desktop state could not be safely rewritten after reset')
  }

  private scheduleInitializationOperation(operation: () => Promise<void>, failurePrefix: string): void {
    const initialization = operation().catch((failure: unknown) => {
      if (failure instanceof StateCompatibilityError || failure instanceof StateMigrationError) throw failure
      if (this.legacyFilePath) throw this.migrationError(`${failurePrefix}: ${errorMessage(failure)}`)
      throw failure
    })
    this.readyPromise = initialization
    this.queue = initialization.catch((failure: unknown) => {
      this.initializationFailure = failure instanceof Error ? failure : new Error(String(failure))
      console.error(`${failurePrefix}: ${failure instanceof Error ? failure.message : String(failure)}`)
    })
  }

  private async retireLegacyState(): Promise<void> {
    if (!this.legacyFilePath) return
    const backupPath = this.nextLegacyBackupPath()
    try {
      await this.fileSystem.rename(this.legacyFilePath, backupPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && !this.pathExists(backupPath)) return
      throw this.migrationError(`Legacy desktop state could not be retired before startup: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
    }
    try {
      await this.durable.syncParentDirectory(this.legacyFilePath, true)
    } catch (retirementSyncError) {
      try {
        await this.fileSystem.rename(backupPath, this.legacyFilePath)
      } catch (rollbackRenameError) {
        throw this.migrationError(`Legacy desktop state retirement was not durable: ${errorMessage(retirementSyncError)}; rollback rename failed: ${errorMessage(rollbackRenameError)}`, this.verifiedBackupFile(backupPath))
      }
      try {
        await this.durable.syncParentDirectory(this.legacyFilePath, true)
      } catch (rollbackSyncError) {
        throw this.migrationError(`Legacy desktop state retirement was not durable: ${errorMessage(retirementSyncError)}; the legacy filename was restored, but rollback directory sync failed: ${errorMessage(rollbackSyncError)}`)
      }
      throw this.migrationError(`Legacy desktop state retirement was not durable: ${errorMessage(retirementSyncError)}; the legacy filename was restored and synchronized for a safe retry`)
    }
  }

  private async recoverWindowsAfterCorruptCurrent(corruptBackupPath?: string): Promise<void> {
    if (!this.legacyFilePath) return
    let size: number
    try {
      size = statSync(this.legacyFilePath).size
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      await this.initializeWindowsFreshState()
      return
    }

    const recoveryDetail = corruptBackupPath
      ? ` The unreadable v4 bytes were preserved at ${corruptBackupPath}.`
      : ''
    if (size > MAX_STATE_FILE_BYTES) {
      throw this.migrationError(`The current v4 state was corrupt and the legacy state is too large to classify safely; automatic recovery was refused.${recoveryDetail}`, corruptBackupPath)
    }

    let serializedLegacy: unknown
    try {
      serializedLegacy = JSON.parse(readFileSync(this.legacyFilePath, 'utf8'))
    } catch (error) {
      throw this.migrationError(`The current v4 state was corrupt and the legacy state is unreadable; both were preserved for explicit recovery: ${errorMessage(error)}.${recoveryDetail}`, corruptBackupPath)
    }

    const tombstone = parseWindowsLegacyTombstone(serializedLegacy)
    if (tombstone) {
      if (tombstone.status === 'pending') {
        await this.resumeWindowsTombstone(tombstone)
        return
      }
      const markerBackup = tombstone.backupFile
        ? this.verifiedBackupFile(join(dirname(this.legacyFilePath), tombstone.backupFile))
        : undefined
      throw this.migrationError(`The current v4 state was corrupt while a completed Windows compatibility marker was present. Automatic restoration of an older backup was refused to avoid restoring stale grants.${recoveryDetail}`, markerBackup ?? corruptBackupPath)
    }

    try {
      parseState(serializedLegacy, this.legacyFilePath)
    } catch (error) {
      const classification = error instanceof StateCompatibilityError
        ? error.message
        : `the legacy state is not a supported schema: ${errorMessage(error)}`
      throw this.migrationError(`The current v4 state was corrupt and ${classification}. Both files were preserved for explicit recovery.${recoveryDetail}`, corruptBackupPath)
    }
    throw this.migrationError(`The current v4 state was corrupt and an unmarked legacy state was also present. Automatic import was refused because it may have been recreated by a downgraded binary; both files were preserved for explicit recovery.${recoveryDetail}`, corruptBackupPath)
  }

  private async ensureWindowsLegacyProtection(currentIsAuthoritative: boolean): Promise<void> {
    if (!this.legacyFilePath) return
    let size: number
    try {
      size = statSync(this.legacyFilePath).size
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      await this.publishWindowsLegacyTombstone(this.windowsLegacyTombstone('complete', null, 'fresh'))
      return
    }

    if (size <= MAX_STATE_FILE_BYTES) {
      try {
        const tombstone = parseWindowsLegacyTombstone(JSON.parse(readFileSync(this.legacyFilePath, 'utf8')))
        if (tombstone) {
          if (tombstone.status === 'complete') return
          if (!currentIsAuthoritative) return
          if (tombstone.backupFile) {
            const expectedBackup = join(dirname(this.legacyFilePath), tombstone.backupFile)
            if (!this.pathExists(expectedBackup)) {
              throw this.migrationError(`The pending migration marker names a backup that is missing at ${expectedBackup}; completion was refused`)
            }
          }
          await this.publishWindowsLegacyTombstone({ ...tombstone, status: 'complete' })
          return
        }
      } catch (error) {
        if (error instanceof StateMigrationError) throw error
        // Invalid JSON or a non-marker legacy file is quarantined below.
      }
    }

    const backupPath = this.nextLegacyBackupPath()
    try {
      await this.fileSystem.rename(this.legacyFilePath, backupPath)
    } catch (renameError) {
      const verifiedBackup = this.verifiedBackupFile(backupPath)
      throw this.migrationError(`Quarantine rename failed for a legacy state recreated by a downgraded binary: ${errorMessage(renameError)}`, verifiedBackup)
    }
    try {
      await this.durable.syncExistingFile(backupPath)
    } catch (syncError) {
      try {
        await this.fileSystem.rename(backupPath, this.legacyFilePath)
      } catch (rollbackError) {
        const verifiedBackup = this.verifiedBackupFile(backupPath)
        const location = verifiedBackup
          ? 'the byte-exact backup remains available'
          : this.pathExists(this.legacyFilePath)
            ? 'the legacy filename exists despite the reported rollback failure'
            : 'neither the backup nor legacy filename could be verified'
        throw this.migrationError(`Quarantine backup sync failed: ${errorMessage(syncError)}; rollback rename failed: ${errorMessage(rollbackError)}; ${location}`, verifiedBackup)
      }
      throw this.migrationError(`Quarantine backup sync failed: ${errorMessage(syncError)}; the legacy filename was restored for a safe retry`)
    }
    const marker = this.windowsLegacyTombstone('complete', basename(backupPath), 'quarantine')
    try {
      await this.publishWindowsLegacyTombstone(marker)
    } catch (error) {
      throw this.migrationError(`The downgraded legacy state was quarantined, but its zero-authority marker could not be published: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
    }
  }

  private windowsLegacyTombstone(status: WindowsLegacyTombstone['status'], backupFile: string | null, reason: WindowsLegacyTombstoneReason): WindowsLegacyTombstone {
    return { schemaVersion: 1, status, currentStateFile: CURRENT_DESKTOP_STATE_FILENAME, backupFile, reason }
  }

  private async publishWindowsLegacyTombstone(marker: WindowsLegacyTombstone): Promise<void> {
    if (!this.legacyFilePath) return
    const temp = `${this.legacyFilePath}.${process.pid}.${randomUUID()}.tombstone.tmp`
    const serialized = `${JSON.stringify({
      version: 3,
      projects: [],
      settings: {},
      archivedSessions: [],
      dismissedProjectPaths: [],
      schedules: [],
      [WINDOWS_LEGACY_TOMBSTONE_KEY]: marker,
    }, null, 2)}\n`
    try {
      await this.durable.writeDurableFile(temp, serialized, 'wx')
      await renameWithWindowsRetry((from, to) => this.fileSystem.rename(from, to), temp, this.legacyFilePath, this.platform)
    } finally {
      await this.durable.unlinkIfExists(temp)
    }
  }

  private nextLegacyBackupPath(): string {
    return `${this.legacyFilePath}.migrated-v4-${Date.now()}-${randomUUID()}`
  }

  private pathExists(path: string): boolean {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  }

  private verifiedBackupFile(path: string): string | undefined {
    return this.pathExists(path) ? basename(path) : undefined
  }

  private migrationError(message: string, backupPathOrFile?: string): StateMigrationError {
    return new StateMigrationError(
      message,
      this.filePath,
      this.legacyFilePath!,
      backupPathOrFile
        ? (isAbsolute(backupPathOrFile) ? backupPathOrFile : join(dirname(this.legacyFilePath!), backupPathOrFile))
        : undefined,
    )
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
