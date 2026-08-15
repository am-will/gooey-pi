import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_DESKTOP_STATE_FILENAME,
  defaultSettings,
  JsonStateStore,
  LEGACY_DESKTOP_STATE_FILENAME,
  StateMigrationError,
} from '../../electron/main/store'
import type { JsonStateStoreFileSystem } from '../../electron/main/store'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-windows-state-'))
  directories.push(directory)
  return directory
}

function legacyState(projectId = 'legacy-project'): string {
  return `${JSON.stringify({
    version: 2,
    projects: [{ id: projectId, name: 'Legacy', path: '/legacy', folders: ['/legacy'], primaryFolder: '/legacy' }],
    settings: defaultSettings(),
    archivedSessions: [],
    dismissedProjectPaths: [],
    schedules: [],
  }, null, 2)}\n`
}

function windowsFileSystem(directory: string, events: string[]): JsonStateStoreFileSystem {
  return {
    open: async (path, flags, mode) => {
      if (path === directory && flags === 'r') {
        events.push('directory-open')
        throw Object.assign(new Error('Windows does not support directory fsync'), { code: 'EPERM' })
      }
      const handle = await open(path, flags, mode)
      if (flags !== 'w' && flags !== 'wx') return handle
      return {
        writeFile: (data, options) => handle.writeFile(data, options),
        sync: async () => {
          events.push('file-sync')
          await handle.sync()
        },
        close: () => handle.close(),
      }
    },
    rename: async (oldPath, newPath) => {
      if (newPath.endsWith(CURRENT_DESKTOP_STATE_FILENAME)) events.push('publish-v4')
      if (oldPath.endsWith(LEGACY_DESKTOP_STATE_FILENAME)) events.push('retire-legacy')
      if (newPath.endsWith(LEGACY_DESKTOP_STATE_FILENAME)) events.push('publish-tombstone')
      await rename(oldPath, newPath)
    },
    unlink,
  }
}

function expectCompletedTombstone(path: string): { backupFile: string | null; reason: string } {
  const tombstone = JSON.parse(readFileSync(path, 'utf8')) as {
    version: number
    projects: unknown[]
    schedules: unknown[]
    gooeyPiV4Migration: { status: string; backupFile: string | null; reason: string }
  }
  expect(tombstone).toMatchObject({
    version: 3,
    projects: [],
    schedules: [],
    gooeyPiV4Migration: { status: 'complete' },
  })
  return tombstone.gooeyPiV4Migration
}

function expectReleasedLegacyReaderHasNoAuthority(path: string): void {
  const legacyReader = new JsonStateStore(path)
  expect(legacyReader.snapshot().projects).toEqual([])
  expect(legacyReader.snapshot().schedules).toEqual([])
}

