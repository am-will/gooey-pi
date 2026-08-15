#!/usr/bin/env node
import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { lstatSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXPECTED_PACKAGED_RENDERER_URL = 'prime-work://app/index.html'
export const PACKAGED_SMOKE_READY_FILE = 'packaged-smoke-ready.json'
export const MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES = 64 * 1024
export const MAX_PACKAGED_SMOKE_READY_BYTES = 4 * 1024
const PACKAGED_SMOKE_READY_EVENT = 'gooeypi-packaged-smoke-ready'
// Reserve the remaining 16 KiB for bounded metadata, section labels, and
// truncation notices so the complete diagnostic—not each stream—fits 64 KiB.
const MAX_CAPTURE_BYTES = 48 * 1024
const DEFAULT_TIMEOUT_MS = 45_000

function requireTarget(value) {
  if (value !== 'linux' && value !== 'win') throw new Error('Packaged smoke platform must be linux or win')
  return value
}

function requireTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new Error('Packaged smoke timeout must be between 1 and 120000 ms')
  return value
}

function findUnpackedDirectory(outputDirectory, target) {
  const matches = readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(target) && entry.name.endsWith('-unpacked'))
    .map((entry) => join(outputDirectory, entry.name))
  if (matches.length !== 1) throw new Error(`Expected exactly one ${target} unpacked application, found ${matches.length}`)
  return matches[0]
}

export function findPackagedExecutable(outputDirectory, targetValue) {
  const target = requireTarget(targetValue)
  const unpackedDirectory = findUnpackedDirectory(resolve(outputDirectory), target)
  const executable = join(unpackedDirectory, target === 'win' ? 'GooeyPi.exe' : 'gooeypi')
  let stat
  try {
    stat = lstatSync(executable)
  } catch {
    throw new Error(`Packaged ${target} executable is missing: ${executable}`)
  }
  if (!stat.isFile()) throw new Error(`Packaged ${target} executable is not a regular file: ${executable}`)
  if (target === 'linux') {
    if ((stat.mode & 0o111) === 0) throw new Error(`Packaged Linux executable is not executable: ${executable}`)
  }
  return executable
}

export function buildPackagedSmokeInvocation(executable, targetValue, userDataDirectory, env = process.env) {
  const target = requireTarget(targetValue)
  const applicationArgs = ['--gooeypi-packaged-smoke', `--gooeypi-packaged-smoke-user-data=${userDataDirectory}`, `--user-data-dir=${userDataDirectory}`, '--disable-gpu']
  if (target === 'linux' && !env.DISPLAY) {
    return {
      file: 'xvfb-run',
      args: ['--auto-servernum', '--server-args=-screen 0 1280x720x24', executable, ...applicationArgs],
    }
  }
  return { file: executable, args: applicationArgs }
}

function createCombinedLogCapture(maxBytes = MAX_CAPTURE_BYTES) {
  const perStreamBytes = Math.floor(maxBytes / 2)
  const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  const totals = { stdout: 0, stderr: 0 }
  return {
    add(stream, chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      totals[stream] = Math.min(Number.MAX_SAFE_INTEGER, totals[stream] + bytes.length)
      if (bytes.length >= perStreamBytes) {
        buffers[stream] = bytes.subarray(bytes.length - perStreamBytes)
        return
      }
      const retained = buffers[stream]
      const retainedBudget = perStreamBytes - bytes.length
      buffers[stream] = Buffer.concat([retained.subarray(Math.max(0, retained.length - retainedBudget)), bytes])
    },
    format(stream) {
      const buffer = buffers[stream]
      const prefix = totals[stream] > buffer.length ? Buffer.from(`[truncated to the last ${buffer.length} of ${totals[stream]} bytes]\n`) : Buffer.alloc(0)
      return Buffer.concat([prefix, buffer])
    },
  }
}

