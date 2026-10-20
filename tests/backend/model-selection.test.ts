import { describe, expect, it } from 'vitest'
import { modelListing, rankedModelMatches, resolveModel } from '../../electron/main/model-selection'
import type { PrimeModelDescriptor, PrimeThinkingLevel } from '../../src/types/api'

function model(key: string, name: string, levels: PrimeThinkingLevel[] = ['medium']): PrimeModelDescriptor {
  const separator = key.indexOf('/')
  return {
    key, provider: key.slice(0, separator), id: key.slice(separator + 1), name,
    reasoning: levels.length > 0, input: ['text'], contextWindow: 128_000, maxTokens: 16_000,
    availableThinkingLevels: levels, fastModeSupported: false, available: true,
  }
}

const sonnet = model('anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5')
const cjkQwen = model('local/qwen', '通义千问')
const symbolOnly = model('local/stars', '★★★')

describe('model name matching', () => {
  it('does not let a name that normalizes to nothing outrank a real match', () => {
    expect(rankedModelMatches('sonnet four', [sonnet, cjkQwen]).map((entry) => entry.key)).toEqual(['anthropic/claude-sonnet-4-5'])
    expect(rankedModelMatches('sonnet four', [cjkQwen, symbolOnly, sonnet]).map((entry) => entry.key)).toEqual(['anthropic/claude-sonnet-4-5'])
  })

  it('reports no match instead of picking a model with an empty normalized name', () => {
    expect(rankedModelMatches('opus', [cjkQwen, symbolOnly])).toEqual([])
    expect(() => resolveModel('opus', [cjkQwen])).toThrow(/No available model/)
  })

  it('still finds a model with a non-ASCII name by its id or key', () => {
    expect(rankedModelMatches('qwen', [sonnet, cjkQwen]).map((entry) => entry.key)).toEqual(['local/qwen'])
    expect(resolveModel('local qwen', [sonnet, cjkQwen, symbolOnly]).key).toBe('local/qwen')
  })
})

describe('modelListing', () => {
  it('lists every available model in order when the query is empty', () => {
    const opus = model('anthropic/claude-opus-4-1', 'Claude Opus 4.1', ['off', 'high', 'max'])
    expect(modelListing('', [sonnet, opus])).toEqual({
      models: [
        { key: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', reasoning_levels: ['medium'] },
        { key: 'anthropic/claude-opus-4-1', name: 'Claude Opus 4.1', provider: 'anthropic', reasoning_levels: ['off', 'high', 'max'] },
      ],
      matched: 2,
      returned: 2,
      truncated: false,
    })
  })

  it('returns ranked matches for a query and only the public fields', () => {
    const listing = modelListing('sonnet four', [cjkQwen, sonnet])
    expect(listing).toEqual({
      models: [{ key: 'anthropic/claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', reasoning_levels: ['medium'] }],
      matched: 1,
      returned: 1,
      truncated: false,
    })
    expect(modelListing('opus', [cjkQwen])).toEqual({ models: [], matched: 0, returned: 0, truncated: false })
  })

  it('caps the payload at 100 models and reports truncation', () => {
    const many = Array.from({ length: 105 }, (_, index) => model(`local/model-${String(index).padStart(3, '0')}`, `Model ${index}`))
    const listing = modelListing('', many)
    expect(listing.models).toHaveLength(100)
    expect(listing.models[99]?.key).toBe('local/model-099')
    expect(listing).toMatchObject({ matched: 105, returned: 100, truncated: true })
    expect(modelListing('local', many)).toMatchObject({ matched: 105, returned: 100, truncated: true })
  })
})