describe('Windows desktop-state compatibility protocol', () => {
  it('publishes a fresh v4 state without attempting directory fsync or legacy retirement', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const events: string[] = []
    const store = new JsonStateStore(currentPath, windowsFileSystem(directory, events), legacyPath, 'win32')

    await store.ready()
    expect(events).not.toContain('directory-open')
    expect(events).not.toContain('retire-legacy')
    expect(events).toEqual([
      'file-sync', 'publish-tombstone',
      'file-sync', 'publish-v4',
      'file-sync', 'publish-tombstone',
    ])
    expect(JSON.parse(readFileSync(currentPath, 'utf8'))).toMatchObject({ version: 4, projects: [] })
    expect(expectCompletedTombstone(legacyPath)).toMatchObject({ backupFile: null, reason: 'fresh' })
    expectReleasedLegacyReaderHasNoAuthority(legacyPath)

    await store.update((state) => { state.archivedSessions.push('/sessions/fresh.jsonl') })
    expect(store.snapshot().archivedSessions).toEqual(['/sessions/fresh.jsonl'])
    expect(JSON.parse(readFileSync(currentPath, 'utf8')).archivedSessions).toEqual(['/sessions/fresh.jsonl'])
  })

  it('backs up legacy bytes, leaves a zero-authority tombstone, and quarantines downgrade writes on restart', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const originalLegacy = legacyState()
    writeFileSync(legacyPath, originalLegacy)
    const firstEvents: string[] = []

    const migrated = new JsonStateStore(currentPath, windowsFileSystem(directory, firstEvents), legacyPath, 'win32')
    await migrated.ready()
    expect(firstEvents).not.toContain('directory-open')
    expect(firstEvents).not.toContain('retire-legacy')
    expect(migrated.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    const initialTombstone = expectCompletedTombstone(legacyPath)
    expect(initialTombstone.reason).toBe('migration')
    expect(initialTombstone.backupFile).toMatch(new RegExp(`^${LEGACY_DESKTOP_STATE_FILENAME.replace('.', '\\.')}\\.migrated-v4-`))
    expect(readFileSync(join(directory, initialTombstone.backupFile!), 'utf8')).toBe(originalLegacy)
    expectReleasedLegacyReaderHasNoAuthority(legacyPath)

    await migrated.update((state) => { state.archivedSessions.push('/sessions/v4-only.jsonl') })
    await migrated.beginShutdown()

    const downgradedLegacy = legacyState('downgrade-write')
    writeFileSync(legacyPath, downgradedLegacy)
    const restartEvents: string[] = []
    const reopened = new JsonStateStore(currentPath, windowsFileSystem(directory, restartEvents), legacyPath, 'win32')

    await reopened.ready()
    expect(restartEvents).not.toContain('directory-open')
    expect(restartEvents).toContain('retire-legacy')
    expect(reopened.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    expect(reopened.snapshot().archivedSessions).toEqual(['/sessions/v4-only.jsonl'])
    const quarantineTombstone = expectCompletedTombstone(legacyPath)
    expect(quarantineTombstone.reason).toBe('quarantine')
    expect(readFileSync(join(directory, quarantineTombstone.backupFile!), 'utf8')).toBe(downgradedLegacy)
    expectReleasedLegacyReaderHasNoAuthority(legacyPath)

    await reopened.update((state) => { state.archivedSessions.push('/sessions/after-restart.jsonl') })
    expect(reopened.snapshot().archivedSessions).toEqual(['/sessions/v4-only.jsonl', '/sessions/after-restart.jsonl'])
  })

  it('preserves an incompatible current file while quarantining recreated legacy authority before readiness fails', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const futureCurrent = '{\n  "version": 99,\n  "futureAuthority": true\n}\n'
    const recreatedLegacy = legacyState('downgrade-write')
    writeFileSync(currentPath, futureCurrent)
    writeFileSync(legacyPath, recreatedLegacy)

    const store = new JsonStateStore(currentPath, windowsFileSystem(directory, []), legacyPath, 'win32')

    await expect(store.ready()).rejects.toThrow(/version 99.*newer/i)
    expect(readFileSync(currentPath, 'utf8')).toBe(futureCurrent)
    const tombstone = expectCompletedTombstone(legacyPath)
    expect(tombstone.reason).toBe('quarantine')
    expect(readFileSync(join(directory, tombstone.backupFile!), 'utf8')).toBe(recreatedLegacy)
  })

  it('recovers a pending tombstone from its byte-exact backup after v4 publication fails', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const originalLegacy = legacyState()
    writeFileSync(legacyPath, originalLegacy)
    const events: string[] = []
    const fileSystem = windowsFileSystem(directory, events)
    const failingStore = new JsonStateStore(currentPath, {
      ...fileSystem,
      rename: async (oldPath, newPath) => {
        if (newPath === currentPath) throw Object.assign(new Error('injected v4 publication failure'), { code: 'EIO' })
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')

    const readiness = failingStore.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    const pending = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
      projects: unknown[]
      schedules: unknown[]
      gooeyPiV4Migration: { status: string; backupFile: string }
    }
    expect(pending).toMatchObject({
      projects: [],
      schedules: [],
      gooeyPiV4Migration: { status: 'pending' },
    })
    await expect(readiness).rejects.toMatchObject({
      backupStatePath: join(directory, pending.gooeyPiV4Migration.backupFile),
    })
    expect(readFileSync(join(directory, pending.gooeyPiV4Migration.backupFile), 'utf8')).toBe(originalLegacy)

    const retried = new JsonStateStore(currentPath, windowsFileSystem(directory, []), legacyPath, 'win32')
    await retried.ready()
    expect(retried.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    expect(expectCompletedTombstone(legacyPath)).toMatchObject({
      backupFile: pending.gooeyPiV4Migration.backupFile,
      reason: 'migration',
    })
  })

  it('does not complete a pending migration when its promised backup is missing', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    writeFileSync(legacyPath, legacyState())
    const fileSystem = windowsFileSystem(directory, [])
    let tombstonePublications = 0
    const interrupted = new JsonStateStore(currentPath, {
      ...fileSystem,
      rename: async (oldPath, newPath) => {
        if (newPath === legacyPath && oldPath.includes('.tombstone.tmp')) {
          tombstonePublications += 1
          if (tombstonePublications === 2) throw Object.assign(new Error('injected completion marker failure'), { code: 'EIO' })
        }
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')
    await expect(interrupted.ready()).rejects.toBeInstanceOf(StateMigrationError)
    const pending = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
      gooeyPiV4Migration: { status: string; backupFile: string }
    }
    const missingBackupPath = join(directory, pending.gooeyPiV4Migration.backupFile)
    rmSync(missingBackupPath)

    const restarted = new JsonStateStore(currentPath, windowsFileSystem(directory, []), legacyPath, 'win32')
    const readiness = restarted.ready()

    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/pending migration.*backup.*missing/i)
    await expect(readiness).rejects.toMatchObject({ backupStatePath: undefined })
    expect(JSON.parse(readFileSync(legacyPath, 'utf8')).gooeyPiV4Migration.status).toBe('pending')
  })

  it('recovers a validated pending migration after a corrupt current file is backed up', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const originalLegacy = legacyState()
    writeFileSync(legacyPath, originalLegacy)
    const fileSystem = windowsFileSystem(directory, [])
    const interrupted = new JsonStateStore(currentPath, {
      ...fileSystem,
      rename: async (oldPath, newPath) => {
        if (newPath === currentPath) throw Object.assign(new Error('injected v4 publication failure'), { code: 'EIO' })
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')
    await expect(interrupted.ready()).rejects.toBeInstanceOf(StateMigrationError)
    const pending = JSON.parse(readFileSync(legacyPath, 'utf8')) as {
      gooeyPiV4Migration: { backupFile: string }
    }
    writeFileSync(currentPath, '{corrupt-v4')

    const recovered = new JsonStateStore(currentPath, windowsFileSystem(directory, []), legacyPath, 'win32')
    await recovered.ready()

    expect(recovered.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    expect(readFileSync(join(directory, pending.gooeyPiV4Migration.backupFile), 'utf8')).toBe(originalLegacy)
    expect(expectCompletedTombstone(legacyPath)).toMatchObject({
      backupFile: pending.gooeyPiV4Migration.backupFile,
      reason: 'migration',
    })
  })

  it('fails closed and preserves an unmarked legacy file when the current v4 state is corrupt', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const corruptCurrent = '{corrupt-v4'
    const ambiguousLegacy = legacyState('ambiguous-legacy')
    writeFileSync(currentPath, corruptCurrent)
    writeFileSync(legacyPath, ambiguousLegacy)

    const store = new JsonStateStore(currentPath, windowsFileSystem(directory, []), legacyPath, 'win32')
    const readiness = store.ready()

    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/corrupt.*unmarked legacy.*automatic import.*refused/i)
    expect(readFileSync(legacyPath, 'utf8')).toBe(ambiguousLegacy)
    const corruptBackup = readdirSync(directory).find((name) => name.startsWith(`${CURRENT_DESKTOP_STATE_FILENAME}.corrupt-`))
    expect(corruptBackup).toBeDefined()
    expect(readFileSync(join(directory, corruptBackup!), 'utf8')).toBe(corruptCurrent)
  })

  it('does not advertise a quarantine backup when the initial rename fails', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const current = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const recreatedLegacy = legacyState('downgrade-write')
    writeFileSync(currentPath, current)
    writeFileSync(legacyPath, recreatedLegacy)
    const fileSystem = windowsFileSystem(directory, [])
    const store = new JsonStateStore(currentPath, {
      ...fileSystem,
      rename: async (oldPath, newPath) => {
        if (oldPath === legacyPath) throw Object.assign(new Error('injected quarantine rename failure'), { code: 'EACCES' })
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toMatchObject({ backupStatePath: undefined })
    await expect(readiness).rejects.toThrow(/quarantine rename failed.*injected quarantine rename failure/i)
    expect(readFileSync(legacyPath, 'utf8')).toBe(recreatedLegacy)
  })

  it('reports a quarantine backup sync failure without advertising a restored backup', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const current = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const recreatedLegacy = legacyState('downgrade-write')
    writeFileSync(currentPath, current)
    writeFileSync(legacyPath, recreatedLegacy)
    const fileSystem = windowsFileSystem(directory, [])
    let backupPath = ''
    const store = new JsonStateStore(currentPath, {
      ...fileSystem,
      open: async (path, flags, mode) => {
        if (flags === 'r+' && path === backupPath) {
          const handle = await open(path, flags, mode)
          return {
            writeFile: (data, options) => handle.writeFile(data, options),
            sync: async () => { throw Object.assign(new Error('injected backup sync failure'), { code: 'EIO' }) },
            close: () => handle.close(),
          }
        }
        return fileSystem.open(path, flags, mode)
      },
      rename: async (oldPath, newPath) => {
        if (oldPath === legacyPath) backupPath = newPath
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/backup sync failed.*legacy filename was restored/i)
    await expect(readiness).rejects.toMatchObject({ backupStatePath: undefined })
    expect(readFileSync(legacyPath, 'utf8')).toBe(recreatedLegacy)
  })

  it('distinguishes quarantine backup sync and rollback failures', async () => {
    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const current = JSON.stringify({ version: 4, projects: [], settings: defaultSettings(), archivedSessions: [], dismissedProjectPaths: [], schedules: [] })
    const recreatedLegacy = legacyState('downgrade-write')
    writeFileSync(currentPath, current)
    writeFileSync(legacyPath, recreatedLegacy)
    const fileSystem = windowsFileSystem(directory, [])
    let backupPath = ''
    const store = new JsonStateStore(currentPath, {
      ...fileSystem,
      open: async (path, flags, mode) => {
        if (flags === 'r+' && path === backupPath) {
          const handle = await open(path, flags, mode)
          return {
            writeFile: (data, options) => handle.writeFile(data, options),
            sync: async () => { throw Object.assign(new Error('injected backup sync failure'), { code: 'EIO' }) },
            close: () => handle.close(),
          }
        }
        return fileSystem.open(path, flags, mode)
      },
      rename: async (oldPath, newPath) => {
        if (oldPath === legacyPath) {
          backupPath = newPath
          await fileSystem.rename(oldPath, newPath)
          return
        }
        if (oldPath === backupPath && newPath === legacyPath) {
          throw Object.assign(new Error('injected quarantine rollback failure'), { code: 'EACCES' })
        }
        await fileSystem.rename(oldPath, newPath)
      },
    }, legacyPath, 'win32')

    const readiness = store.ready()
    await expect(readiness).rejects.toBeInstanceOf(StateMigrationError)
    await expect(readiness).rejects.toThrow(/backup sync failed.*rollback rename failed/i)
    await expect(readiness).rejects.toMatchObject({ backupStatePath: backupPath })
    expect(readFileSync(backupPath, 'utf8')).toBe(recreatedLegacy)
  })

  it.runIf(process.platform === 'win32')('covers fresh install, migration, restart, and updates with the real Windows platform default', async () => {
    const freshDirectory = makeDirectory()
    const freshCurrentPath = join(freshDirectory, CURRENT_DESKTOP_STATE_FILENAME)
    const freshLegacyPath = join(freshDirectory, LEGACY_DESKTOP_STATE_FILENAME)
    const freshStore = new JsonStateStore(freshCurrentPath, undefined, freshLegacyPath)
    await freshStore.ready()
    expect(expectCompletedTombstone(freshLegacyPath)).toMatchObject({ backupFile: null, reason: 'fresh' })
    await freshStore.update((state) => { state.archivedSessions.push('/sessions/windows-fresh.jsonl') })
    await freshStore.beginShutdown()

    const freshRestart = new JsonStateStore(freshCurrentPath, undefined, freshLegacyPath)
    await freshRestart.ready()
    expect(freshRestart.snapshot().archivedSessions).toEqual(['/sessions/windows-fresh.jsonl'])
    await freshRestart.beginShutdown()

    const directory = makeDirectory()
    const currentPath = join(directory, CURRENT_DESKTOP_STATE_FILENAME)
    const legacyPath = join(directory, LEGACY_DESKTOP_STATE_FILENAME)
    const raw = legacyState()
    writeFileSync(legacyPath, raw)

    const productionStore = new JsonStateStore(currentPath, undefined, legacyPath)
    await productionStore.ready()

    expect(productionStore.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    const tombstone = expectCompletedTombstone(legacyPath)
    expect(readFileSync(join(directory, tombstone.backupFile!), 'utf8')).toBe(raw)
    await productionStore.update((state) => { state.archivedSessions.push('/sessions/windows-ci.jsonl') })
    expect(productionStore.snapshot().archivedSessions).toEqual(['/sessions/windows-ci.jsonl'])
    await productionStore.beginShutdown()

    const productionRestart = new JsonStateStore(currentPath, undefined, legacyPath)
    await productionRestart.ready()
    expect(productionRestart.snapshot().projects).toMatchObject([{ id: 'legacy-project', harness: 'prime' }])
    expect(productionRestart.snapshot().archivedSessions).toEqual(['/sessions/windows-ci.jsonl'])
    await productionRestart.update((state) => { state.archivedSessions.push('/sessions/windows-restart.jsonl') })
    expect(productionRestart.snapshot().archivedSessions).toEqual(['/sessions/windows-ci.jsonl', '/sessions/windows-restart.jsonl'])
    await productionRestart.beginShutdown()
  })
})
