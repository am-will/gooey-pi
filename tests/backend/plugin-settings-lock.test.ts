import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireSettingsLock } from '../../electron/main/plugins/mcp'

const fault = vi.hoisted(() => ({ fail: false, replace: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (fault.fail && typeof args[0] === 'string' && args[0].endsWith('owner.json')) {
      fault.fail = false
      if (fault.replace) {
        const directory = dirname(args[0])
        await actual.rename(directory, `${directory}.old`)
        await actual.mkdir(directory)
        await actual.writeFile(join(directory, 'foreign'), 'preserve')
      }
      throw Object.assign(new Error('Owner metadata write failed'), { code: 'ENOSPC' })
    }
    return actual.writeFile(...args)
  } }
})

const directories: string[] = []
afterEach(() => { fault.fail = false; fault.replace = false; for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function path() { const directory = mkdtempSync(join(tmpdir(), 'gooeypi-settings-lock-')); directories.push(directory); return join(directory, 'settings.json') }

it('removes its newly acquired empty directory after owner metadata publication fails', async () => {
  const settings = path()
  fault.fail = true
  await expect(acquireSettingsLock(settings)).rejects.toThrow('Owner metadata write failed')
  expect(existsSync(`${settings}.lock`)).toBe(false)
  const release = await acquireSettingsLock(settings)
  await release()
})

it('preserves a replacement directory when owner metadata publication fails', async () => {
  const settings = path()
  fault.fail = true; fault.replace = true
  await expect(acquireSettingsLock(settings)).rejects.toThrow('Owner metadata write failed')
  expect(readFileSync(join(`${settings}.lock`, 'foreign'), 'utf8')).toBe('preserve')
})
