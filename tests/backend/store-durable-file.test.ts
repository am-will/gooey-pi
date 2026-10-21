import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableStateFile, nodeFileSystem } from '../../electron/main/store/durable-file'
import { LegacyStateMigrator } from '../../electron/main/store/legacy-migration'

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gooeypi-durable-ownership-'))
  directories.push(path)
  return path
}

it('preserves an existing file when a real exclusive open rejects ownership', async () => {
  const root = directory()
  const target = join(root, 'existing')
  writeFileSync(target, 'existing bytes')
  const file = new DurableStateFile(join(root, 'state.json'), nodeFileSystem, process.platform)
  await expect(file.writeDurableFile(target, 'replacement', 'wx')).rejects.toMatchObject({ code: 'EEXIST' })
  expect(readFileSync(target, 'utf8')).toBe('existing bytes')
})

it('does not delete a tombstone temporary file whose exclusive open it never acquired', async () => {
  const root = directory()
  let collisionPath = ''
  const fileSystem = {
    ...nodeFileSystem,
    open: async (path: string, flags: string, mode?: number) => {
      collisionPath = path
      writeFileSync(path, 'another writer owns these bytes')
      return nodeFileSystem.open(path, flags, mode)
    },
    unlink: vi.fn(nodeFileSystem.unlink),
  }
  const current = join(root, 'current.json')
  const persist = vi.fn(async () => undefined)
  const migrator = new LegacyStateMigrator(current, join(root, 'legacy.json'), 'win32', fileSystem,
    new DurableStateFile(current, fileSystem, 'win32'), persist, () => undefined)
  await expect(migrator.initializeWindowsFreshState()).rejects.toMatchObject({ code: 'EEXIST' })
  expect(readFileSync(collisionPath, 'utf8')).toBe('another writer owns these bytes')
  expect(fileSystem.unlink).not.toHaveBeenCalled()
  expect(persist).not.toHaveBeenCalled()
})
