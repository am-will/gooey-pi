import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  EXPECTED_PACKAGED_RENDERER_URL,
  MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES,
  MAX_PACKAGED_SMOKE_READY_BYTES,
  PACKAGED_SMOKE_READY_FILE,
  buildPackagedSmokeInvocation,
  findPackagedExecutable,
  launchPackagedSmoke,
} from '../scripts/release/smoke-packaged-app.mjs'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function packagedFixture(target: 'linux' | 'win') {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'gooeypi-packaged-smoke-test-'))
  fixtures.push(outputDirectory)
  const unpacked = join(outputDirectory, `${target}-unpacked`)
  mkdirSync(unpacked, { recursive: true })
  const executable = join(unpacked, target === 'win' ? 'GooeyPi.exe' : 'gooeypi')
  writeFileSync(executable, 'fixture')
  if (target === 'linux') chmodSync(executable, 0o755)
  return { executable, outputDirectory, unpacked }
}

interface FakeChild extends EventEmitter {
  pid: number
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = 42_424
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

function userDataFrom(args: readonly string[]): string {
  const argument = args.find((value) => value.startsWith('--user-data-dir='))
  if (!argument) throw new Error('fake launch did not receive an isolated user-data directory')
  return argument.slice('--user-data-dir='.length)
}

function readyResult(url = EXPECTED_PACKAGED_RENDERER_URL) {
  return { event: 'gooeypi-packaged-smoke-ready', url, preload: true, renderer: true }
}

describe('packaged executable discovery', () => {
  test('selects the actual Windows and Linux executable from exactly one unpacked application', () => {
    const windows = packagedFixture('win')
    const linux = packagedFixture('linux')

    expect(findPackagedExecutable(windows.outputDirectory, 'win')).toBe(windows.executable)
    expect(findPackagedExecutable(linux.outputDirectory, 'linux')).toBe(linux.executable)
  })

  test('fails closed for missing, ambiguous, or non-executable unpacked applications', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gooeypi-packaged-smoke-empty-'))
    fixtures.push(empty)
    expect(() => findPackagedExecutable(empty, 'linux')).toThrow(/exactly one linux unpacked application/i)

    const ambiguous = packagedFixture('linux')
    mkdirSync(join(ambiguous.outputDirectory, 'linux-second-unpacked'))
    expect(() => findPackagedExecutable(ambiguous.outputDirectory, 'linux')).toThrow(/found 2/i)

    const nonExecutable = packagedFixture('linux')
    chmodSync(nonExecutable.executable, 0o644)
    expect(() => findPackagedExecutable(nonExecutable.outputDirectory, 'linux')).toThrow(/not executable/i)
  })

  test('uses a headless display only when Linux has no display and never invokes a shell', () => {
    const linux = buildPackagedSmokeInvocation('/app/gooeypi', 'linux', '/tmp/profile', {})
    expect(linux).toEqual({
      file: 'xvfb-run',
      args: [
        '--auto-servernum',
        '--server-args=-screen 0 1280x720x24',
        '/app/gooeypi',
        '--gooeypi-packaged-smoke',
        '--gooeypi-packaged-smoke-user-data=/tmp/profile',
        '--user-data-dir=/tmp/profile',
        '--disable-gpu',
      ],
    })
    expect(buildPackagedSmokeInvocation('C:\\GooeyPi.exe', 'win', 'C:\\profile', {})).toEqual({
      file: 'C:\\GooeyPi.exe',
      args: ['--gooeypi-packaged-smoke', '--gooeypi-packaged-smoke-user-data=C:\\profile', '--user-data-dir=C:\\profile', '--disable-gpu'],
    })
  })
})

