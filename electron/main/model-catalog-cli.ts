import { supportsFastMode } from 'prime-agent-ai'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'
import { catalogLimitWarnings, limitCatalogRelations, type ModelCatalogProvider } from './model-catalog'
import { withModelVisibility } from './model-visibility'
import { resolveExecutable, runProcess, type ExecutableSource } from './process-utils'
import { requireString } from './validation'

/**
 * Shared model-catalog machinery for the harnesses whose catalog comes from an
 * external CLI (OMP's `omp models --json`, pi's RPC probe) instead of
 * in-process npm modules. Everything here is harness-agnostic: caching,
 * single-flight refresh, stale-catalog degradation, untrusted-entry validation,
 * provider derivation, and the version probe. Subclasses supply only how raw
 * model entries are fetched, how one entry maps to a descriptor, and how the
 * CLI reports its version.
 */
const CATALOG_TTL_MS = 30_000
export { MAX_CATALOG_PROVIDERS } from './model-catalog'
export const DEFAULT_CATALOG_TIMEOUT_MS = 15_000
export const DEFAULT_CATALOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const VERSION_MAX_OUTPUT_BYTES = 4_096

export function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

export function safeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._:/+-]+$/.test(value)
}

export function safeProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
}

export function boundedInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Neither CLI carries per-model fast-mode metadata, so both delegate to the
 * same `supportsFastMode` predicate Prime uses and the model family can never
 * drift between harnesses. The API variant is not reported either, but the
 * openai-codex provider maps 1:1 onto the openai-codex-responses API the
 * predicate requires, and every other provider fails its provider check
 * regardless of the API value.
 */
export function toFastModeSupported(provider: string, id: string): boolean {
  return supportsFastMode({ provider, id, api: 'openai-codex-responses' } as Parameters<typeof supportsFastMode>[0])
}

/** The fields every CLI model entry shares, or null when any of them is hostile or malformed. */
export interface ValidatedModelEntry {
  record: Record<string, unknown>
  provider: string
  id: string
  reasoning: boolean
  /** Descriptor fields derived purely from the shared entry shape. */
  descriptor: Omit<PrimeModelDescriptor, 'availableThinkingLevels'>
}

export function validateModelEntry(value: unknown): ValidatedModelEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!safeProviderId(record.provider) || !safeModelId(record.id)) return null
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  if (record.reasoning !== undefined && typeof record.reasoning !== 'boolean') return null
  const reasoning = record.reasoning === true
  const input = Array.isArray(record.input)
    ? record.input.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image')
    : []
  return {
    record,
    provider: record.provider,
    id: record.id,
    reasoning,
    descriptor: {
      key: modelKey(record.provider, record.id),
      provider: record.provider,
      id: record.id,
      name: record.name.slice(0, 500),
      reasoning,
      input,
      contextWindow: boundedInteger(record.contextWindow),
      maxTokens: boundedInteger(record.maxTokens),
      fastModeSupported: toFastModeSupported(record.provider, record.id),
      // Neither CLI reports per-model auth state and their credentials live in
      // the CLI's own store, so every catalog model is treated as selectable.
      available: true,
    },
  }
}

export interface CliModelCatalogOptions {
  /** Wall-clock limit for one catalog fetch (and the version probe). */
  timeoutMs?: number
  /** Combined stdout/stderr byte cap for one catalog fetch. */
  maxOutputBytes?: number
}

export abstract class CliModelCatalogService implements ModelCatalogProvider {
  protected readonly timeoutMs: number
  protected readonly maxOutputBytes: number
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0
  private cachedExecutable: string | null = null
  private catalogRefresh: { executable: string; promise: Promise<PrimeModelCatalog> } | null = null
  private cachedVersion: { executable: string; value: string } | null = null

  constructor(private readonly executable: ExecutableSource, options: CliModelCatalogOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CATALOG_MAX_OUTPUT_BYTES
  }

