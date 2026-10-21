import type { PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'
import type { ProviderCatalog } from './agent-rpc'

/**
 * The model-catalog surface shared by every agent harness provider service.
 *
 * This captures exactly what the two consumers use today:
 * - `AgentRpcManager` calls `requireAvailableModel` (start options and
 *   `set_model` validation) and `capabilities` (runtime capability decoration
 *   after model or thinking changes).
 * - The `providers:catalog` IPC handler calls `catalog(force, disabledProviders, disabledModels)`.
 *
 * Auth mutations (API keys, logout, OAuth flows) are intentionally excluded:
 * the manager never touches them and they are Prime-specific — OMP
 * authentication is owned by the omp CLI itself.
 */
export interface ModelCatalogProvider extends ProviderCatalog {
  catalog(force?: boolean, disabledProviders?: ReadonlySet<string>, disabledModels?: ReadonlySet<string>): Promise<PrimeModelCatalog>
}

export const MAX_CATALOG_MODELS = 5_000
export const MAX_CATALOG_PROVIDERS = 256

export interface CatalogLimitResult {
  models: PrimeModelDescriptor[]
  providers: PrimeProviderDescriptor[]
  totalModelCount: number
  totalProviderCount: number
  modelsOmittedWithProviders: number
  modelsOmittedByModelLimit: number
}

/**
 * Applies the provider and model limits as one relational operation. Providers
 * are selected first in a deterministic order, then only models belonging to
 * those providers are eligible for the model cap. Counts are always rebuilt
 * from the final model set, so no consumer can observe an orphan model or a
 * stale provider total.
 */
export function limitCatalogRelations(
  rawModels: ReadonlyArray<PrimeModelDescriptor>,
  rawProviders: ReadonlyArray<PrimeProviderDescriptor>,
): CatalogLimitResult {
  const seenProviderIds = new Set<string>()
  const uniqueProviders = [...rawProviders]
    .sort((left, right) => left.name.localeCompare(right.name, 'en-US') || left.id.localeCompare(right.id, 'en-US'))
    .filter((provider) => {
      if (seenProviderIds.has(provider.id)) return false
      seenProviderIds.add(provider.id)
      return true
    })
  const providers = uniqueProviders.slice(0, MAX_CATALOG_PROVIDERS)
  const retainedProviderIds = new Set(providers.map((provider) => provider.id))

  const seenModelKeys = new Set<string>()
  const uniqueModels = rawModels.filter((model) => {
    if (seenModelKeys.has(model.key)) return false
    seenModelKeys.add(model.key)
    return true
  })
  const modelsForRetainedProviders = uniqueModels.filter((model) => retainedProviderIds.has(model.provider))
  const models = modelsForRetainedProviders.slice(0, MAX_CATALOG_MODELS)
  const counts = new Map<string, { total: number; available: number }>()
  for (const model of models) {
    const count = counts.get(model.provider) ?? { total: 0, available: 0 }
    count.total += 1
    if (model.available) count.available += 1
    counts.set(model.provider, count)
  }

  return {
    models,
    providers: providers.map((provider) => {
      const count = counts.get(provider.id)
      return { ...provider, modelCount: count?.total ?? 0, availableModelCount: count?.available ?? 0 }
    }),
    totalModelCount: uniqueModels.length,
    totalProviderCount: uniqueProviders.length,
    modelsOmittedWithProviders: uniqueModels.length - modelsForRetainedProviders.length,
    modelsOmittedByModelLimit: modelsForRetainedProviders.length - models.length,
  }
}

/** Produces host-locale-independent warnings describing exactly what survived. */
export function catalogLimitWarnings(
  harnessLabel: string,
  result: CatalogLimitResult,
  options: { uniqueModels?: boolean } = {},
): string[] {
  const count = (value: number): string => value.toLocaleString('en-US')
  const omittedProviders = result.totalProviderCount - result.providers.length
  const omittedModels = result.modelsOmittedWithProviders + result.modelsOmittedByModelLimit
  const representedProviders = new Set(result.models.map((model) => model.provider)).size
  const warnings: string[] = []
  if (omittedProviders > 0) {
    warnings.push(`${harnessLabel} returned ${count(result.totalProviderCount)} valid providers; GooeyPi retained ${count(result.providers.length)} sorted by name (${count(omittedProviders)} omitted by the provider limit).`)
  }
  if (omittedModels > 0) {
    const modelKind = options.uniqueModels ? 'valid unique models' : 'valid models'
    const representedLabel = representedProviders === 1 ? 'provider' : 'providers'
    warnings.push(`${harnessLabel} returned ${count(result.totalModelCount)} ${modelKind}; GooeyPi retained ${count(result.models.length)} across ${count(representedProviders)} ${representedLabel} (${count(omittedModels)} omitted by catalog limits: ${count(result.modelsOmittedWithProviders)} with omitted providers and ${count(result.modelsOmittedByModelLimit)} beyond the model limit).`)
  }
  return warnings
}

export const CATALOG_TTL_MS = 30_000

export function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

export function boundedInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Resolve GUI selection policy against an already loaded catalog. */
export function requireCatalogModel(catalog: PrimeModelCatalog, key: string, harnessLabel: string): PrimeModelDescriptor {
  const model = catalog.models.find((candidate) => candidate.key === key)
  if (!model) throw new Error(`Model was not found in the ${harnessLabel} catalog`)
  const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
  if (!provider?.enabled) throw new Error(`Provider ${model.provider} is disabled in GooeyPi`)
  if (model.enabled === false) throw new Error(`${model.name} is disabled in GooeyPi`)
  if (!model.available) throw new Error(`Provider ${model.provider} is not configured for ${model.name}`)
  return model
}
