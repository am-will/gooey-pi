import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PrimeModelCatalog,
  PrimeModelDescriptor,
  PrimeProviderDescriptor,
  PrimeThinkingLevel,
  ProviderAuthMethod,
  ProviderAuthSource
} from '../../src/types/api'
import { MAX_CATALOG_MODELS, MAX_CATALOG_PROVIDERS, modelKey } from './model-catalog'
import { PRIME_THINKING_LEVELS } from '../../src/types/api/models'

export const CATALOG_CACHE_FILE_NAME = 'model-catalog-cache-v1.json'
/**
 * How long a catalog read from disk may stand in for a live CLI probe. Unlike the in-memory TTL this
 * only decides whether a stale list is worth showing at all, because it never blocks a reply: it is
 * rendered immediately and refreshed in the background. A week covers the case that actually matters
 * -- opening the app days after the last successful load, when the harness CLI is slow to start.
 */
export const DISK_CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_MODEL_NAME_CHARS = 500

export interface PersistedModelCatalog {
  executable: string
  cachedAt: number
  catalog: PrimeModelCatalog
}

/** Where a service keeps the last catalog it managed to load. */
export interface ModelCatalogCache {
  load(harness: string, executable: string): Promise<PersistedModelCatalog | null>
  save(harness: string, entry: PersistedModelCatalog): Promise<void>
}

interface CacheFile {
  version: 1
  catalogs: Record<string, PersistedModelCatalog>
}