describe('packaged smoke launcher', () => {
  test('accepts only a clean exit after the trusted renderer and preload result is written', async () => {
    const fixture = packagedFixture('win')
    const diagnosticsPath = join(fixture.outputDirectory, 'packaged-smoke.log')
    let userData = ''
    const terminateProcessTree = vi.fn(async () => undefined)
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = fakeChild()
      userData = userDataFrom(args)
      queueMicrotask(() => {
        writeFileSync(join(userData, PACKAGED_SMOKE_READY_FILE), `${JSON.stringify(readyResult())}\n`)
        child.stdout.end('renderer ready\n')
        child.emit('close', 0, null)
      })
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath,
          outputDirectory: fixture.outputDirectory,
          target: 'win',
          timeoutMs: 100,
        },
        { spawn, terminateProcessTree },
      ),
    ).resolves.toEqual(readyResult())

    expect(spawn).toHaveBeenCalledWith(fixture.executable, expect.arrayContaining(['--gooeypi-packaged-smoke']), expect.objectContaining({ detached: true, shell: false, windowsHide: true }))
    expect(terminateProcessTree).toHaveBeenCalledWith(expect.objectContaining({ pid: 42_424 }), 'win32')
    expect(existsSync(userData)).toBe(false)
    expect(readFileSync(diagnosticsPath, 'utf8')).toMatch(/status: passed[\s\S]*renderer ready/)
  })

  test('rejects an early zero exit without a readiness result', async () => {
    const fixture = packagedFixture('win')
    const spawn = vi.fn(() => {
      const child = fakeChild()
      queueMicrotask(() => child.emit('close', 0, null))
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath: join(fixture.outputDirectory, 'packaged-smoke.log'),
          outputDirectory: fixture.outputDirectory,
          target: 'win',
          timeoutMs: 100,
        },
        { spawn, terminateProcessTree: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/exited with code 0 before trusted renderer readiness/i)
  })

  test('rejects a non-zero exit even after readiness was reported', async () => {
    const fixture = packagedFixture('win')
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = fakeChild()
      queueMicrotask(() => {
        const userData = userDataFrom(args)
        writeFileSync(join(userData, PACKAGED_SMOKE_READY_FILE), JSON.stringify(readyResult()))
        child.emit('close', 23, null)
      })
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath: join(fixture.outputDirectory, 'packaged-smoke.log'),
          outputDirectory: fixture.outputDirectory,
          target: 'win',
          timeoutMs: 100,
        },
        { spawn, terminateProcessTree: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/exited with code 23 after reporting readiness/i)
  })

  test('rejects a result from the wrong renderer URL', async () => {
    const fixture = packagedFixture('win')
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = fakeChild()
      queueMicrotask(() => {
        const userData = userDataFrom(args)
        writeFileSync(join(userData, PACKAGED_SMOKE_READY_FILE), JSON.stringify(readyResult('https://attacker.test/')))
        child.emit('close', 0, null)
      })
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath: join(fixture.outputDirectory, 'packaged-smoke.log'),
          outputDirectory: fixture.outputDirectory,
          target: 'win',
          timeoutMs: 100,
        },
        { spawn, terminateProcessTree: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/unexpected renderer URL/i)
  })

  test('rejects an oversized readiness marker before parsing it', async () => {
    const fixture = packagedFixture('win')
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = fakeChild()
      queueMicrotask(() => {
        const userData = userDataFrom(args)
        writeFileSync(join(userData, PACKAGED_SMOKE_READY_FILE), JSON.stringify({ ...readyResult(), padding: 'x'.repeat(MAX_PACKAGED_SMOKE_READY_BYTES) }))
        child.emit('close', 0, null)
      })
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath: join(fixture.outputDirectory, 'packaged-smoke.log'),
          outputDirectory: fixture.outputDirectory,
          target: 'win',
          timeoutMs: 100,
        },
        { spawn, terminateProcessTree: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow(/readiness marker exceeds/i)
  })

  test('times out, captures bounded logs, terminates the process tree, and removes temporary state', async () => {
    const fixture = packagedFixture('linux')
    const diagnosticsPath = join(fixture.outputDirectory, 'packaged-smoke.log')
    const terminateProcessTree = vi.fn(async () => undefined)
    let userData = ''
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      const child = fakeChild()
      userData = userDataFrom(args)
      queueMicrotask(() => {
        child.stdout.write('discard-me\n'.repeat(20_000))
        child.stderr.write('discard-me-too\n'.repeat(20_000))
        child.stdout.write('stdout-tail\n')
        child.stderr.write('stderr-tail\n')
      })
      return child
    })

    await expect(
      launchPackagedSmoke(
        {
          diagnosticsPath,
          env: {},
          outputDirectory: fixture.outputDirectory,
          target: 'linux',
          timeoutMs: 10,
        },
        { spawn, terminateProcessTree },
      ),
    ).rejects.toThrow(/timed out after 10 ms/i)

    expect(terminateProcessTree).toHaveBeenCalledWith(expect.objectContaining({ pid: 42_424 }), 'linux')
    expect(existsSync(userData)).toBe(false)
    const diagnostics = readFileSync(diagnosticsPath, 'utf8')
    expect(diagnostics).toContain('status: failed')
    expect(diagnostics).toContain('failure: Packaged linux application timed out after 10 ms')
    expect(diagnostics).toContain('--- stdout ---')
    expect(diagnostics).toContain('--- stderr ---')
    expect(diagnostics).toContain('[truncated to the last')
    expect(diagnostics).toContain('stdout-tail')
    expect(diagnostics).toContain('stderr-tail')
    expect(statSync(diagnosticsPath).size).toBeLessThanOrEqual(MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES)
  })
})