function boundedDiagnosticValue(value, maxBytes) {
  const normalized = String(value).replace(/[\r\n]+/g, ' ')
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized
  const suffix = ' ... [truncated]'
  let low = 0
  let high = normalized.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(`${normalized.slice(0, middle)}${suffix}`, 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return `${normalized.slice(0, low)}${suffix}`
}

function packagedSmokeDiagnostics({ target, executable, invocation, outcome, failure, output }) {
  const diagnostics = Buffer.concat([
    Buffer.from(`status: ${failure ? 'failed' : 'passed'}\n`),
    Buffer.from(`target: ${target}\n`),
    Buffer.from(`executable: ${boundedDiagnosticValue(executable || 'not discovered', 2 * 1024)}\n`),
    Buffer.from(`invocation: ${boundedDiagnosticValue(invocation ? [invocation.file, ...invocation.args].join(' ') : 'not started', 4 * 1024)}\n`),
    Buffer.from(`outcome: ${boundedDiagnosticValue(formatOutcome(outcome), 2 * 1024)}\n`),
    Buffer.from(`failure: ${boundedDiagnosticValue(failure?.message ?? 'none', 4 * 1024)}\n\n--- stdout ---\n`),
    output.format('stdout'),
    Buffer.from('\n\n--- stderr ---\n'),
    output.format('stderr'),
    Buffer.from('\n'),
  ])
  if (diagnostics.length <= MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES) return diagnostics
  const suffix = Buffer.from(`\n[diagnostic truncated to ${MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES} bytes]\n`)
  return Buffer.concat([diagnostics.subarray(0, MAX_PACKAGED_SMOKE_DIAGNOSTIC_BYTES - suffix.length), suffix])
}

async function readPackagedSmokeMarker(path, openFile = open) {
  const handle = await openFile(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Packaged smoke readiness marker is not a regular file')
    if (stat.size > MAX_PACKAGED_SMOKE_READY_BYTES) throw new Error(`Packaged smoke readiness marker exceeds ${MAX_PACKAGED_SMOKE_READY_BYTES} bytes`)
    const buffer = Buffer.alloc(MAX_PACKAGED_SMOKE_READY_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > MAX_PACKAGED_SMOKE_READY_BYTES) throw new Error(`Packaged smoke readiness marker exceeds ${MAX_PACKAGED_SMOKE_READY_BYTES} bytes`)
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}

function processOutcome(child, timeoutMs) {
  return new Promise((resolveOutcome) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveOutcome(outcome)
    }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    child.once('error', (error) => finish({ error }))
    child.once('close', (code, signal) => finish({ code, signal }))
  })
}

export async function terminateProcessTree(child, platform = process.platform) {
  const pid = child?.pid
  if (!Number.isInteger(pid) || pid <= 0) return
  if (platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if (result.error) throw result.error
    if (result.status !== 0 && child.exitCode === null) throw new Error(`taskkill failed with exit code ${result.status ?? `signal ${result.signal}`}`)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

export function validatePackagedSmokeResult(source, expectedUrl = EXPECTED_PACKAGED_RENDERER_URL) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('Packaged smoke readiness result is not valid JSON')
  }
  if (typeof value !== 'object' || value === null) throw new Error('Packaged smoke readiness result must be an object')
  if (value.event !== PACKAGED_SMOKE_READY_EVENT) throw new Error(`Packaged smoke readiness result has an unexpected event: ${String(value.event)}`)
  if (value.url !== expectedUrl) throw new Error(`Packaged smoke readiness result used an unexpected renderer URL: ${String(value.url)}`)
  if (value.preload !== true) throw new Error('Packaged smoke readiness result did not confirm the preload bridge')
  if (value.renderer !== true) throw new Error('Packaged smoke readiness result did not confirm renderer readiness')
  return { event: PACKAGED_SMOKE_READY_EVENT, url: expectedUrl, preload: true, renderer: true }
}

