import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeHarnessExecutable } from '../../electron/main/harness-discovery'
import { HARNESSES } from '../../electron/main/harness'
import { PROCESS_CONCURRENCY_LIMIT, executableChildEnvironment, harnessExecutableCandidates, isAbsolutePathForPlatform, killProcessTree, prepareExecutableSpawn, nvmHarnessExecutableCandidates, primeAgentCandidates, primeAgentExecutableName, processFailureReason, processOutcome, runProcess, stopChildProcesses, waitForProcessExit, type ProcessResult } from '../../electron/main/process-utils'
import { waitUntil } from '../helpers/wait'

const spawnOverride = vi.hoisted(() => ({ current: null as null | ((...args: unknown[]) => unknown) }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: unknown[]) => (spawnOverride.current ? spawnOverride.current(...args) : (actual.spawn as (...spawnArgs: unknown[]) => unknown)(...args)),
  }
})

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'prime-work-process-')); dirs.push(dir); return dir }
describe('runProcess resource bounds', () => {
  it('runs a pnpm CLI under a Finder-style minimal PATH', async () => {
    const home = temp()
    const shimDirectory = join(home, 'Library', 'pnpm', 'bin')
    const runtimeDirectory = join(home, '.nvm', 'versions', 'node', 'v25.2.1', 'bin')
    mkdirSync(shimDirectory, { recursive: true })
    mkdirSync(runtimeDirectory, { recursive: true })
    const executable = join(shimDirectory, 'pi')
    symlinkSync(process.execPath, join(runtimeDirectory, 'node'))
    writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write("0.84.1\\n")\n')
    chmodSync(executable, 0o755)

    const result = await runProcess(executable, ['--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('0.84.1\n')
    expect(executableChildEnvironment(executable, { HOME: home, PATH: '/usr/bin' }).PATH?.split(':').slice(0, 2)).toEqual([
      shimDirectory,
      runtimeDirectory,
    ])

    const primeExecutable = join(runtimeDirectory, 'prime-agent')
    writeFileSync(primeExecutable, '#!/usr/bin/env node\nprocess.stderr.write("0.7.2\\n")\n')
    chmodSync(primeExecutable, 0o755)
    await expect(probeHarnessExecutable(primeExecutable)).resolves.toEqual({ runnable: true, version: '0.7.2' })
  })

  it('runs an official Bun-installed OMP shim under a Finder-style minimal PATH', async () => {
    const home = temp()
    const bunDirectory = join(home, '.bun', 'bin')
    mkdirSync(bunDirectory, { recursive: true })
    const executable = join(bunDirectory, 'omp')
    symlinkSync(process.execPath, join(bunDirectory, 'bun'))
    writeFileSync(executable, '#!/usr/bin/env bun\nprocess.stdout.write("17.3.4\\n")\n')
    chmodSync(executable, 0o755)

    const result = await runProcess(executable, ['--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('17.3.4\n')
  })

  it('runs a Bun XDG-cache OMP shim when bun is only in ~/.bun/bin', async () => {
    const home = temp()
    const bunDirectory = join(home, '.bun', 'bin')
    const cacheDirectory = join(home, '.cache', '.bun', 'bin')
    mkdirSync(bunDirectory, { recursive: true })
    mkdirSync(cacheDirectory, { recursive: true })
    const executable = join(cacheDirectory, 'omp')
    symlinkSync(process.execPath, join(bunDirectory, 'bun'))
    writeFileSync(executable, '#!/usr/bin/env bun\nprocess.stdout.write("18.0.6\\n")\n')
    chmodSync(executable, 0o755)

    const result = await runProcess(executable, ['--version'], {
      env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('18.0.6\n')
  })

  it('uses a combined output budget and explicitly reports truncation with independent kill escalation', async () => {
    const started = Date.now()
    const result = await runProcess(process.execPath, ['-e', `
process.on('SIGTERM', () => {})
process.stdout.write('o'.repeat(800))
process.stderr.write('e'.repeat(800))
setInterval(() => {}, 1000)
`], { timeoutMs: 10_000, maxBytes: 1_024 })

    expect(result.outputExceeded).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutBytes).toBe(800)
    expect(result.stderrBytes).toBe(800)
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1_024)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('globally bounds normal one-shot process concurrency', async () => {
    const dir = temp()
    const statePath = join(dir, 'state.json')
    const workerPath = join(dir, 'worker.cjs')
    writeFileSync(statePath, JSON.stringify({ active: 0, max: 0 }))
    writeFileSync(workerPath, `
const fs = require('node:fs')
const statePath = process.argv.at(-1)
const lockPath = statePath + '.lock'
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
const update = (delta) => {
  while (true) { try { fs.mkdirSync(lockPath); break } catch (error) { if (error.code !== 'EEXIST') throw error; pause() } }
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    state.active += delta
    state.max = Math.max(state.max, state.active)
    fs.writeFileSync(statePath, JSON.stringify(state))
  } finally { fs.rmdirSync(lockPath) }
}
update(1)
setTimeout(() => update(-1), 250)
`)

    const count = PROCESS_CONCURRENCY_LIMIT + 6
    const results = await Promise.all(Array.from({ length: count }, () => runProcess(process.execPath, [workerPath, statePath], { timeoutMs: 5_000 })))
    expect(results.every((result) => result.code === 0)).toBe(true)
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { active: number; max: number }
    expect(state.active).toBe(0)
    expect(state.max).toBeGreaterThan(1)
    expect(state.max).toBeLessThanOrEqual(PROCESS_CONCURRENCY_LIMIT)
  }, 15_000)

  it('closes queued admission and still terminates every active child during shutdown', async () => {
    const dir = temp()
    const active = Array.from({ length: PROCESS_CONCURRENCY_LIMIT }, (_, index) => runProcess(process.execPath, ['-e', `
const fs = require('node:fs')
process.on('SIGTERM', () => {})
fs.writeFileSync(process.argv.at(-1), String(process.pid))
setInterval(() => {}, 1000)
`, join(dir, `active-${index}`)], { timeoutMs: 30_000 }))
    await waitUntil(() => readdirSync(dir).filter((name) => name.startsWith('active-')).length === PROCESS_CONCURRENCY_LIMIT)

    const deniedMarker = join(dir, 'queued-ran')
    const queued = runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv.at(-1), 'unexpected')`, deniedMarker])
    const cleanup = stopChildProcesses()
    await expect(queued).rejects.toThrow(/admission is closed/)
    await cleanup
    const completed = await Promise.all(active)

    expect(completed.every((result) => result.signal === 'SIGKILL' || result.signal === 'SIGTERM')).toBe(true)
    expect(readdirSync(dir)).not.toContain('queued-ran')
  }, 15_000)
})

describe('processOutcome classification', () => {
  const result = (overrides: Partial<ProcessResult>): ProcessResult => ({
    code: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false, stdoutBytes: 0, stderrBytes: 0, ...overrides,
  })

  it('classifies overflow before timeout before exit status', () => {
    expect(processFailureReason(result({ outputExceeded: true, timedOut: true, code: 1 }))).toBe('overflow')
    expect(processFailureReason(result({ timedOut: true, code: 1 }))).toBe('timeout')
    expect(processFailureReason(result({ code: 1 }))).toBe('exit')
    expect(processFailureReason(result({}))).toBeUndefined()
  })

  it('folds results into the shared outcome shape', () => {
    expect(processOutcome(result({}), 'done')).toEqual({ ok: true, output: 'done' })
    expect(processOutcome(result({ code: 3 }), 'failed')).toEqual({ ok: false, output: 'failed', reason: 'exit' })
    expect(processOutcome(result({ timedOut: true }), '')).toEqual({ ok: false, output: '', reason: 'timeout' })
  })
})

describe('killProcessTree', () => {
  afterEach(() => vi.restoreAllMocks())

  it('escalates through the POSIX ladder over descendants, group, and direct handle until exit', async () => {
    const kills: Array<[number, NodeJS.Signals]> = []
    const direct: NodeJS.Signals[] = []
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: NodeJS.Signals) => {
      kills.push([pid, signal])
      return true
    }) as typeof process.kill)
    let exited = false
    const result = await killProcessTree(4_242, {
      platform: 'linux',
      ladder: [{ signal: 'SIGTERM', waitMs: 5 }, { signal: 'SIGKILL', waitMs: 5 }],
      descendants: [5_001],
      hasExited: () => exited,
      waitForExit: async () => { exited = kills.some(([, signal]) => signal === 'SIGKILL'); return exited },
      signalDirect: (signal) => direct.push(signal),
    })

    expect(result).toBe(true)
    expect(kills).toEqual([[5_001, 'SIGTERM'], [-4_242, 'SIGTERM'], [5_001, 'SIGKILL'], [-4_242, 'SIGKILL']])
    expect(direct).toEqual(['SIGTERM', 'SIGKILL'])
    kill.mockRestore()
  })

  it('stops before the first rung when the process already exited', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const result = await killProcessTree(4_242, {
      platform: 'linux',
      ladder: [{ signal: 'SIGTERM', waitMs: 5 }],
      hasExited: () => true,
    })

    expect(result).toBe(true)
    expect(kill).not.toHaveBeenCalled()
  })

  it('collapses the win32 ladder into one awaited taskkill /pid <pid> /T /F', async () => {
    const taskkillPids: number[] = []
    const direct: Array<NodeJS.Signals | undefined> = []
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    const result = await killProcessTree(7_777, {
      platform: 'win32',
      ladder: [{ signal: 'SIGTERM', waitMs: 350 }, { signal: 'SIGKILL', waitMs: 0 }],
      runTaskkill: async (pid) => { taskkillPids.push(pid) },
      signalDirect: (signal) => direct.push(signal),
    })

    expect(result).toBe(true)
    expect(taskkillPids).toEqual([7_777])
    expect(direct).toEqual(['SIGKILL'])
    expect(kill).not.toHaveBeenCalled()
  })

  it('reports win32 exit through the observer within the ladder budget', async () => {
    let exited = false
    const result = await killProcessTree(7_777, {
      platform: 'win32',
      ladder: [{ signal: 'SIGTERM', waitMs: 100 }],
      runTaskkill: async () => { exited = true },
      hasExited: () => exited,
    })

    expect(result).toBe(true)
  })

  it('terminates a real SIGTERM-resistant process through the ladder', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise((resolveReady) => child.stdout.once('data', resolveReady))

    const result = await killProcessTree(child.pid!, {
      ladder: [{ signal: 'SIGTERM', waitMs: 200 }, { signal: 'SIGKILL', waitMs: 3_000 }],
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      waitForExit: (timeoutMs) => waitForProcessExit(child, timeoutMs),
      signalDirect: (signal) => child.kill(signal),
    })

    expect(result).toBe(true)
    expect(child.signalCode).toBe('SIGKILL')
  }, 10_000)
})

describe('waitForProcessExit', () => {
  it('resolves immediately for an exited child and observes a later close within the timeout', async () => {
    const exited = spawn(process.execPath, ['-e', ''])
    await new Promise((resolveClose) => exited.once('close', resolveClose))
    await expect(waitForProcessExit(exited, 5)).resolves.toBe(true)

    const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120)'])
    await expect(waitForProcessExit(running, 10)).resolves.toBe(false)
    await expect(waitForProcessExit(running, 5_000)).resolves.toBe(true)
  }, 10_000)
})

describe('Prime Agent discovery candidates', () => {
  it('uses native executable names and absolute paths for every supported desktop platform', () => {
    expect(primeAgentExecutableName('darwin')).toBe('prime-agent')
    expect(primeAgentExecutableName('linux')).toBe('prime-agent')
    expect(primeAgentExecutableName('win32')).toBe('prime-agent.exe')
    expect(isAbsolutePathForPlatform('/opt/prime-agent', 'linux')).toBe(true)
    expect(isAbsolutePathForPlatform('C:\\Tools\\prime-agent.exe', 'win32')).toBe(true)
    expect(isAbsolutePathForPlatform('prime-agent.exe', 'win32')).toBe(false)
  })

  it('accepts explicit Windows binaries and searches the Windows PATH without speculative install locations', () => {
    const candidates = primeAgentCandidates({
      PRIME_AGENT_BINARY: 'C:\\Tools\\prime-agent.exe',
      Path: 'C:\\Program Files\\Prime Agent;D:\\bin',
      LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    }, 'win32')
    expect(candidates).toContain('C:\\Tools\\prime-agent.exe')
    expect(candidates).toContain('C:\\Program Files\\Prime Agent\\prime-agent.exe')
    expect(candidates).toContain('D:\\bin\\prime-agent.exe')
    expect(candidates).not.toContain('C:\\Users\\Ada\\AppData\\Local\\Programs\\Prime Agent\\prime-agent.exe')
  })
})

describe('OMP discovery candidates', () => {
  it('uses native executable names for every supported desktop platform', () => {
    expect(HARNESSES.omp.executableName('darwin')).toBe('omp')
    expect(HARNESSES.omp.executableName('linux')).toBe('omp')
    expect(HARNESSES.omp.executableName('win32')).toBe('omp.exe')
  })

  it('honors only absolute OMP_BINARY overrides and scans absolute PATH entries', () => {
    const relative = harnessExecutableCandidates(HARNESSES.omp, { OMP_BINARY: 'bin/omp', PATH: '/usr/bin:relative/bin' }, 'linux')
    expect(relative).not.toContain('bin/omp')
    expect(relative).not.toContain('relative/bin/omp')
    expect(relative).toContain('/usr/bin/omp')
    const absolute = harnessExecutableCandidates(HARNESSES.omp, { OMP_BINARY: '/opt/tools/omp', PATH: '/usr/bin' }, 'linux')
    expect(absolute[0]).toBe('/opt/tools/omp')
  })

  it('prefers a saved absolute override before the environment override', () => {
    const candidates = harnessExecutableCandidates(HARNESSES.omp, { OMP_BINARY: '/env/omp', PATH: '/usr/bin' }, 'linux', '/settings/omp')
    expect(candidates.slice(0, 2)).toEqual(['/settings/omp', '/env/omp'])
    expect(harnessExecutableCandidates(HARNESSES.omp, { OMP_BINARY: '/env/omp', PATH: '/usr/bin' }, 'linux', 'relative/omp')[0]).toBe('/env/omp')
  })

  it('searches shared package-manager and system locations independently of the configured shell', () => {
    const home = '/Users/Ada'
    for (const shell of ['/bin/bash', '/bin/zsh', '/opt/homebrew/bin/fish', undefined]) {
      const candidates = harnessExecutableCandidates(HARNESSES.omp, {
        PATH: '/usr/bin', SHELL: shell, BUN_INSTALL: '/Users/Ada/.bun', PNPM_HOME: '/Users/Ada/Library/pnpm', VOLTA_HOME: '/Users/Ada/.volta',
      }, 'darwin', undefined, home)
      expect(candidates).toContain('/Users/Ada/.local/bin/omp')
      expect(candidates).toContain('/Users/Ada/.bun/bin/omp')
      expect(candidates).toContain('/Users/Ada/.cache/.bun/bin/omp')
      expect(candidates).toContain('/Users/Ada/Library/pnpm/omp')
      expect(candidates).toContain('/Users/Ada/.volta/bin/omp')
      expect(candidates).toContain('/Users/Ada/.local/share/mise/shims/omp')
    }
    const candidates = harnessExecutableCandidates(HARNESSES.omp, { PATH: '/usr/bin' }, 'darwin', undefined, home)
    expect(candidates).toContain('/opt/homebrew/bin/omp')
    expect(candidates).toContain('/usr/local/bin/omp')
    expect(candidates).toContain('/Users/Ada/.cache/.bun/bin/omp')
    expect(candidates.every((candidate) => isAbsolutePathForPlatform(candidate, 'darwin'))).toBe(true)
    const xdgCache = harnessExecutableCandidates(HARNESSES.omp, {
      PATH: '/usr/bin', XDG_CACHE_HOME: '/var/cache',
    }, 'darwin', undefined, home)
    expect(xdgCache).toContain('/var/cache/.bun/bin/omp')
    expect(xdgCache).toContain('/Users/Ada/.cache/.bun/bin/omp')
  })

  it('finds official and Bun-installed Windows OMP executables despite a stale process Path', () => {
    const candidates = harnessExecutableCandidates(HARNESSES.omp, {
      Path: 'C:\\bin', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local', USERPROFILE: 'C:\\Users\\Ada', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
      BUN_INSTALL: 'D:\\Bun', BUN_INSTALL_BIN: 'E:\\Portable\\bun-global-bin', XDG_CACHE_HOME: 'D:\\Cache',
    }, 'win32', undefined, 'C:\\Users\\Ada')
    expect(candidates).toContain('C:\\bin\\omp.exe')
    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Local\\omp\\omp.exe')
    expect(candidates).toContain('C:\\Users\\Ada\\.bun\\bin\\omp.exe')
    expect(candidates).toContain('C:\\Users\\Ada\\.cache\\.bun\\bin\\omp.exe')
    expect(candidates).toContain('D:\\Cache\\.bun\\bin\\omp.exe')
    expect(candidates).toContain('D:\\Bun\\bin\\omp.exe')
    expect(candidates).toContain('E:\\Portable\\bun-global-bin\\omp.exe')
    expect(candidates.some((candidate) => candidate.includes('resources'))).toBe(false)
  })

  it('discovers only the official Pi npm command shim alongside native Windows executables', () => {
    const candidates = harnessExecutableCandidates(HARNESSES.pi, {
      Path: 'C:\\Windows', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
    }, 'win32', undefined, 'C:\\Users\\Ada')
    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Roaming\\npm\\pi.exe')
    expect(candidates).toContain('C:\\Users\\Ada\\AppData\\Roaming\\npm\\pi.cmd')
    expect(candidates.some((candidate) => candidate.endsWith('omp.cmd') || candidate.endsWith('prime-agent.cmd'))).toBe(false)
  })

  it('resolves the official Windows Pi npm shim to Node without invoking a shell', () => {
    const shim = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\pi.cmd'
    const entrypoint = 'C:\\Users\\Ada\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'
    const node = 'C:\\Program Files\\nodejs\\node.exe'
    const accessible = new Set([entrypoint.toLowerCase(), node.toLowerCase()])
    const invocation = prepareExecutableSpawn(shim, ['--version'], {
      Path: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      USERPROFILE: 'C:\\Users\\Ada',
    }, {
      platform: 'win32',
      home: 'C:\\Users\\Ada',
      canAccess: (candidate) => accessible.has(candidate.toLowerCase()),
    })

    expect(invocation.file).toBe(node)
    expect(invocation.args).toEqual([entrypoint, '--version'])
    expect(invocation.env.Path).toContain('C:\\Users\\Ada\\AppData\\Roaming\\npm')
  })

  it('rejects missing official Pi entrypoints without enabling arbitrary Windows shims', () => {
    expect(prepareExecutableSpawn('C:\\Tools\\omp.cmd', ['--version'], {}, { platform: 'win32' })).toMatchObject({
      file: 'C:\\Tools\\omp.cmd',
    })
    expect(() => prepareExecutableSpawn('C:\\Tools\\pi.cmd', ['--version'], {}, {
      platform: 'win32',
      home: 'C:\\Users\\Ada',
      canAccess: () => false,
    })).toThrow(/official Pi installation/)
  })

  it('keeps E2E discovery hermetic when a fixture executable disappears', async () => {
    const env = { PRIME_WORK_E2E_HIDE_WINDOWS: '1', PATH: '/fixture/bin' }
    expect(harnessExecutableCandidates(HARNESSES.pi, env, 'darwin', undefined, '/fixture/home')).toEqual(['/fixture/bin/pi'])
    await expect(nvmHarnessExecutableCandidates(HARNESSES.pi, env, 'darwin', '/fixture/home')).resolves.toEqual([])
  })

  it('adds official standalone-node locations for Pi and Prime on Linux', () => {
    const env = { PATH: '/usr/bin', XDG_DATA_HOME: '/data' }
    expect(harnessExecutableCandidates(HARNESSES.pi, env, 'linux', undefined, '/home/ada')).toContain('/data/pi-node/current/bin/pi')
    expect(harnessExecutableCandidates(HARNESSES.prime, env, 'linux', undefined, '/home/ada')).toContain('/data/prime-agent-node/current/bin/prime-agent')
    expect(harnessExecutableCandidates(HARNESSES.omp, env, 'linux', undefined, '/home/ada')).toContain('/home/linuxbrew/.linuxbrew/bin/omp')
  })

  it('boundedly discovers nvm installs without evaluating shell startup files', async () => {
    const home = temp()
    const versions = join(home, '.nvm', 'versions', 'node')
    for (const version of ['v20.1.0', 'v22.12.0', 'v23.0.0']) {
      mkdirSync(join(versions, version), { recursive: true })
    }
    await expect(nvmHarnessExecutableCandidates(HARNESSES.pi, {}, 'linux', home)).resolves.toEqual([
      join(versions, 'v23.0.0', 'bin', 'pi'),
      join(versions, 'v22.12.0', 'bin', 'pi'),
      join(versions, 'v20.1.0', 'bin', 'pi'),
    ])
  })
})

describe('runProcess stdio pipe failures', () => {
  interface FakeProcessChild extends EventEmitter {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough | null
    pid: number | undefined
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    killed: string[]
    kill(signal?: NodeJS.Signals): boolean
  }

  function fakeChild(): FakeProcessChild {
    const child = new EventEmitter() as FakeProcessChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = null
    child.pid = undefined
    child.exitCode = null
    child.signalCode = null
    child.killed = []
    child.kill = (signal?: NodeJS.Signals) => {
      child.killed.push(signal ?? 'SIGTERM')
      return true
    }
    return child
  }

  afterEach(() => { spawnOverride.current = null })

  // Earlier suites close the shared module's process admission via stopChildProcesses,
  // so these cases run against a fresh module instance.
  async function freshRunProcess(): Promise<typeof runProcess> {
    vi.resetModules()
    const module = await import('../../electron/main/process-utils')
    return module.runProcess
  }

  it('rejects the promise on a stdout pipe error without an uncaught exception or double-settle', async () => {
    const run = await freshRunProcess()
    const child = fakeChild()
    spawnOverride.current = () => child
    const uncaught: unknown[] = []
    const spy: NodeJS.UncaughtExceptionListener = (error) => { uncaught.push(error) }
    process.on('uncaughtException', spy)
    try {
      const pending = run('/fake/prime-agent', ['--version'], { timeoutMs: 5_000 })
      await waitUntil(() => child.stdout.listenerCount('error') > 0)
      const pipeError = new Error('read EPIPE')
      child.stdout.emit('error', pipeError)
      await expect(pending).rejects.toThrow('read EPIPE')
      expect(child.killed).toContain('SIGTERM')
      // A late close event must not settle the promise a second time.
      child.emit('close', null, 'SIGKILL')
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', spy)
    }
  })

  it('rejects the promise on a stderr pipe error and keeps admitting new work', async () => {
    const run = await freshRunProcess()
    const child = fakeChild()
    spawnOverride.current = () => child
    const pending = run('/fake/prime-agent', [], { timeoutMs: 5_000 })
    await waitUntil(() => child.stderr.listenerCount('error') > 0)
    child.stderr.emit('error', new Error('read ECONNRESET'))
    await expect(pending).rejects.toThrow('read ECONNRESET')
    spawnOverride.current = null
    const result = await run(process.execPath, ['-e', 'process.stdout.write("still-alive")'], { timeoutMs: 10_000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('still-alive')
  })
})
