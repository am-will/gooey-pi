import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { PRIME_THINKING_LEVELS, type PrimeModelDescriptor, type PrimeThinkingLevel } from '../../src/types/api'
import { CliModelCatalogService, validateModelEntry, type ValidatedModelEntry } from './model-catalog-cli'
import { killProcessTree, prepareExecutableSpawn, safeChildEnvironment, waitForProcessExit } from './process-utils'

const PROBE_REQUEST_ID = '1'
const PROBE_COMMAND = 'get_available_models'

/**
 * A model entry's `thinkingLevelMap` is a remap table (level → provider-native
 * value), not a support list. A model without a thinking surface exposes
 * `['off']`. For one with a thinking surface, a level explicitly mapped to
 * null is unsupported, the extended `xhigh`/`max` levels exist only when the
 * map names them, and every other level is supported by default. Hostile
 * (non-string, non-null) map values are treated as absent.
 */
export function thinkingLevelsFromMap(hasThinking: boolean, rawMap: Record<string, unknown> | undefined): PrimeThinkingLevel[] {
  if (!hasThinking) return ['off']
  return PRIME_THINKING_LEVELS.filter((level) => {
    const mapped = rawMap && Object.hasOwn(rawMap, level) ? rawMap[level] : undefined
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return typeof mapped === 'string'
    return true
  })
}

/** How a probe's errors name its harness: the product ('Pi') and the CLI command ('pi'). */
interface ModelProbeNames {
  harnessLabel: string
  cliName: string
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
 * The short-lived RPC probe: spawn the CLI with the given RPC argv, write one
 * `get_available_models` request, read stdout line-by-line until the matching
 * response frame arrives (no ready frame is expected; unrelated JSONL lines
 * are skipped), then terminate the child. The probe is time-bounded,
 * byte-bounded across both pipes (stderr is swallowed but counted), spawned
 * with a fixed argv array, a sanitized environment plus the harness's probe
 * variables, and a non-project cwd; every line is untrusted.
 */
function runModelProbe(
  executable: string,
  args: readonly string[],
  names: ModelProbeNames,
  options: { timeoutMs: number; maxOutputBytes: number; environment: Readonly<Record<string, string>> },
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const invocation = prepareExecutableSpawn(executable, args, safeChildEnvironment(options.environment))
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
    // every settle path so the probe never leaves a live CLI behind.
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
    const timer = setTimeout(() => settle(() => reject(new Error(`The ${names.harnessLabel} model catalog request timed out`))), options.timeoutMs)
    timer.unref()

    const countBytes = (chunk: Buffer): boolean => {
      capturedBytes += chunk.length
      if (capturedBytes <= options.maxOutputBytes) return true
      settle(() => reject(new Error(`${names.harnessLabel} model catalog output exceeded ${options.maxOutputBytes.toLocaleString()} bytes`)))
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
    // stderr is diagnostic noise and never parsed, but a runaway producer still
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
        ? `${names.cliName} was terminated by ${signal} without answering the model catalog probe`
        : `${names.cliName} exited with status ${code ?? -1} without answering the model catalog probe`)))
    })
    // Stdin stays open after the request: pi treats EOF as client-disconnect
    // and can shut down before processing a request that arrived in the same
    // flush. Every settle path terminates the child, so nothing lingers.
    child.stdin?.write(`${JSON.stringify({ id: PROBE_REQUEST_ID, type: PROBE_COMMAND })}\n`)
  })
}

/**
 * A CLI model catalog read through the RPC probe, for harnesses that have no
 * CLI JSON model list. Subclasses name the CLI and its probe argv and map one
 * validated entry, with its thinking-level map, to a descriptor. Fetching,
 * the rejection message, and the entry shape checks are shared.
 */
export abstract class RpcModelCatalogService extends CliModelCatalogService {
  /** The CLI command as probe errors name it ('pi', 'prime-agent'). */
  protected abstract readonly cliName: string
  /** The probe's argv after the executable. */
  protected abstract readonly probeArgs: readonly string[]
  /** Variables set on the probe's environment only, never on a session runtime's. */
  protected readonly probeEnvironment: Readonly<Record<string, string>> = {}
  /** Maps a validated entry and its optional thinking-level map to a descriptor. */
  protected abstract describeModel(entry: ValidatedModelEntry, thinkingLevelMap: Record<string, unknown> | undefined): PrimeModelDescriptor

  protected async fetchModelEntries(executable: string): Promise<unknown[]> {
    const frame = await runModelProbe(executable, this.probeArgs, { harnessLabel: this.harnessLabel, cliName: this.cliName }, {
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      environment: this.probeEnvironment,
    })
    if (frame.success !== true) {
      // The error text is untrusted CLI output: strip control characters and
      // bound it before it reaches a user-facing warning.
      const reason = typeof frame.error === 'string' && frame.error.length > 0
        ? frame.error.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 200)
        : 'unknown error'
      throw new Error(`${this.cliName} rejected the model catalog request: ${reason}`)
    }
    return this.requireModelEntries(frame.data)
  }

  /** Validates one untrusted RPC model entry; returns null when any field is hostile or malformed. */
  protected toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
    const entry = validateModelEntry(value)
    if (!entry) return null
    const { thinkingLevelMap } = entry.record
    if (thinkingLevelMap !== undefined && (typeof thinkingLevelMap !== 'object' || thinkingLevelMap === null || Array.isArray(thinkingLevelMap))) return null
    return this.describeModel(entry, thinkingLevelMap as Record<string, unknown> | undefined)
  }
}
