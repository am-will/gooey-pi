import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { supportsFastMode } from 'prime-agent-ai'
import { PRIME_THINKING_LEVELS, type PrimeModelCatalog, type PrimeModelDescriptor, type PrimeProviderDescriptor, type PrimeThinkingLevel } from '../../src/types/api'
import type { ModelCatalogProvider } from './model-catalog'
import { withModelVisibility } from './model-visibility'
import { executableChildEnvironment, killProcessTree, resolveExecutable, runProcess, waitForProcessExit, type ExecutableSource } from './process-utils'
import { requireString } from './validation'

const CATALOG_TTL_MS = 30_000
const MAX_CATALOG_MODELS = 5_000
export const MAX_CATALOG_PROVIDERS = 256
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const VERSION_MAX_OUTPUT_BYTES = 4_096
const PROBE_REQUEST_ID = '1'
const PROBE_COMMAND = 'get_available_models'
export const PI_NOT_INSTALLED_WARNING = 'Pi is not installed. Install the pi CLI to load its model catalog.'

function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._:/+-]+$/.test(value)
}

function safeProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
}

function boundedInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function toFastModeSupported(provider: string, id: string): boolean {
  return supportsFastMode({ provider, id, api: 'openai-codex-responses' } as Parameters<typeof supportsFastMode>[0])
}

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

/** Validates one untrusted RPC model entry; returns null when any field is hostile or malformed. */
function toModelDescriptor(value: unknown): PrimeModelDescriptor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!safeProviderId(record.provider) || !safeModelId(record.id)) return null
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  if (record.reasoning !== undefined && typeof record.reasoning !== 'boolean') return null
  if (record.thinkingLevelMap !== undefined && (typeof record.thinkingLevelMap !== 'object' || record.thinkingLevelMap === null || Array.isArray(record.thinkingLevelMap))) return null
  const reasoning = record.reasoning === true
  const input = Array.isArray(record.input)
    ? record.input.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image')
    : []
  return {
    key: modelKey(record.provider, record.id),
    provider: record.provider,
    id: record.id,
    name: record.name.slice(0, 500),
    reasoning,
    input,
    contextWindow: boundedInteger(record.contextWindow),
    maxTokens: boundedInteger(record.maxTokens),
    availableThinkingLevels: toThinkingLevels(reasoning, record.thinkingLevelMap as Record<string, unknown> | undefined),
    // Pi's catalog does not carry fast-mode metadata. Keep the supported model
    // families aligned with Prime/OMP; the bundled extension applies the tier.
    fastModeSupported: toFastModeSupported(record.provider, record.id),
    // Pi does not report per-model auth state and its credentials live in the
    // CLI's own store, so every catalog model is treated as selectable.
    available: true,
  }
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
    const child = spawn(executable, ['--mode', 'rpc', '--no-session', '--offline'], {
      cwd: tmpdir(),
      env: executableChildEnvironment(executable),
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
    // Stdin stays open after the request: pi treats EOF as client-disconnect
    // and can shut down before processing a request that arrived in the same
    // flush. Every settle path terminates the child, so nothing lingers.
    child.stdin?.write(`${JSON.stringify({ id: PROBE_REQUEST_ID, type: PROBE_COMMAND })}\n`)
  })
}

export interface PiModelCatalogOptions {
  /** Wall-clock limit for one RPC probe (and the version probe). */
  timeoutMs?: number
  /** Combined stdout/stderr byte cap for one RPC probe. */
  maxOutputBytes?: number
}

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
export class PiModelCatalogService implements ModelCatalogProvider {
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0
  private cachedExecutable: string | null = null
  private catalogRefresh: { executable: string; promise: Promise<PrimeModelCatalog> } | null = null
  private version: { executable: string; value: string } | null = null

