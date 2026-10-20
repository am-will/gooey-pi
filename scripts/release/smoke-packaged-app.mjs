#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { findUnpackedDirectory, packagedExecutablePath } from './verify-cross-platform-package.mjs'

/**
 * Functional launch smoke for a packaged Linux or Windows build: the real
 * unpacked executable is started with an isolated user-data directory and must
 * report renderer readiness through the documented `--packaged-smoke` marker
 * before a single bounded deadline elapses. The structural verifier proves the
 * package's shape; this proves the package actually boots main, preload and the
 * trusted renderer. Contract values are asserted against
 * electron/main/packaged-smoke.ts by tests/packaged-smoke.test.ts.
 */
export const PACKAGED_SMOKE_FLAG = '--packaged-smoke='
export const PACKAGED_SMOKE_READY_EVENT = 'gooeypi-packaged-smoke-ready'
export const MAX_MARKER_BYTES = 4 * 1024
export const MAX_DIAGNOSTICS_BYTES = 64 * 1024
export const SMOKE_TIMEOUT_MS = 45_000

/** Headless CI runners have no display, so the Linux executable runs under Xvfb. */
export function launchCommand(executable, args, { platform = process.platform, display = process.env.DISPLAY } = {}) {
  if (platform !== 'linux' || display) return { command: executable, args }
  return { command: 'xvfb-run', args: ['--auto-servernum', '--server-args=-screen 0 1280x720x24', executable, ...args] }
}

export function smokeArguments(markerPath, userDataDirectory) {
  return [`${PACKAGED_SMOKE_FLAG}${markerPath}`, `--user-data-dir=${userDataDirectory}`]
}

/**
 * Windows has no process groups, so an orphaned Electron tree is reaped with
 * taskkill; POSIX launches are detached and killed by process group.
 */
export function killTreeCommand(pid, platform = process.platform) {
  return platform === 'win32' ? { command: 'taskkill', args: ['/T', '/F', '/PID', String(pid)] } : null
}

