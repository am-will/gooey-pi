import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installCrashGuards, writeCrashLog, type CrashGuard } from '../../electron/main/crash-guard'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const guards: CrashGuard[] = []

afterEach(() => {
  for (const guard of guards.splice(0)) guard.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-crash-'))
  dirs.push(dir)
  return dir
}

function install(options: Partial<Parameters<typeof installCrashGuards>[0]> & { logPath?: () => string | null } = {}) {
  const exits: number[] = []
  const cleanups: number[] = []
  const guard = installCrashGuards({
    logPath: options.logPath ?? (() => null),
    cleanup: options.cleanup ?? (async () => { cleanups.push(1) }),
    exit: (code) => { exits.push(code) },
    cleanupTimeoutMs: options.cleanupTimeoutMs ?? 200,
  })
  guards.push(guard)
  return { guard, exits, cleanups }
}

describe('crash guards', () => {
  it('records startup failures without installing fatal process handlers', () => {
    const path = join(temp(), 'startup.log')
    writeCrashLog(() => path, 'startup', new Error('Missing resource'))
    expect(readFileSync(path, 'utf8')).toMatch(/startup: Error: Missing resource/)
    expect(() => writeCrashLog(() => { throw new Error('Unavailable path') }, 'startup', 'original')).not.toThrow()
  })

  it('registers last-resort process handlers and removes them on dispose', () => {
    const beforeExceptions = process.listenerCount('uncaughtException')
    const beforeRejections = process.listenerCount('unhandledRejection')
    const { guard } = install()
    expect(process.listenerCount('uncaughtException')).toBe(beforeExceptions + 1)
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejections + 1)
    guard.dispose()
    expect(process.listenerCount('uncaughtException')).toBe(beforeExceptions)
    expect(process.listenerCount('unhandledRejection')).toBe(beforeRejections)
  })

  it('logs the failure, awaits child cleanup, and exits non-zero exactly once', async () => {
    const dir = temp()
    const logPath = join(dir, 'nested', 'crash.log')
    const { guard, exits, cleanups } = install({ logPath: () => logPath })
    guard.handle('uncaughtException', new Error('stream destroyed'))
    await waitUntil(() => exits.length > 0)
    expect(exits).toEqual([1])
    expect(cleanups).toEqual([1])
    expect(readFileSync(logPath, 'utf8')).toMatch(/uncaughtException: Error: stream destroyed/)
    // Re-entry while crashing must be a no-op rather than a second exit.
    guard.handle('unhandledRejection', new Error('again'))
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    expect(exits).toEqual([1])
  })

  it('still exits non-zero when cleanup rejects', async () => {
    const { guard, exits } = install({ cleanup: async () => { throw new Error('cleanup failed') } })
    guard.handle('unhandledRejection', 'string reason')
    await waitUntil(() => exits.length > 0)
    expect(exits).toEqual([1])
  })

  it('exits after the deadline when cleanup hangs', async () => {
    const { guard, exits } = install({ cleanup: () => new Promise(() => {}), cleanupTimeoutMs: 50 })
    guard.handle('uncaughtException', new Error('hung cleanup'))
    await waitUntil(() => exits.length > 0)
    expect(exits).toEqual([1])
  })

  it('never throws when the crash log cannot be written', async () => {
    const { guard, exits } = install({ logPath: () => { throw new Error('no userData yet') } })
    expect(() => guard.handle('uncaughtException', new Error('early crash'))).not.toThrow()
    await waitUntil(() => exits.length > 0)
    expect(exits).toEqual([1])
  })
})
