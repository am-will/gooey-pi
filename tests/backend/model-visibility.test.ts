import { describe, expect, it } from 'vitest'
import { HARNESS_VISIBILITY_KEYS, harnessVisibility, withModelVisibility } from '../../electron/main/model-visibility'
import { defaultSettings } from '../../electron/main/store'
import { type AppSettings, HARNESS_IDS, type PrimeModelCatalog } from '../../src/types/api'

const catalog: PrimeModelCatalog = {
  primeVersion: 'test',
  refreshedAt: '2026-08-13T00:00:00.000Z',
  providers: [{ id: 'openai', name: 'OpenAI', authMethod: 'external', configured: true, modelCount: 2, availableModelCount: 2, enabled: true }],
  models: [
    { key: 'openai/alpha', provider: 'openai', id: 'alpha', name: 'Alpha', reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
    { key: 'openai/beta', provider: 'openai', id: 'beta', name: 'Beta', reasoning: false, input: ['text'], contextWindow: 1, maxTokens: 1, availableThinkingLevels: ['off'], fastModeSupported: false, available: true },
  ],
}

describe('withModelVisibility', () => {
  it('turns every model off when its provider is off', () => {
    const result = withModelVisibility(catalog, new Set(['openai']), new Set())
    expect(result.providers[0].enabled).toBe(false)
    expect(result.models.map((model) => model.enabled)).toEqual([false, false])
  })

  it('keeps a provider on while any model is on and turns it off when none are on', () => {
    const partial = withModelVisibility(catalog, new Set(), new Set(['openai/beta']))
    expect(partial.providers[0].enabled).toBe(true)
    expect(partial.models.map((model) => model.enabled)).toEqual([true, false])

    const empty = withModelVisibility(catalog, new Set(), new Set(['openai/alpha', 'openai/beta']))
    expect(empty.providers[0].enabled).toBe(false)
    expect(empty.models.map((model) => model.enabled)).toEqual([false, false])
  })
})

describe('harnessVisibility', () => {
  const settings: AppSettings = {
    ...defaultSettings(),
    disabledProviders: ['prime-provider'],
    disabledModels: ['prime-provider/model'],
    ompDisabledProviders: ['omp-provider'],
    ompDisabledModels: ['omp-provider/model'],
    piDisabledProviders: ['pi-provider'],
    piDisabledModels: ['pi-provider/model'],
  }

  it('maps every harness to its own settings keys', () => {
    expect(Object.keys(HARNESS_VISIBILITY_KEYS).sort()).toEqual([...HARNESS_IDS].sort())
    expect(HARNESS_VISIBILITY_KEYS).toEqual({
      prime: { providers: 'disabledProviders', models: 'disabledModels' },
      omp: { providers: 'ompDisabledProviders', models: 'ompDisabledModels' },
      pi: { providers: 'piDisabledProviders', models: 'piDisabledModels' },
    })
  })

  it.each(HARNESS_IDS)('reads only the %s disabled provider and model lists', (harness) => {
    const visibility = harnessVisibility(settings, harness)
    expect([...visibility.disabledProviders]).toEqual([`${harness}-provider`])
    expect([...visibility.disabledModels]).toEqual([`${harness}-provider/model`])
  })

  it('returns fresh sets that do not alias the settings arrays', () => {
    const visibility = harnessVisibility(settings, 'omp')
    visibility.disabledProviders.add('extra')
    expect(settings.ompDisabledProviders).toEqual(['omp-provider'])
    expect(harnessVisibility(settings, 'omp').disabledProviders.has('extra')).toBe(false)
  })

  it('feeds withModelVisibility for the selected harness only', () => {
    const hidden = { ...settings, piDisabledModels: ['openai/beta'] }
    const pi = harnessVisibility(hidden, 'pi')
    expect(withModelVisibility(catalog, pi.disabledProviders, pi.disabledModels).models.map((model) => model.enabled)).toEqual([true, false])
    const prime = harnessVisibility(hidden, 'prime')
    expect(withModelVisibility(catalog, prime.disabledProviders, prime.disabledModels).models.map((model) => model.enabled)).toEqual([true, true])
  })
})
