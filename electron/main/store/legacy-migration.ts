import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { renameWithWindowsRetry } from '../lib/durable-write'
import { errorCode, errorMessage, isRecord } from '../validation'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME, StateCompatibilityError, StateMigrationError, MAX_STATE_FILE_BYTES, parseState, type DesktopState } from './state-schema'
import type { DurableStateFile, JsonStateStoreFileSystem } from './durable-file'

type WindowsLegacyTombstoneReason = 'fresh' | 'migration' | 'quarantine'

export interface WindowsLegacyTombstone {
  schemaVersion: 1
  status: 'pending' | 'complete'
  currentStateFile: typeof CURRENT_DESKTOP_STATE_FILENAME
  backupFile: string | null
  reason: WindowsLegacyTombstoneReason
}

const WINDOWS_LEGACY_TOMBSTONE_KEY = 'gooeyPiV4Migration'

export function parseWindowsLegacyTombstone(value: unknown): WindowsLegacyTombstone | null {
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


/** Publishes legacy recovery markers and retires old authority only after durable replacement. */
export class LegacyStateMigrator {
  constructor(
    private readonly filePath: string,
    private readonly legacyFilePath: string | undefined,
    private readonly platform: NodeJS.Platform,
    private readonly fileSystem: JsonStateStoreFileSystem,
    private readonly durable: DurableStateFile,
    private readonly persistState: () => Promise<void>,
    private readonly replaceState: (state: DesktopState) => void,
  ) {}

  async initializeWindowsFreshState(): Promise<void> {
    const pending = this.windowsLegacyTombstone('pending', null, 'fresh')
    await this.publishWindowsLegacyTombstone(pending)
    await this.persistState()
    await this.publishWindowsLegacyTombstone({ ...pending, status: 'complete' })
  }

  async resumeWindowsTombstone(tombstone: WindowsLegacyTombstone): Promise<void> {
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
        this.replaceState(recovered.state)
      } catch (error) {
        if (error instanceof StateCompatibilityError) throw error
        throw this.migrationError(`The pending Windows migration backup at ${backupPath} could not be read safely: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
      }
    } else if (tombstone.reason !== 'fresh') {
      throw this.migrationError('The pending Windows compatibility marker has no recovery backup')
    }
    try {
      await this.persistState()
      await this.publishWindowsLegacyTombstone({ ...tombstone, status: 'complete' })
    } catch (error) {
      if (error instanceof StateCompatibilityError || error instanceof StateMigrationError) throw error
      const verifiedBackup = tombstone.backupFile
        ? this.verifiedBackupFile(join(dirname(this.legacyFilePath!), tombstone.backupFile))
        : undefined
      throw this.migrationError(`The interrupted Windows migration could not publish recovered v4 state: ${errorMessage(error)}`, verifiedBackup)
    }
  }

  async retireLegacyState(): Promise<void> {
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

  async recoverWindowsAfterCorruptCurrent(corruptBackupPath?: string): Promise<void> {
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

  async ensureWindowsLegacyProtection(currentIsAuthoritative: boolean): Promise<void> {
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
    let created = false
    try {
      await this.durable.writeDurableFile(temp, serialized, 'wx')
      created = true
      await renameWithWindowsRetry((from, to) => this.fileSystem.rename(from, to), temp, this.legacyFilePath, this.platform)
    } finally {
      if (created) await this.durable.unlinkIfExists(temp)
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

  migrationError(message: string, backupPathOrFile?: string): StateMigrationError {
    return new StateMigrationError(
      message,
      this.filePath,
      this.legacyFilePath!,
      backupPathOrFile
        ? (isAbsolute(backupPathOrFile) ? backupPathOrFile : join(dirname(this.legacyFilePath!), backupPathOrFile))
        : undefined,
    )
  }

  async migrateWindowsLegacy(rawLegacyState: Uint8Array): Promise<void> {
    const backupPath = this.nextLegacyBackupPath()
    const pending = this.windowsLegacyTombstone('pending', basename(backupPath), 'migration')
    try {
      await this.durable.writeDurableFile(backupPath, rawLegacyState, 'wx')
      await this.publishWindowsLegacyTombstone(pending)
      await this.persistState()
      await this.publishWindowsLegacyTombstone({ ...pending, status: 'complete' })
    } catch (error) {
      if (error instanceof StateCompatibilityError || error instanceof StateMigrationError) throw error
      throw this.migrationError(`The Windows desktop-state migration was interrupted: ${errorMessage(error)}`, this.verifiedBackupFile(backupPath))
    }
  }

}