export function killProcessTree(child, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  const taskkill = killTreeCommand(child.pid, platform)
  if (taskkill) {
    spawn(taskkill.command, taskkill.args, { stdio: 'ignore' }).unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** The readiness marker the packaged application wrote; its renderer URL is validated against the shared contract inside the application before the marker is created. */
export function parseReadinessMarker(raw) {
  if (Buffer.byteLength(raw, 'utf8') > MAX_MARKER_BYTES) throw new Error(`Readiness marker exceeds ${MAX_MARKER_BYTES} bytes`)
  let marker
  try {
    marker = JSON.parse(raw)
  } catch {
    throw new Error('Readiness marker is not valid JSON')
  }
  if (!marker || typeof marker !== 'object') throw new Error('Readiness marker is not an object')
  if (marker.event !== PACKAGED_SMOKE_READY_EVENT) throw new Error(`Readiness marker reported an unexpected event: ${String(marker.event)}`)
  if (typeof marker.version !== 'string' || !marker.version) throw new Error('Readiness marker is missing the application version')
  if (typeof marker.url !== 'string') throw new Error('Readiness marker is missing the renderer URL')
  let url
  try {
    url = new URL(marker.url)
  } catch {
    throw new Error(`Readiness marker reported an invalid renderer URL: ${marker.url}`)
  }
  return { event: marker.event, url: url.href, version: marker.version }
}

/** Diagnostics are a bounded tail: a failing launch can log without limit, and the artifact must stay small enough to upload. */
export function boundedDiagnostics(chunks, maxBytes = MAX_DIAGNOSTICS_BYTES) {
  const text = chunks.join('')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const ellipsis = '…'
  const budget = maxBytes - Buffer.byteLength(ellipsis, 'utf8')
  let tail = Buffer.from(text, 'utf8').subarray(-budget).toString('utf8')
  // A tail cut inside a multi-byte sequence decodes to a wider replacement character.
  while (Buffer.byteLength(tail, 'utf8') > budget) tail = tail.slice(1)
  return `${ellipsis}${tail}`
}

/** Written for every failure so the CI artifact upload always has its file. */
function writeDiagnostics(report, body) {
  try {
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, boundedDiagnostics([body]), { encoding: 'utf8' })
  } catch (error) {
    console.error(`Could not write packaged smoke diagnostics to ${report}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readMarker(markerPath) {
  if (!existsSync(markerPath)) throw new Error('Packaged application exited without reporting renderer readiness')
  const size = statSync(markerPath).size
  if (size > MAX_MARKER_BYTES) throw new Error(`Readiness marker exceeds ${MAX_MARKER_BYTES} bytes`)
  return parseReadinessMarker(readFileSync(markerPath, 'utf8'))
}

function runPackagedApp(executable, args, { cwd, timeoutMs, platform = process.platform }) {
  const { command, args: launchArgs } = launchCommand(executable, args, { platform })
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, launchArgs, {
      cwd,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Renderer console output lands on stderr so a failing launch is diagnosable from the log alone.
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    })
    const chunks = []
    const collect = (chunk) => {
      chunks.push(String(chunk))
      // Bound memory even for a runaway logger; the tail is what diagnoses a failure.
      if (chunks.length > 512) chunks.splice(0, chunks.length - 512)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      killProcessTree(child, platform)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(deadline)
      killProcessTree(child, platform)
      rejectPromise(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      killProcessTree(child, platform)
      resolvePromise({ code, signal, timedOut, diagnostics: boundedDiagnostics(chunks), command, args: launchArgs })
    })
  })
}

export async function smokePackagedApp(target, architecture, { timeoutMs = SMOKE_TIMEOUT_MS, diagnosticsPath = '' } = {}) {
  const outputDirectory = resolve('release', target, architecture)
  const report = diagnosticsPath || join(outputDirectory, 'packaged-smoke-diagnostics.log')
  let workspace = ''
  let launch = null
  try {
    const unpacked = findUnpackedDirectory(outputDirectory, target)
    const executable = packagedExecutablePath(unpacked, target)
    workspace = mkdtempSync(join(tmpdir(), 'gooeypi-packaged-smoke-'))
    const markerPath = join(workspace, 'ready.json')
    launch = await runPackagedApp(executable, smokeArguments(markerPath, join(workspace, 'user-data')), { cwd: unpacked, timeoutMs })
    if (launch.timedOut) throw new Error(`Packaged application did not report renderer readiness within ${timeoutMs}ms`)
    if (launch.code !== 0) throw new Error(`Packaged application exited with code ${launch.code ?? 'null'} (signal ${launch.signal ?? 'none'})`)
    const marker = readMarker(markerPath)
    console.log(`Smoked ${target}/${architecture} packaged application: ${executable} reported ${marker.event} for ${marker.url} (version ${marker.version}).`)
    return marker
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const launched = launch
      ? `${launch.command} ${launch.args.join(' ')}\nexit code: ${launch.code ?? 'null'}\nsignal: ${launch.signal ?? 'none'}\ntimed out: ${launch.timedOut}\n\n${launch.diagnostics}\n\n`
      : ''
    writeDiagnostics(report, `${launched}${message}\n`)
    throw new Error(`${message} (diagnostics: ${report})`)
  } finally {
    // The isolated user data and marker never outlive the smoke, however it ended.
    if (workspace) rmSync(workspace, { recursive: true, force: true })
  }
}

function requireOption(value, label, allowed) {
  if (!value || !allowed.includes(value)) throw new Error(`${label} must be one of: ${allowed.join(', ')}`)
  return value
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ strict: true, allowPositionals: false, options: { platform: { type: 'string' }, arch: { type: 'string' }, diagnostics: { type: 'string' } } })
    await smokePackagedApp(requireOption(values.platform, 'platform', ['linux', 'win']), requireOption(values.arch, 'arch', ['arm64', 'x64']), {
      diagnosticsPath: values.diagnostics ?? '',
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
