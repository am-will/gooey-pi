import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  MAX_PACKAGED_SMOKE_MARKER_BYTES,
  PACKAGED_RENDERER_URL,
  PACKAGED_SMOKE_FLAG,
  PACKAGED_SMOKE_READY_EVENT,
  packagedSmokeMarker,
  packagedSmokeMarkerPath,
  serializePackagedSmokeMarker,
} from '../electron/main/packaged-smoke'
import * as launcher from '../scripts/release/smoke-packaged-app.mjs'

describe('packaged smoke contract', () => {
  it('agrees with the launcher on every shared value', () => {
    expect(launcher.PACKAGED_SMOKE_FLAG).toBe(PACKAGED_SMOKE_FLAG)
    expect(launcher.PACKAGED_SMOKE_READY_EVENT).toBe(PACKAGED_SMOKE_READY_EVENT)
    expect(launcher.MAX_MARKER_BYTES).toBe(MAX_PACKAGED_SMOKE_MARKER_BYTES)
  })

  it('produces a marker the launcher accepts', () => {
    const marker = serializePackagedSmokeMarker(packagedSmokeMarker(PACKAGED_RENDERER_URL, '1.2.3'))
    expect(launcher.parseReadinessMarker(marker)).toEqual({ event: PACKAGED_SMOKE_READY_EVENT, url: PACKAGED_RENDERER_URL, version: '1.2.3' })
  })

  it('keeps the packaged renderer URL a single source of truth in the main process', () => {
    const main = readFileSync(resolve('electron/main/index.ts'), 'utf8')
    expect(main).toContain('PACKAGED_RENDERER_URL')
    expect(main).not.toContain(`'${PACKAGED_RENDERER_URL}'`)
  })

  it('refuses to report readiness for a URL the main process does not serve', () => {
    expect(() => packagedSmokeMarker('prime-work://app/other.html', '1.2.3')).toThrow('unexpected renderer URL')
  })

  it('caps the marker payload', () => {
    expect(() => serializePackagedSmokeMarker({ event: PACKAGED_SMOKE_READY_EVENT, url: PACKAGED_RENDERER_URL, version: 'v'.repeat(MAX_PACKAGED_SMOKE_MARKER_BYTES) })).toThrow('byte limit')
  })
})

describe('packaged smoke argument parsing', () => {
  it('reads an absolute marker path', () => {
    expect(packagedSmokeMarkerPath(['gooeypi', `${PACKAGED_SMOKE_FLAG}/tmp/ready.json`])).toBe('/tmp/ready.json')
  })

  it('stays inactive without the flag', () => {
    expect(packagedSmokeMarkerPath(['gooeypi', '--user-data-dir=/tmp/data'])).toBeNull()
  })

  it('rejects ambiguous, relative, empty, and multi-line marker paths', () => {
    expect(() => packagedSmokeMarkerPath(['gooeypi', `${PACKAGED_SMOKE_FLAG}/tmp/a.json`, `${PACKAGED_SMOKE_FLAG}/tmp/b.json`])).toThrow('exactly one')
    expect(() => packagedSmokeMarkerPath(['gooeypi', `${PACKAGED_SMOKE_FLAG}ready.json`])).toThrow('absolute single-line')
    expect(() => packagedSmokeMarkerPath(['gooeypi', PACKAGED_SMOKE_FLAG])).toThrow('absolute single-line')
    expect(() => packagedSmokeMarkerPath(['gooeypi', `${PACKAGED_SMOKE_FLAG}/tmp/ready.json\n/etc/passwd`])).toThrow('absolute single-line')
  })
})

