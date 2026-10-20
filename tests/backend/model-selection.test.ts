import { describe, expect, it } from 'vitest'
import { rankedModelMatches, resolveModel } from '../../electron/main/model-selection'
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
