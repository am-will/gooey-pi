import { describe, expect, it } from 'vitest'
import { parseContextUsage, parseSessionUsage } from '../../src/lib/usage'

const tokens = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, total: 20 }
describe('harness context usage', () => {
  it('preserves measured counts and explicit unknown values', () => {
    expect(parseContextUsage({ tokens: 250, contextWindow: 100, percent: 250 })).toEqual({ tokens: 250, contextWindow: 100, percent: 250 })
    expect(parseContextUsage({ tokens: null, contextWindow: 100, percent: null })).toEqual({ tokens: null, contextWindow: 100, percent: null })
  })
  it.each([NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER + 1, '100', undefined])('rejects an invalid context window %s', (contextWindow) => {
    expect(parseContextUsage({ tokens: 1, contextWindow, percent: 1 })).toBeNull()
  })
  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])('rejects invalid token counts %s', (value) => {
    expect(parseContextUsage({ tokens: value, contextWindow: 100, percent: 1 })).toBeNull()
  })
})
describe('harness session usage', () => {
  it('preserves complete breakdowns and zero costs', () => {
    expect(parseSessionUsage({ cost: 0, tokens })).toEqual({ cost: 0, tokens })
    expect(parseSessionUsage({ tokens })).toEqual({ cost: null, tokens })
    expect(parseSessionUsage({ cost: null })).toEqual({ cost: null })
    expect(parseSessionUsage({})).toBeNull()
  })
  it.each([NaN, Infinity, -1, '1', null, undefined])('keeps cost unknown instead of coercing %s', (cost) => {
    expect(parseSessionUsage({ cost, tokens })).toEqual({ cost: null, tokens })
  })
  it('drops incomplete or invalid breakdowns while preserving valid cost', () => {
    for (const field of Object.keys(tokens)) {
      expect(parseSessionUsage({ cost: 1, tokens: { ...tokens, [field]: -1 } })).toEqual({ cost: 1 })
      expect(parseSessionUsage({ tokens: { ...tokens, [field]: undefined } })).toBeNull()
    }
    expect(parseSessionUsage({ cost: 2, tokens: [] })).toEqual({ cost: 2 })
    expect(parseSessionUsage(null)).toBeNull()
  })
})