describe('packaged smoke launcher invocation', () => {
  it('runs the executable directly when a display is available', () => {
    expect(launcher.launchCommand('/app/gooeypi', ['--flag'], { platform: 'linux', display: ':0' })).toEqual({ command: '/app/gooeypi', args: ['--flag'] })
    expect(launcher.launchCommand('C:\\app\\GooeyPi.exe', ['--flag'], { platform: 'win32', display: '' })).toEqual({ command: 'C:\\app\\GooeyPi.exe', args: ['--flag'] })
  })

  it('wraps a headless Linux launch in a virtual display', () => {
    expect(launcher.launchCommand('/app/gooeypi', ['--flag'], { platform: 'linux', display: '' })).toEqual({
      command: 'xvfb-run',
      args: ['--auto-servernum', '--server-args=-screen 0 1280x720x24', '/app/gooeypi', '--flag'],
    })
  })

  it('passes only the smoke marker and an isolated user-data directory', () => {
    expect(launcher.smokeArguments('/tmp/ready.json', '/tmp/user-data')).toEqual([`${PACKAGED_SMOKE_FLAG}/tmp/ready.json`, '--user-data-dir=/tmp/user-data'])
  })

  it('kills the whole Windows process tree and uses process groups elsewhere', () => {
    expect(launcher.killTreeCommand(4321, 'win32')).toEqual({ command: 'taskkill', args: ['/T', '/F', '/PID', '4321'] })
    expect(launcher.killTreeCommand(4321, 'linux')).toBeNull()
  })

  it('kills a leftover POSIX process group even after its leader exited', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const exited = { pid: 4321, exitCode: 0, signalCode: null, kill: vi.fn() }
      launcher.killProcessTree(exited, 'linux')
      expect(kill).toHaveBeenCalledWith(-4321, 'SIGKILL')

      kill.mockClear()
      launcher.killProcessTree({ pid: undefined, exitCode: null, signalCode: null, kill: vi.fn() }, 'linux')
      // An exited Windows child has no tree taskkill could still reach.
      launcher.killProcessTree({ pid: 4321, exitCode: 0, signalCode: null, kill: vi.fn() }, 'win32')
      expect(kill).not.toHaveBeenCalled()

      kill.mockImplementation(() => {
        throw Object.assign(new Error('no such process group'), { code: 'ESRCH' })
      })
      launcher.killProcessTree(exited, 'linux')
      expect(exited.kill).not.toHaveBeenCalled()
      const running = { pid: 4321, exitCode: null, signalCode: null, kill: vi.fn() }
      launcher.killProcessTree(running, 'linux')
      expect(running.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      kill.mockRestore()
    }
  })

  it('bounds captured diagnostics to their tail', () => {
    expect(launcher.boundedDiagnostics(['abcdefghi'], 6)).toBe('…ghi')
    expect(launcher.boundedDiagnostics(['abc'], 8)).toBe('abc')
    // The bound is bytes, not characters, so multi-byte output cannot exceed it.
    expect(Buffer.byteLength(launcher.boundedDiagnostics(['é'.repeat(64)], 32), 'utf8')).toBeLessThanOrEqual(32)
  })
})

describe('packaged smoke marker validation', () => {
  const valid = { event: PACKAGED_SMOKE_READY_EVENT, url: PACKAGED_RENDERER_URL, version: '1.2.3' }

  it('rejects malformed, oversized, and untrusted markers', () => {
    expect(() => launcher.parseReadinessMarker('not json')).toThrow('not valid JSON')
    expect(() => launcher.parseReadinessMarker('"ready"')).toThrow('not an object')
    expect(() => launcher.parseReadinessMarker(JSON.stringify({ ...valid, event: 'something-else' }))).toThrow('unexpected event')
    expect(() => launcher.parseReadinessMarker(JSON.stringify({ ...valid, version: '' }))).toThrow('application version')
    expect(() => launcher.parseReadinessMarker(JSON.stringify({ ...valid, url: 'app/index.html' }))).toThrow('invalid renderer URL')
    expect(() => launcher.parseReadinessMarker(JSON.stringify({ ...valid, version: 'v'.repeat(launcher.MAX_MARKER_BYTES) }))).toThrow('exceeds')
  })
})