function formatOutcome(outcome) {
  if (!outcome) return 'not started'
  if (outcome.timedOut) return 'timed out'
  if (outcome.error) return `spawn error: ${outcome.error.message}`
  return `exit code ${outcome.code ?? 'null'}, signal ${outcome.signal ?? 'none'}`
}

function failureWithCleanup(primary, cleanupError) {
  if (!primary) return cleanupError
  return new AggregateError([primary, cleanupError], `${primary.message}; cleanup also failed: ${cleanupError.message}`)
}

export async function launchPackagedSmoke(options, overrides = {}) {
  const target = requireTarget(options.target)
  const timeoutMs = requireTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const outputDirectory = resolve(options.outputDirectory)
  const diagnosticsPath = resolve(options.diagnosticsPath ?? join(outputDirectory, 'packaged-smoke.log'))
  const env = options.env ?? process.env
  const dependencies = {
    mkdtemp,
    open,
    rm,
    spawn: nodeSpawn,
    terminateProcessTree,
    writeFile,
    ...overrides,
  }
  const userDataDirectory = await dependencies.mkdtemp(join(tmpdir(), 'gooeypi-packaged-smoke-'))
  const readyPath = join(userDataDirectory, PACKAGED_SMOKE_READY_FILE)
  const output = createCombinedLogCapture()
  let child
  let executable = ''
  let invocation
  let outcome
  let result
  let failure
  try {
    executable = findPackagedExecutable(outputDirectory, target)
    invocation = buildPackagedSmokeInvocation(executable, target, userDataDirectory, env)
    child = dependencies.spawn(invocation.file, invocation.args, {
      detached: true,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk) => output.add('stdout', chunk))
    child.stderr?.on('data', (chunk) => output.add('stderr', chunk))
    outcome = await processOutcome(child, timeoutMs)
    if (outcome.timedOut) throw new Error(`Packaged ${target} application timed out after ${timeoutMs} ms`)
    if (outcome.error) throw new Error(`Could not launch packaged ${target} application: ${outcome.error.message}`)
    let readySource
    try {
      readySource = await readPackagedSmokeMarker(readyPath, dependencies.open)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error(`Packaged ${target} application exited with code ${outcome.code ?? 'null'} before trusted renderer readiness`)
      throw error
    }
    result = validatePackagedSmokeResult(readySource)
    if (outcome.code !== 0) throw new Error(`Packaged ${target} application exited with code ${outcome.code ?? 'null'} after reporting readiness`)
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (child) {
      try {
        await dependencies.terminateProcessTree(child, target === 'win' ? 'win32' : 'linux')
      } catch (error) {
        failure = failureWithCleanup(failure, error instanceof Error ? error : new Error(String(error)))
      }
    }
    const diagnostics = packagedSmokeDiagnostics({ target, executable, invocation, outcome, failure, output })
    try {
      await mkdir(dirname(diagnosticsPath), { recursive: true })
      await dependencies.writeFile(diagnosticsPath, diagnostics, { mode: 0o600 })
    } catch (error) {
      failure = failureWithCleanup(failure, error instanceof Error ? error : new Error(String(error)))
    }
    try {
      await dependencies.rm(userDataDirectory, { recursive: true, force: true })
    } catch (error) {
      failure = failureWithCleanup(failure, error instanceof Error ? error : new Error(String(error)))
    }
  }
  if (failure) throw failure
  return result
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const target = requireTarget(option('--platform'))
  const arch = option('--arch')
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Packaged smoke architecture must be arm64 or x64')
  const host = target === 'win' ? 'win32' : 'linux'
  if (process.platform !== host) throw new Error(`Packaged ${target} smoke must run natively on ${host}`)
  const outputDirectory = resolve('release', target, arch)
  const result = await launchPackagedSmoke({ outputDirectory, target })
  console.log(`Packaged ${target}/${arch} launch smoke passed: ${result.url}, preload ready, renderer ready.`)
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