const EMPTY: CacheFile = { version: 1, catalogs: {} }

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function boundedText(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length <= maxChars ? value : null
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

const AUTH_METHODS: readonly string[] = ['oauth', 'api_key', 'external']
const AUTH_SOURCES: readonly string[] = [
  'stored',
  'runtime',
  'environment',
  'prime_cli',
  'fallback',
  'models_json_key',
  'models_json_command',
  'stale'
]

/**
 * Rebuild one cached model descriptor from untrusted JSON. Anything malformed is dropped rather than
 * repaired, so a hand-edited or half-written cache file cannot smuggle an entry into the picker.
 */
function sanitizeModel(value: unknown): PrimeModelDescriptor | null {
  const model = plainObject(value)
  if (!model) return null
  const provider = typeof model.provider === 'string' ? model.provider : null
  const id = typeof model.id === 'string' ? model.id : null
  if (!provider || !id || model.key !== modelKey(provider, id)) return null
  const name = typeof model.name === 'string' ? model.name.slice(0, MAX_MODEL_NAME_CHARS) : provider
  const input = Array.isArray(model.input) ? model.input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image') : []
  const availableThinkingLevels = Array.isArray(model.availableThinkingLevels)
    ? model.availableThinkingLevels.filter(
      (level): level is PrimeThinkingLevel =>
        typeof level === 'string' && (PRIME_THINKING_LEVELS as readonly string[]).includes(level)
    )
    : []
  return {
    ...model,
    key: modelKey(provider, id),
    provider,
    id,
    name,
    reasoning: model.reasoning === true,
    input,
    contextWindow: integerOr(model.contextWindow, 0),
    maxTokens: integerOr(model.maxTokens, 0),
    availableThinkingLevels,
    fastModeSupported: model.fastModeSupported === true,
    available: model.available !== false,
    ...(typeof model.enabled === 'boolean' ? { enabled: model.enabled } : {})
  }
}

function sanitizeProvider(value: unknown): PrimeProviderDescriptor | null {
  const provider = plainObject(value)
  if (!provider || typeof provider.id !== 'string' || typeof provider.name !== 'string') return null
  const authMethod = typeof provider.authMethod === 'string' && AUTH_METHODS.includes(provider.authMethod)
    ? (provider.authMethod as ProviderAuthMethod)
    : 'external'
  const authSource = typeof provider.authSource === 'string' && AUTH_SOURCES.includes(provider.authSource)
    ? (provider.authSource as ProviderAuthSource)
    : undefined
  return {
    ...provider,
    id: provider.id,
    name: provider.name,
    authMethod,
    ...(authSource === undefined ? {} : { authSource }),
    ...(typeof provider.authLabel === 'string' ? { authLabel: provider.authLabel } : {}),
    configured: provider.configured !== false,
    modelCount: integerOr(provider.modelCount, 0),
    availableModelCount: integerOr(provider.availableModelCount, 0),
    enabled: provider.enabled !== false
  }
}

/** Sanitize a whole catalog, or return null when its envelope is unusable. */
export function sanitizePersistedCatalog(value: unknown): PrimeModelCatalog | null {
  const envelope = plainObject(value)
  if (!envelope) return null
  const models = Array.isArray(envelope.models)
    ? envelope.models.slice(0, MAX_CATALOG_MODELS).map(sanitizeModel).filter((model): model is NonNullable<ReturnType<typeof sanitizeModel>> => model !== null)
    : []
  const providers = Array.isArray(envelope.providers)
    ? envelope.providers.slice(0, MAX_CATALOG_PROVIDERS).map(sanitizeProvider).filter((provider): provider is NonNullable<ReturnType<typeof sanitizeProvider>> => provider !== null)
    : []
  const primeVersion = boundedText(envelope.primeVersion, 200)
  const refreshedAt = boundedText(envelope.refreshedAt, 100)
  if (primeVersion === null || refreshedAt === null) return null
  const warning = boundedText(envelope.warning, 2_000)
  return {
    primeVersion,
    refreshedAt,
    models,
    providers,
    ...(warning === null ? {} : { warning })
  }
}

/**
 * Last good CLI catalogs in one JSON file under userData.
 *
 * The CLI probe is the only way to learn a harness' models and it has to wait for the CLI process to
 * boot, which takes tens of seconds on a machine with a loaded extension set. Without this file, the
 * first fetch of a run owns all of that risk: when it fails, nothing can answer with a model list and
 * the composer has nothing to select. Persisting the last good result means a cold start always has
 * something to show while the refresh runs in the background.
 *
 * Every failure here is swallowed on purpose. This cache is an optimization and a fallback, and a read
 * or write error must never become a catalog error.
 */
export class JsonModelCatalogCache implements ModelCatalogCache {
  private loaded: CacheFile | null = null

  constructor(private readonly dir: string, private readonly maxAgeMs: number = DISK_CATALOG_MAX_AGE_MS) {}

  async load(harness: string, executable: string): Promise<PersistedModelCatalog | null> {
    const file = await this.read()
    const entry = file.catalogs[harness]
    if (!entry || entry.executable !== executable) return null
    if (!Number.isFinite(entry.cachedAt) || Date.now() - entry.cachedAt > this.maxAgeMs) return null
    const catalog = sanitizePersistedCatalog(entry.catalog)
    return catalog ? { executable: entry.executable, cachedAt: entry.cachedAt, catalog } : null
  }

  async save(harness: string, entry: PersistedModelCatalog): Promise<void> {
    const file = await this.read()
    file.catalogs[harness] = { executable: entry.executable, cachedAt: entry.cachedAt, catalog: entry.catalog }
    await this.write(file)
  }

  private async read(): Promise<CacheFile> {
    if (this.loaded) return this.loaded
    try {
      const parsed = plainObject(JSON.parse(await readFile(this.path(), 'utf8')))
      const catalogs = parsed ? plainObject(parsed.catalogs) : null
      this.loaded = parsed?.version === 1 && catalogs ? { version: 1, catalogs: catalogs as Record<string, PersistedModelCatalog> } : { ...EMPTY }
    } catch {
      // Missing, unreadable, or truncated by a crash: behave exactly like having never cached.
      this.loaded = { ...EMPTY }
    }
    return this.loaded
  }

  private async write(file: CacheFile): Promise<void> {
    const path = this.path()
    const temp = `${path}.${process.pid}.tmp`
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFile(temp, JSON.stringify(file), 'utf8')
      await rename(temp, path)
      this.loaded = file
    } catch {
      try {
        await writeFile(path, JSON.stringify(file), 'utf8')
        this.loaded = file
      } catch {
        /* Persistence is best effort: the catalog itself is unaffected. */
      }
    }
  }

  private path(): string {
    return join(this.dir, CATALOG_CACHE_FILE_NAME)
  }
}