describe('packaged smoke launch', () => {
  const workingDirectory = process.cwd()
  let sandbox: string
  let unpacked: string

  const writeFakeApplication = (script: string): void => {
    const executable = join(unpacked, 'gooeypi')
    writeFileSync(executable, `#!/usr/bin/env bash\nset -euo pipefail\n${script}\n`, { encoding: 'utf8' })
    chmodSync(executable, 0o755)
  }

  const launchArguments =
    'for argument in "$@"; do case "$argument" in --packaged-smoke=*) marker="${argument#--packaged-smoke=}";; --user-data-dir=*) userData="${argument#--user-data-dir=}";; esac; done'
  const mirrorScheduleSkill = `mkdir -p "$(dirname "$userData/${launcher.MIRRORED_SCHEDULE_SKILL}")"\n: > "$userData/${launcher.MIRRORED_SCHEDULE_SKILL}"`
  const reportReadiness = `printf '{"event":"${PACKAGED_SMOKE_READY_EVENT}","url":"${PACKAGED_RENDERER_URL}","version":"9.9.9"}' > "$marker"`

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'gooeypi-smoke-test-'))
    unpacked = join(sandbox, 'release', 'linux', 'x64', 'linux-unpacked')
    mkdirSync(unpacked, { recursive: true })
    // The launcher resolves the release tree relative to the working directory,
    // and a fake executable keeps these cases independent of a real package.
    process.chdir(sandbox)
    process.env.DISPLAY = process.env.DISPLAY || ':0'
  })

  afterAll(() => {
    process.chdir(workingDirectory)
    rmSync(sandbox, { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(sandbox, 'release', 'linux', 'x64', 'packaged-smoke-diagnostics.log'), { force: true })
  })

  const temporaryWorkspaces = (): string[] => readdirSync(tmpdir()).filter((name) => name.startsWith('gooeypi-packaged-smoke-'))

  it('accepts an application that reports readiness and leaves no temporary state', async () => {
    writeFakeApplication(`${launchArguments}\n${mirrorScheduleSkill}\n${reportReadiness}`)
    const before = temporaryWorkspaces()

    await expect(launcher.smokePackagedApp('linux', 'x64')).resolves.toEqual({ event: PACKAGED_SMOKE_READY_EVENT, url: PACKAGED_RENDERER_URL, version: '9.9.9' })

    expect(temporaryWorkspaces()).toEqual(before)
  })

  it('fails when the application exits without reporting readiness, and writes bounded diagnostics', async () => {
    writeFakeApplication('echo "renderer failed to load" >&2\nexit 3')

    await expect(launcher.smokePackagedApp('linux', 'x64')).rejects.toThrow('exited with code 3')

    const diagnostics = readFileSync(join(sandbox, 'release', 'linux', 'x64', 'packaged-smoke-diagnostics.log'), 'utf8')
    expect(diagnostics).toContain('renderer failed to load')
    expect(diagnostics).toContain('exit code: 3')
  })

  it('fails when a started application never reports readiness', async () => {
    writeFakeApplication(`${launchArguments}\nexit 0`)

    await expect(launcher.smokePackagedApp('linux', 'x64')).rejects.toThrow('exited without reporting renderer readiness')
  })

  it('fails when a ready application left its schedule skill only in the bundle', async () => {
    writeFakeApplication(`${launchArguments}\n${reportReadiness}`)

    await expect(launcher.smokePackagedApp('linux', 'x64')).rejects.toThrow('did not mirror its bundled schedule skill')
  })

  it('kills a hung application at its deadline instead of waiting for it', async () => {
    const survived = join(sandbox, 'survived-the-deadline')
    writeFakeApplication(`sleep 30\ntouch ${survived}`)
    const before = temporaryWorkspaces()

    await expect(launcher.smokePackagedApp('linux', 'x64', { timeoutMs: 750 })).rejects.toThrow('did not report renderer readiness within 750ms')

    expect(readdirSync(sandbox)).not.toContain('survived-the-deadline')
    expect(temporaryWorkspaces()).toEqual(before)
  })

  it('does not wait for a helper that keeps the output pipes open after the application exits', async () => {
    const helperPid = join(sandbox, 'helper.pid')
    writeFakeApplication(
      `${launchArguments}\n${mirrorScheduleSkill}\n${reportReadiness}\nsleep 30 >&2 &\necho $! > ${helperPid}\nexit 0`,
    )
    const started = Date.now()

    await expect(launcher.smokePackagedApp('linux', 'x64', { timeoutMs: 10_000, exitGraceMs: 200 })).resolves.toMatchObject({ version: '9.9.9' })

    expect(Date.now() - started).toBeLessThan(5_000)
    // The helper shared the application's process group, so it was killed rather than left running.
    const pid = Number(readFileSync(helperPid, 'utf8'))
    const running = () => {
      try {
        process.kill(pid, 0)
      } catch {
        return false
      }
      // A killed orphan stays a zombie until its new parent reaps it, which a
      // container init that never calls wait() may not do.
      const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
      if (ps.error) throw ps.error
      return !ps.stdout.trim().startsWith('Z')
    }
    await vi.waitFor(() => expect(running()).toBe(false))
  }, 15_000)

  it('reports a missing packaged executable rather than launching something else', async () => {
    rmSync(join(unpacked, 'gooeypi'), { force: true })

    await expect(launcher.smokePackagedApp('linux', 'x64')).rejects.toThrow('missing its executable')

    // Every failure leaves the diagnostics artifact CI uploads.
    expect(readFileSync(join(sandbox, 'release', 'linux', 'x64', 'packaged-smoke-diagnostics.log'), 'utf8')).toContain('missing its executable')
  })
})
