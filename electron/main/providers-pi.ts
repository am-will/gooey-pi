import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { PRIME_THINKING_LEVELS, type PrimeModelDescriptor, type PrimeThinkingLevel } from '../../src/types/api'
import { CliModelCatalogService, validateModelEntry, type CliModelCatalogOptions } from './model-catalog-cli'
import { killProcessTree, prepareExecutableSpawn, waitForProcessExit } from './process-utils'

export { MAX_CATALOG_PROVIDERS } from './model-catalog-cli'

const PROBE_REQUEST_ID = '1'
const PROBE_COMMAND = 'get_available_models'
export const PI_NOT_INSTALLED_WARNING = 'Pi is not installed. Install the pi CLI to load its model catalog.'

/**
 * Pi reports `reasoning: boolean` plus an optional `thinkingLevelMap` remap
 * table (pi level → provider-native value). The map is not a support list:
 * this mirrors pi's own `getSupportedThinkingLevels` exactly — non-reasoning
 * models expose `['off']`; for reasoning models a level explicitly mapped to
 * null is unsupported, the extended `xhigh`/`max` levels exist only when the
 * map names them, and every other level is supported by default. Hostile
 * (non-string, non-null) map values are treated as absent.
 */
function toThinkingLevels(reasoning: boolean, rawMap: Record<string, unknown> | undefined): PrimeThinkingLevel[] {
  if (!reasoning) return ['off']
  return PRIME_THINKING_LEVELS.filter((level) => {
    const mapped = rawMap && Object.hasOwn(rawMap, level) ? rawMap[level] : undefined
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return typeof mapped === 'string'
    return true
  })
}

/** Parses one untrusted stdout line; returns the response frame for the probe request or null for noise. */
function parseProbeResponse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const frame = parsed as Record<string, unknown>
  if (frame.type !== 'response' || frame.id !== PROBE_REQUEST_ID || frame.command !== PROBE_COMMAND) return null
  return frame
}

/**
 * Pi has no CLI JSON model list (`--list-models` prints a table even under
 * `--mode json`), so the catalog comes from a short-lived RPC probe: spawn
 * `pi --mode rpc --no-session --offline`, write one `get_available_models`
 * request, read stdout line-by-line until the matching response frame
 * arrives (pi pushes no ready frame; unrelated JSONL lines are skipped), then
 * terminate the child. The probe is time-bounded, byte-bounded across both
 * pipes (stderr is swallowed but counted), spawned with a fixed argv array,
 * a sanitized environment, and a non-project cwd; every line is untrusted.
 */
function runModelProbe(executable: string, options: { timeoutMs: number; maxOutputBytes: number }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const invocation = prepareExecutableSpawn(executable, ['--mode', 'rpc', '--no-session', '--offline'])
    const child = spawn(invocation.file, invocation.args, {
      cwd: tmpdir(),
      env: invocation.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let capturedBytes = 0
    let settled = false

    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null
    // TERM-then-KILL, mirroring the shared runProcess escalation; fired on
    // every settle path so the probe never leaves a live pi behind.
    const terminate = (): void => {
      if (!child.pid) {
        try { child.kill('SIGKILL') } catch { /* never spawned */ }
        return
      }
      void killProcessTree(child.pid, {
        ladder: [{ signal: 'SIGTERM', waitMs: 2_000 }, { signal: 'SIGKILL', waitMs: 0 }],
        hasExited,
        waitForExit: (waitMs) => waitForProcessExit(child, waitMs),
        signalDirect: (signal) => child.kill(signal),
      })
    }
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      terminate()
      outcome()
    }
    const timer = setTimeout(() => settle(() => reject(new Error('The Pi model catalog request timed out'))), options.timeoutMs)
    timer.unref()

    const countBytes = (chunk: Buffer): boolean => {
      capturedBytes += chunk.length
      if (capturedBytes <= options.maxOutputBytes) return true
      settle(() => reject(new Error(`Pi model catalog output exceeded ${options.maxOutputBytes.toLocaleString()} bytes`)))
      return false
    }
    const scan = (text: string): void => {
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const frame = parseProbeResponse(line)
        if (frame) { settle(() => resolve(frame)); return }
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled || !countBytes(chunk)) return
      scan(decoder.write(chunk))
    })
    // stderr is diagnostic noise, never parsed — but a runaway producer still
    // counts against the shared byte budget.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (!settled) countBytes(chunk)
    })

    const fail = (error: Error): void => settle(() => reject(error))
    child.once('error', fail)
    child.stdout?.on('error', fail)
    child.stderr?.on('error', fail)
    child.stdin?.on('error', () => { /* close reports the process outcome */ })
    child.once('close', (code, signal) => {
      if (settled) return
      // A clean EOF may leave the response as a final unterminated line.
      scan(`${decoder.end()}\n`)
      if (settled) return
      settle(() => reject(new Error(signal
        ? `pi was terminated by ${signal} without answering the model catalog probe`
        : `pi exited with status ${code ?? -1} without answering the model catalog probe`)))
    })
    child.stdin?.end(`${JSON.stringify({ id: PROBE_REQUEST_ID, type: PROBE_COMMAND })}\n`)
  })
}

export type PiModelCatalogOptions = CliModelCatalogOptions

/**
 * Model catalog service for the pi harness, backed by the short-lived
 * `get_available_models` RPC probe instead of a CLI JSON list. Satisfies the
 * same `ModelCatalogProvider` surface as `PrimeProviderService` and
 * `OmpModelCatalogService`, so `AgentRpcManager` and the `providers:catalog`
 * IPC path can consume any of them.
 *
 * The probe output is untrusted: it is byte-bounded, time-bounded, spawned
 * with an argv array and a sanitized environment, and every field is
 * validated before use. A null executable means pi is not installed; the
 * catalog is then empty with a clear warning.
 */
export class PiModelCatalogService extends CliModelCatalogService {
  protected readonly harnessLabel = 'Pi'
  protected readonly notInstalledWarning = PI_NOT_INSTALLED_WARNING
  protected readonly credentialsLabel = 'Credentials managed by the pi CLI'

  /** The CLI prints a bare semver such as `0.84.1`. */
  protected parseVersion(stdout: string): string | null {
    return stdout.match(/^v?([0-9][0-9A-Za-z.+-]{0,63})$/)?.[1] ?? null
  }

  protected async fetchModelEntries(executable: string): Promise<unknown[]> {
    const frame = await runModelProbe(executable, { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes })
    if (frame.success !== true) {
      // The error text is untrusted pi output: strip control characters and
      // bound it before it reaches a user-facing warning.
      const reason = typeof frame.error === 'string' && frame.error.length > 0
        ? frame.error.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 200)
        : 'unknown error'
      throw new Error(`pi rejected the model catalog request: ${reason}`)
    }
    return this.requireModelEntries(frame.data)
  }

  /** Validates one untrusted RPC model entry; returns null when any field is hostile or malformed. */
  protected toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
    const entry = validateModelEntry(value)
    if (!entry) return null
    const { thinkingLevelMap } = entry.record
    if (thinkingLevelMap !== undefined && (typeof thinkingLevelMap !== 'object' || thinkingLevelMap === null || Array.isArray(thinkingLevelMap))) return null
    return {
      ...entry.descriptor,
      availableThinkingLevels: toThinkingLevels(entry.reasoning, thinkingLevelMap as Record<string, unknown> | undefined),
    }
  }
}
