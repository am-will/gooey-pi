import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { killProcessTree, type KillProcessTreeOptions } from '../../electron/main/process-utils'

const native = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => native)
vi.mock('../../electron/main/process-utils', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../electron/main/process-utils')>(),
  killProcessTree: vi.fn(async (_pid: number, options: KillProcessTreeOptions) => { options.signalDirect?.('SIGHUP'); return true }),
}))
import { TerminalService } from '../../electron/main/terminal'

const directories: string[] = []
const services: TerminalService[] = []
const shell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((path) => {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}) ?? '/bin/sh'
function owner(id = 100): WebContents { return { id, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents }
function directory(): string { const path = realpathSync(mkdtempSync(join(tmpdir(), 'gooeypi-terminal-admission-'))); directories.push(path); return path }
function deferred<T>() {
  let finish: (value: T) => void = () => { throw new Error('Promise not initialized') }
  const promise = new Promise<T>((resolve) => { finish = resolve })
  return { promise, finish }
}
function fakePty() {
  const exits: Array<(event: { exitCode: number; signal?: number }) => void> = []
  const data: Array<(value: string) => void> = []
  const emitExit = () => { for (const listener of exits) listener({ exitCode: 0 }) }
  return {
    pid: 99_999_999, write: vi.fn(), resize: vi.fn(), pause: vi.fn(), resume: vi.fn(), kill: vi.fn(emitExit), emitExit,
    emitData: (value: string) => { for (const listener of data) listener(value) },
    onData: vi.fn((listener: (value: string) => void) => { data.push(listener); return { dispose() {} } }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => { exits.push(listener); return { dispose() {} } }),
  }
}
beforeEach(() => { native.spawn.mockReset().mockImplementation(fakePty); vi.mocked(killProcessTree).mockClear() })
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.killAll()))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('pending terminal ownership', () => {
  it('cancels creation when its owner navigates during project authorization', async () => {
    const cwd = directory()
    const authorization = deferred<string>()
    const service = new TerminalService(() => authorization.promise, () => shell)
    services.push(service)
    const renderer = owner()
    const pending = service.create(renderer, { cwd })
    await service.killOwner(renderer.id)
    authorization.finish(cwd)
    await expect(pending).rejects.toThrow(/owner|cancel/i)
    expect(native.spawn).not.toHaveBeenCalled()
  })

  it('releases an acquired workspace lease when the owner closes during admission, then permits a fresh owner request', async () => {
    const cwd = directory()
    const lease = deferred<{ release(): void }>()
    const entered = deferred<void>()
    const release = vi.fn()
    const begin = vi.fn().mockImplementationOnce(() => { entered.finish(); return lease.promise }).mockResolvedValue({ release })
    const service = new TerminalService(async () => cwd, () => shell, async (path) => path, begin)
    services.push(service)
    const renderer = owner()
    const pending = service.create(renderer, { cwd })
    await entered.promise
    await service.killOwner(renderer.id)
    lease.finish({ release })
    await expect(pending).rejects.toThrow(/owner|cancel/i)
    expect(release).toHaveBeenCalledOnce()
    expect(native.spawn).not.toHaveBeenCalled()
    await expect(service.create(renderer, { cwd })).resolves.toHaveProperty('terminalId')
    expect(native.spawn).toHaveBeenCalledOnce()
  })

  it('fully tears down a spawned process tree when cancellation arrives during native spawn', async () => {
    const cwd = directory()
    const release = vi.fn()
    const service = new TerminalService(async () => cwd, () => shell, async (path) => path, async () => ({ release }))
    services.push(service)
    const renderer = owner()
    native.spawn.mockImplementationOnce(() => { void service.killOwner(renderer.id); return fakePty() })
    await expect(service.create(renderer, { cwd })).rejects.toThrow(/owner|cancel/i)
    expect(killProcessTree).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  })

  it('cancels pending creates and refuses new ones once app shutdown starts', async () => {
    const cwd = directory()
    const authorization = deferred<string>()
    const service = new TerminalService(() => authorization.promise, () => shell)
    services.push(service)
    const pending = service.create(owner(), { cwd })
    await service.killAll()
    authorization.finish(cwd)
    await expect(pending).rejects.toThrow(/owner|cancel/i)
    await expect(service.create(owner(), { cwd })).rejects.toThrow('shutting down')
    expect(native.spawn).not.toHaveBeenCalled()
  })

  it('cancels pending session and project terminals before an archive or removal finishes', async () => {
    const cwd = directory()
    const authorization = deferred<string>()
    const service = new TerminalService(() => authorization.promise, () => shell, async (path) => path)
    services.push(service)
    const renderer = owner()
    const session = service.create(renderer, { cwd, sessionPath: '/sessions/task.jsonl' })
    await service.killForSession('/sessions/./task.jsonl')
    const project = service.create(renderer, { cwd })
    await service.killForProjectRoots([cwd])
    authorization.finish(cwd)
    await expect(session).rejects.toThrow(/owner|cancel/i)
    await expect(project).rejects.toThrow(/owner|cancel/i)
    expect(native.spawn).not.toHaveBeenCalled()
  })
})


describe('terminal capacity admission', () => {
  it('reserves no more than eight slots while workspace admission is pending', async () => {
    const cwd = directory()
    const lease = deferred<{ release(): void }>()
    const entered = deferred<void>()
    const release = vi.fn()
    const begin = vi.fn(() => { if (begin.mock.calls.length === 8) entered.finish(); return lease.promise })
    const service = new TerminalService(async () => cwd, () => shell, async (path) => path, begin)
    services.push(service)
    const creates = Promise.allSettled(Array.from({ length: 9 }, () => service.create(owner(), { cwd })))
    await entered.promise
    expect(begin).toHaveBeenCalledTimes(8)
    lease.finish({ release })
    const results = await creates
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(8)
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([{ reason: expect.objectContaining({ message: expect.stringContaining('eight') }) }])
    expect(native.spawn).toHaveBeenCalledTimes(8)
  })

  it('releases pending slots immediately when an owner is revoked', async () => {
    const cwd = directory()
    const authorization = deferred<string>()
    let calls = 0
    const service = new TerminalService(() => ++calls <= 8 ? authorization.promise : Promise.resolve(cwd), () => shell)
    services.push(service)
    const oldOwner = owner(200)
    const old = Promise.allSettled(Array.from({ length: 8 }, () => service.create(oldOwner, { cwd })))
    await service.killOwner(oldOwner.id)
    await expect(service.create(owner(201), { cwd })).resolves.toHaveProperty('terminalId')
    authorization.finish(cwd)
    expect((await old).every((result) => result.status === 'rejected')).toBe(true)
    expect(native.spawn).toHaveBeenCalledOnce()
  })
})
