import type { AppSettings, HarnessId, PrimeModelCatalog } from '../../src/types/api'

/** The per-harness settings keys holding GooeyPi's disabled provider ids and model keys. */
export const HARNESS_VISIBILITY_KEYS = {
  prime: { providers: 'disabledProviders', models: 'disabledModels' },
  omp: { providers: 'ompDisabledProviders', models: 'ompDisabledModels' },
  pi: { providers: 'piDisabledProviders', models: 'piDisabledModels' },
} as const satisfies Record<HarnessId, { providers: keyof AppSettings; models: keyof AppSettings }>

export type HarnessVisibilityKey = (typeof HARNESS_VISIBILITY_KEYS)[HarnessId][keyof (typeof HARNESS_VISIBILITY_KEYS)[HarnessId]]

/** Fresh copies of one harness's disabled provider/model lists, ready for withModelVisibility or a catalog call. */
export function harnessVisibility(
  settings: Pick<AppSettings, HarnessVisibilityKey>,
  harness: HarnessId,
): { disabledProviders: Set<string>; disabledModels: Set<string> } {
  const keys = HARNESS_VISIBILITY_KEYS[harness]
  return { disabledProviders: new Set(settings[keys.providers]), disabledModels: new Set(settings[keys.models]) }
}

/** Applies GooeyPi's synchronized provider/model visibility policy to a raw harness catalog. */
export function withModelVisibility(
  catalog: PrimeModelCatalog,
  disabledProviders: ReadonlySet<string>,
  disabledModels: ReadonlySet<string>,
): PrimeModelCatalog {
  const modelKeysByProvider = new Map<string, string[]>()
  for (const model of catalog.models) {
    const keys = modelKeysByProvider.get(model.provider)
    if (keys) keys.push(model.key)
    else modelKeysByProvider.set(model.provider, [model.key])
  }

  const providerEnabled = new Map(catalog.providers.map((provider) => {
    const modelKeys = modelKeysByProvider.get(provider.id)
    const hasEnabledModel = !modelKeys || modelKeys.some((key) => !disabledModels.has(key))
    return [provider.id, !disabledProviders.has(provider.id) && hasEnabledModel] as const
  }))

  return {
    ...catalog,
    models: catalog.models.map((model) => ({
      ...model,
      enabled: providerEnabled.get(model.provider) !== false && !disabledModels.has(model.key),
    })),
    providers: catalog.providers.map((provider) => ({ ...provider, enabled: providerEnabled.get(provider.id) !== false })),
  }
}