  constructor(private readonly executable: ExecutableSource, options: PiModelCatalogOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    const executable = resolveExecutable(this.executable)
    this.prepareExecutable(executable)
    if (!executable) {
      return { primeVersion: 'unknown', refreshedAt: new Date().toISOString(), models: [], providers: [], warning: PI_NOT_INSTALLED_WARNING }
    }
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return withModelVisibility(this.cachedCatalog, disabledProviders, disabledModels)
    }
    // Single-flight: concurrent callers share one RPC probe instead of
    // spawning duplicate subprocesses; the in-flight promise is cleared in
    // finally.
    if (!this.catalogRefresh || this.catalogRefresh.executable !== executable) {
      const promise = this.refreshCatalog(executable).finally(() => {
        if (this.catalogRefresh?.promise === promise) this.catalogRefresh = null
      })
      this.catalogRefresh = { executable, promise }
    }
    try {
      return withModelVisibility(await this.catalogRefresh.promise, disabledProviders, disabledModels)
    } catch (error) {
      // A failed refresh degrades to the last good catalog instead of an
      // error; first-ever loads still surface the failure.
      if (!this.cachedCatalog) throw error
      const reason = error instanceof Error ? error.message : String(error)
      const staleWarning = `The Pi model catalog could not be refreshed (${reason}); showing the last loaded catalog.`
      return withModelVisibility({
        ...this.cachedCatalog,
        warning: this.cachedCatalog.warning ? `${this.cachedCatalog.warning} ${staleWarning}` : staleWarning,
      }, disabledProviders, disabledModels)
    }
  }

  async requireAvailableModel(rawKey: unknown, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor> {
    const key = requireString(rawKey, 'model', { min: 3, max: 512, trim: true })
    const catalog = await this.catalog(false, disabledProviders, disabledModels)
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found in the Pi catalog')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider?.enabled) throw new Error(`Provider ${model.provider} is disabled`)
    if (model.enabled === false) throw new Error(`${model.name} is disabled`)
    if (!model.available) throw new Error(`Provider ${model.provider} is not configured for ${model.name}`)
    return model
  }

  async capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined> {
    if (!provider || !modelId) return undefined
    return (await this.catalog()).models.find((model) => model.provider === provider && model.id === modelId)
  }

  private async refreshCatalog(executable: string): Promise<PrimeModelCatalog> {
    const [frame, version] = await Promise.all([
      runModelProbe(executable, { timeoutMs: this.timeoutMs, maxOutputBytes: this.maxOutputBytes }),
      this.resolveVersion(executable),
    ])
    if (frame.success !== true) {
      // The error text is untrusted pi output: strip control characters and
      // bound it before it reaches a user-facing warning.
      const reason = typeof frame.error === 'string' && frame.error.length > 0
        ? frame.error.replace(/[^\x20-\x7e]+/g, ' ').slice(0, 200)
        : 'unknown error'
      throw new Error(`pi rejected the model catalog request: ${reason}`)
    }
    const data = frame.data
    if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray((data as Record<string, unknown>).models)) {
      throw new Error('Pi returned an unexpected model catalog shape')
    }
    const rawModels = (data as Record<string, unknown>).models as unknown[]

    const models: PrimeModelDescriptor[] = []
    const seenKeys = new Set<string>()
    let invalidEntries = 0
    for (const entry of rawModels) {
      const model = toModelDescriptor(entry)
      if (!model) { invalidEntries += 1; continue }
      if (seenKeys.has(model.key)) continue
      seenKeys.add(model.key)
      if (models.length < MAX_CATALOG_MODELS) models.push(model)
    }

    const providerIds = [...new Set(models.map((model) => model.provider))]
    const providers = providerIds.map((id): PrimeProviderDescriptor => {
      const providerModels = models.filter((model) => model.provider === id)
      return {
        id,
        name: id.slice(0, 200),
        authMethod: 'external',
        configured: true,
        authLabel: 'Credentials managed by the pi CLI',
        modelCount: providerModels.length,
        availableModelCount: providerModels.filter((model) => model.available).length,
        enabled: true,
      }
    }).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_CATALOG_PROVIDERS)

    const warnings = [
      seenKeys.size > models.length
        ? `Pi returned ${seenKeys.size.toLocaleString()} models; GooeyPi loaded the first ${models.length.toLocaleString()}.`
        : undefined,
      providerIds.length > providers.length
        ? `Pi returned ${providerIds.length.toLocaleString()} providers; GooeyPi loaded the first ${providers.length.toLocaleString()} sorted by name.`
        : undefined,
      invalidEntries > 0
        ? `Pi returned ${invalidEntries.toLocaleString()} model entries GooeyPi could not validate; they were skipped.`
        : undefined,
    ].filter((warning): warning is string => Boolean(warning))

    const catalog: PrimeModelCatalog = {
      primeVersion: version,
      refreshedAt: new Date().toISOString(),
      models,
      providers,
      warning: warnings.length ? warnings.join(' ') : undefined,
    }
    if (this.cachedExecutable === executable) {
      this.cachedCatalog = catalog
      this.cachedAt = Date.now()
    }
    return catalog
  }

  /**
   * Probes `pi --version` (the CLI prints a bare semver such as `0.84.1`).
   * Only a successful probe is cached: a transient failure answers 'unknown'
   * for this call and retries on the next catalog refresh.
   */
  private async resolveVersion(executable: string): Promise<string> {
    if (this.version?.executable === executable) return this.version.value
    let version: string | null = null
    try {
      const result = await runProcess(executable, ['--version'], {
        timeoutMs: this.timeoutMs,
        maxBytes: VERSION_MAX_OUTPUT_BYTES,
      })
      const match = result.code === 0 && !result.timedOut && !result.outputExceeded
        ? result.stdout.trim().match(/^v?([0-9][0-9A-Za-z.+-]{0,63})$/)
        : null
      version = match?.[1] ?? null
    } catch { /* Retry on the next catalog refresh. */ }
    if (version && this.cachedExecutable === executable) this.version = { executable, value: version }
    return version ?? 'unknown'
  }

  private prepareExecutable(executable: string | null): void {
    if (this.cachedExecutable === executable) return
    this.cachedExecutable = executable
    this.cachedCatalog = null
    this.cachedAt = 0
    this.version = null
  }

}