  /** Harness name as it appears in user-facing warnings and errors ('OMP', 'Pi'). */
  protected abstract readonly harnessLabel: string
  /** Warning served when the harness CLI is not installed. */
  protected abstract readonly notInstalledWarning: string
  /** Provider auth label, naming the CLI that owns the credentials. */
  protected abstract readonly credentialsLabel: string
  /** Fetches the untrusted raw model entries from the harness CLI. */
  protected abstract fetchModelEntries(executable: string): Promise<unknown[]>
  /** Maps one untrusted raw entry to a descriptor, or null when it is malformed. */
  protected abstract toModelDescriptor(value: unknown): PrimeModelDescriptor | null
  /** Extracts the version from the `--version` stdout, or null when unrecognized. */
  protected abstract parseVersion(stdout: string): string | null
  /** Environment for the `--version` probe; undefined inherits the runProcess default. */
  protected versionEnvironment(): NodeJS.ProcessEnv | undefined { return undefined }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    const executable = resolveExecutable(this.executable)
    this.prepareExecutable(executable)
    if (!executable) {
      return { primeVersion: 'unknown', refreshedAt: new Date().toISOString(), models: [], providers: [], warning: this.notInstalledWarning }
    }
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return withModelVisibility(this.cachedCatalog, disabledProviders, disabledModels)
    }
    // Single-flight: concurrent callers share one CLI run instead of spawning
    // duplicate subprocesses; the in-flight promise is cleared in finally.
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
      const staleWarning = `The ${this.harnessLabel} model catalog could not be refreshed (${reason}); showing the last loaded catalog.`
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
    if (!model) throw new Error(`Model was not found in the ${this.harnessLabel} catalog`)
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

  /** Reads `models` off an untrusted catalog container, rejecting any other shape. */
  protected requireModelEntries(container: unknown): unknown[] {
    if (typeof container !== 'object' || container === null || Array.isArray(container) || !Array.isArray((container as Record<string, unknown>).models)) {
      throw new Error(`${this.harnessLabel} returned an unexpected model catalog shape`)
    }
    return (container as Record<string, unknown>).models as unknown[]
  }

  private async refreshCatalog(executable: string): Promise<PrimeModelCatalog> {
    const [rawModels, version] = await Promise.all([
      this.fetchModelEntries(executable),
      this.resolveVersion(executable),
    ])

    const validModels: PrimeModelDescriptor[] = []
    const seenKeys = new Set<string>()
    let invalidEntries = 0
    for (const entry of rawModels) {
      const model = this.toModelDescriptor(entry)
      if (!model) { invalidEntries += 1; continue }
      if (seenKeys.has(model.key)) continue
      seenKeys.add(model.key)
      validModels.push(model)
    }

    const providerIds = [...new Set(validModels.map((model) => model.provider))]
    const relation = limitCatalogRelations(validModels, providerIds.map((id): PrimeProviderDescriptor => ({
      id,
      name: id.slice(0, 200),
      authMethod: 'external',
      configured: true,
      authLabel: this.credentialsLabel,
      modelCount: 0,
      availableModelCount: 0,
      enabled: true,
    })))

    const warnings = [
      ...catalogLimitWarnings(this.harnessLabel, relation, { uniqueModels: true }),
      invalidEntries > 0
        ? `${this.harnessLabel} returned ${invalidEntries.toLocaleString('en-US')} model entries GooeyPi could not validate; they were skipped.`
        : undefined,
    ].filter((warning): warning is string => Boolean(warning))

    const catalog: PrimeModelCatalog = {
      primeVersion: version,
      refreshedAt: new Date().toISOString(),
      models: relation.models,
      providers: relation.providers,
      warning: warnings.length ? warnings.join(' ') : undefined,
    }
    if (this.cachedExecutable === executable) {
      this.cachedCatalog = catalog
      this.cachedAt = Date.now()
    }
    return catalog
  }

  /**
   * Probes `<cli> --version`. Only a successful probe is cached: a transient
   * failure answers 'unknown' for this call and retries on the next catalog
   * refresh.
   */
  private async resolveVersion(executable: string): Promise<string> {
    if (this.cachedVersion?.executable === executable) return this.cachedVersion.value
    let version: string | null = null
    try {
      const result = await runProcess(executable, ['--version'], {
        timeoutMs: this.timeoutMs,
        maxBytes: VERSION_MAX_OUTPUT_BYTES,
        env: this.versionEnvironment(),
      })
      version = result.code === 0 && !result.timedOut && !result.outputExceeded
        ? this.parseVersion(result.stdout.trim())
        : null
    } catch { /* Retry on the next catalog refresh. */ }
    if (version && this.cachedExecutable === executable) this.cachedVersion = { executable, value: version }
    return version ?? 'unknown'
  }

  private prepareExecutable(executable: string | null): void {
    if (this.cachedExecutable === executable) return
    this.cachedExecutable = executable
    this.cachedCatalog = null
    this.cachedAt = 0
    this.cachedVersion = null
  }
}
