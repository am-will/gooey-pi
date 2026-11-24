import { supportsFastMode } from 'prime-agent-ai'
import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'
import { harnessVersion } from './lib/harness-version'
import { boundedInteger, CATALOG_TTL_MS, catalogLimitWarnings, limitCatalogRelations, modelKey, requireCatalogModel, type ModelCatalogProvider } from './model-catalog'
import type { ModelCatalogCache } from './model-catalog-cache'
import { withModelVisibility } from './model-visibility'
import { resolveExecutable, runProcess, type ExecutableSource } from './process-utils'
import { isModelId, isProviderId, requireString } from './validation'

/**
 * Shared model-catalog machinery for the harnesses whose catalog comes from an
 * external CLI (OMP's `omp models --json`, the RPC probe pi and Rust Prime
 * answer) instead of in-process npm modules. Everything here is
 * harness-agnostic: caching, single-flight refresh, invalidation,
 * stale-catalog degradation, untrusted-entry validation, provider derivation,
 * and the version probe. Subclasses supply how raw model entries are fetched
 * and how one entry maps to a descriptor, and may replace the default
 * provider rows.
 */
export { MAX_CATALOG_PROVIDERS } from './model-catalog'
export const DEFAULT_CATALOG_TIMEOUT_MS = 15_000
export const DEFAULT_CATALOG_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const VERSION_MAX_OUTPUT_BYTES = 4_096

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
  if (!isProviderId(record.provider) || !isModelId(record.id)) return null
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
  /** Where the last good catalog survives a restart. Read and written on a best-effort basis. */
  diskCache?: ModelCatalogCache
  /** Identifies this harness inside the shared disk cache. Defaults to the harness label. */
  cacheKey?: string
  /** Injectable clock, so TTL behaviour is testable without sleeping. */
  now?: () => number
}

export abstract class CliModelCatalogService implements ModelCatalogProvider {
  protected readonly timeoutMs: number
  protected readonly maxOutputBytes: number
  private readonly now: () => number
  private readonly diskCache: ModelCatalogCache | undefined
  private readonly cacheKey: string | undefined
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0
  private cachedExecutable: string | null = null
  private catalogRefresh: { executable: string; promise: Promise<PrimeModelCatalog> } | null = null
  private cachedVersion: { executable: string; value: string } | null = null
  /** Executable whose persisted catalog has already been read (or attempted) this run. */
  private diskHydratedFor: string | null = null
  private hydration: { executable: string; promise: Promise<void> } | null = null
  /** True once a probe has settled this run, which is what makes serving a stale list safe. */
  private refreshedThisRun = false
  /** Why the last background probe failed, so a stale list can say so instead of looking current. */
  private refreshFailure: string | null = null
  /** Bumped by invalidate(); a refresh that began under an older generation never fills the cache. */
  private generation = 0

  constructor(private readonly executable: ExecutableSource, options: CliModelCatalogOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CATALOG_MAX_OUTPUT_BYTES
    this.now = options.now ?? Date.now
    this.diskCache = options.diskCache
    this.cacheKey = options.cacheKey
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
  /** Environment for the `--version` probe; undefined inherits the runProcess default. */
  protected versionEnvironment(): NodeJS.ProcessEnv | undefined { return undefined }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    const executable = resolveExecutable(this.executable)
    this.prepareExecutable(executable)
    if (!executable) {
      return { primeVersion: 'unknown', refreshedAt: new Date().toISOString(), models: [], providers: [], warning: this.notInstalledWarning }
    }
    // Hydration and refreshing both read from disk, so this is awaited before anything decides
    // whether a catalog already exists.
    await this.hydrateFromDisk(executable)
    if (!force && this.cachedCatalog && this.now() - this.cachedAt < CATALOG_TTL_MS) {
      return withModelVisibility(this.cachedCatalog, disabledProviders, disabledModels)
    }
    // Past the TTL, a list the user has already been served this run is replaced in the background
    // rather than in front of them: the 30s TTL used to put a 13-24s CLI probe in front of every later
    // interaction. `refreshedThisRun` is what makes this safe -- a catalog merely hydrated from disk is
    // not "already served", so the first fetch of a run still waits and still reports a failure. Placed
    // after the fresh check on purpose: a refresh already running is joined rather than dodged, so the
    // caller that started this run's first fetch ends with a fresh list and the UI cannot stick on a
    // week-old one.
    if (!force && this.cachedCatalog && !this.catalogRefresh && this.refreshedThisRun) {
      const served = this.cachedCatalog
      const failure = this.refreshFailure
      void this.startRefresh(executable).catch(() => {})
      return withModelVisibility(failure ? this.withStaleWarning(served, failure) : served, disabledProviders, disabledModels)
    }
    try {
      // Each caller is answered with the catalog its own refresh produced, while the cache keeps the
      // newest one: an older in-flight refresh still answers its own caller instead of picking up a
      // newer result that landed meanwhile.
      const catalog = await this.startRefresh(executable)
      return withModelVisibility(catalog, disabledProviders, disabledModels)
    } catch (error) {
      // A failed refresh degrades to the last good catalog instead of an
      // error; first-ever loads still surface the failure.
      if (!this.cachedCatalog) throw error
      return withModelVisibility(this.withStaleWarning(this.cachedCatalog, error instanceof Error ? error.message : String(error)), disabledProviders, disabledModels)
    }
  }

