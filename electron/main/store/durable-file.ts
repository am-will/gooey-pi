import { randomUUID } from 'node:crypto'
import { open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { renameWithWindowsRetry } from '../lib/durable-write'
import { errorCode } from '../validation'
import { MAX_STATE_FILE_BYTES, type DesktopState } from './state-schema'

export interface JsonStateStoreFileHandle {
  writeFile(data: string | Uint8Array, options: { encoding: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface JsonStateStoreFileSystem {
  open(path: string, flags: string, mode?: number): Promise<JsonStateStoreFileHandle>
  rename(oldPath: string, newPath: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeFileSystem: JsonStateStoreFileSystem = {
  open: (path, flags, mode) => open(path, flags, mode) as Promise<FileHandle>,
  rename,
  unlink,
}

/** Atomic desktop-state writes and durability operations shared with legacy migration. */
export class DurableStateFile {
  constructor(
    private readonly filePath: string,
    private readonly fileSystem: JsonStateStoreFileSystem,
    private readonly platform: NodeJS.Platform,
  ) {}

  async unlinkIfExists(path: string): Promise<void> {
    await this.fileSystem.unlink(path).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }

  async writeDurableFile(path: string, data: string | Uint8Array, flags: string): Promise<void> {
    const file = await this.fileSystem.open(path, flags, 0o600)
    let completed = false
    try {
      try {
        await file.writeFile(data, { encoding: 'utf8' })
        await file.sync()
      } finally {
        await file.close()
      }
      completed = true
    } finally {
      if (!completed) {
        await this.unlinkIfExists(path)
      }
    }
  }

  async syncExistingFile(path: string): Promise<void> {
    const file = await this.fileSystem.open(path, 'r+')
    try { await file.sync() } finally { await file.close() }
  }

  async persist(state: DesktopState, requireDirectorySync = false): Promise<void> {
    // The write cap matches the read cap so a saved file is always loadable on the next launch.
    const serialized = `${JSON.stringify(state, null, 2)}\n`
    const bytes = Buffer.byteLength(serialized, 'utf8')
    if (bytes > MAX_STATE_FILE_BYTES) {
      throw new Error(`Desktop state would be ${bytes} bytes, exceeding the ${MAX_STATE_FILE_BYTES}-byte safe size limit; the change was not saved`)
    }
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    let created = false
    try {
      await this.writeDurableFile(temp, serialized, 'w')
      created = true

      await renameWithWindowsRetry((from, to) => this.fileSystem.rename(from, to), temp, this.filePath, this.platform)

      await this.syncParentDirectory(this.filePath, requireDirectorySync)
    } finally {
      if (created) await this.unlinkIfExists(temp)
    }
  }

  async syncParentDirectory(path: string, required = false): Promise<void> {
    if (this.platform === 'win32') return
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