  /**
   * Warm the catalog without making anyone wait for it.
   *
   * The CLI probe costs what a CLI process costs, and the answer is needed the moment the composer
   * opens, so the wait belongs at startup rather than on a user-visible path. Deliberately not async:
   * a caller that could await this would be putting the probe back in front of the interface.
   */
  prewarm(): void {
    void (async () => {
      const executable = resolveExecutable(this.executable)
      if (!executable) return
      this.prepareExecutable(executable)
      await this.hydrateFromDisk(executable)
      if (this.cachedCatalog && this.now() - this.cachedAt < CATALOG_TTL_MS) return
      await this.startRefresh(executable).catch(() => {})
    })()
  }

  /** Start, or join, the one refresh allowed for this executable. Cleared when it settles. */
  private startRefresh(executable: string): Promise<PrimeModelCatalog> {
    // Single-flight: concurrent callers share one CLI run instead of spawning
    // duplicate subprocesses; the in-flight promise is cleared in finally.
    if (!this.catalogRefresh || this.catalogRefresh.executable !== executable) {
      const generation = this.generation
      const promise = this.refreshCatalog(executable, generation)
        .then((catalog) => { this.refreshFailure = null; return catalog })
        .catch((error: unknown) => {
          this.refreshFailure = error instanceof Error ? error.message : String(error)
          throw error
        })
        .finally(() => {
          if (this.catalogRefresh?.promise === promise) this.catalogRefresh = null
          this.refreshedThisRun = true
        })
      this.catalogRefresh = { executable, promise }
    }
    return this.catalogRefresh.promise
  }

  /** Keep the existing warning and append why the list may be out of date. */
  private withStaleWarning(catalog: PrimeModelCatalog, reason: string): PrimeModelCatalog {
    const staleWarning = `The ${this.harnessLabel} model catalog could not be refreshed (${reason}); showing the last loaded catalog.`
    return { ...catalog, warning: catalog.warning ? `${catalog.warning} ${staleWarning}` : staleWarning }
  }

  /**
   * Load the catalog this service persisted on an earlier run, once per executable.
   *
   * Concurrent callers join the same read. A catalog already held in memory always wins: it is
   * fresher, and `setHarnessEnabled` may have edited model visibility in it.
   */
  private async hydrateFromDisk(executable: string): Promise<void> {
    if (this.diskHydratedFor === executable) return
    if (this.hydration?.executable === executable) return this.hydration.promise
    const promise = (async () => {
      const persisted = await this.diskCache?.load(this.cacheKey ?? this.harnessLabel, executable)
      if (persisted && !this.cachedCatalog) {
        this.cachedCatalog = persisted.catalog
        this.cachedAt = persisted.cachedAt
      }
      this.diskHydratedFor = executable
    })()
    this.hydration = { executable, promise }
    await promise
  }

  async requireAvailableModel(rawKey: unknown, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor> {
    const key = requireString(rawKey, 'model', { min: 3, max: 512, trim: true })
    const catalog = await this.catalog(false, disabledProviders, disabledModels)
    return requireCatalogModel(catalog, key, this.harnessLabel)
  }

  async capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined> {
    if (!provider || !modelId) return undefined
    return (await this.catalog()).models.find((model) => model.provider === provider && model.id === modelId)
  }

  /**
   * Makes the next read run the CLI again, for example after its credentials
   * changed. A refresh already in flight still answers its own callers but no
   * longer fills the cache. The last loaded catalog stays the fallback for a
   * refresh that fails.
   */
  invalidate(): void {
    this.generation += 1
    this.cachedAt = 0
    this.catalogRefresh = null
    // The next read is supposed to run the CLI again and report what it gets, so it may not be served
    // from the background-refresh path.
    this.refreshedThisRun = false
  }

  /** Provider rows for the providers a refresh returned models for; by default each one's credentials belong to the CLI. */
  protected providerDescriptors(providerIds: readonly string[]): PrimeProviderDescriptor[] {
    return providerIds.map((id) => ({
      id,
      name: id.slice(0, 200),
      authMethod: 'external',
      configured: true,
      authLabel: this.credentialsLabel,
      modelCount: 0,
      availableModelCount: 0,
      enabled: true,
    }))
  }

  /** Reads `models` off an untrusted catalog container, rejecting any other shape. */
  protected requireModelEntries(container: unknown): unknown[] {
    if (typeof container !== 'object' || container === null || Array.isArray(container) || !Array.isArray((container as Record<string, unknown>).models)) {
      throw new Error(`${this.harnessLabel} returned an unexpected model catalog shape`)
    }
    return (container as Record<string, unknown>).models as unknown[]
  }

  private async refreshCatalog(executable: string, generation: number): Promise<PrimeModelCatalog> {
    // One CLI process at a time. The model probe and the version probe each start a CLI process, and
    // running them together measured ~25.9s for what costs ~13s on its own.
    const rawModels = await this.fetchModelEntries(executable)
    const version = await this.resolveVersion(executable)

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

    const relation = limitCatalogRelations(validModels, this.providerDescriptors([...new Set(validModels.map((model) => model.provider))]))

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
    if (this.cachedExecutable === executable && this.generation === generation) {
      this.cachedCatalog = catalog
      this.cachedAt = this.now()
this.diskHydratedFor = executable
      // Awaiting the write is what makes "the last good catalog is on disk" true by the time we hand
      // back a catalog, so a crash one second later cannot lose what the 13-24s probe just cost.
      // save() swallows every fs error itself, so persistence still cannot fail the catalog.
      await this.diskCache?.save(this.cacheKey ?? this.harnessLabel, { executable, cachedAt: this.cachedAt, catalog })
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
        ? harnessVersion(result.stdout)
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
    this.diskHydratedFor = null
    this.hydration = null
    this.refreshedThisRun = false
    this.refreshFailure = null
  }
}
