import { describe, expect, it } from 'vitest'
import { parseContextUsage, parseResponseGeneration, parseSessionUsage } from '../../src/lib/usage'

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
describe('harness response generation timing', () => {
  const startedAt = Date.parse('2026-10-24T10:00:00.000Z')
  const response = { role: 'assistant', stopReason: 'stop', timestamp: startedAt, usage: { output: 400 } }
  it('spans the request start to the persisted completion', () => {
    expect(parseResponseGeneration(response, '2026-10-24T10:00:08.000Z')).toEqual({ outputTokens: 400, durationMs: 8_000 })
    expect(parseResponseGeneration({ ...response, timestamp: '2026-10-24T10:00:00.000Z' }, startedAt + 2_000)).toEqual({ outputTokens: 400, durationMs: 2_000 })
    expect(parseResponseGeneration({ ...response, stopReason: 'toolUse' }, startedAt + 1_000)).toEqual({ outputTokens: 400, durationMs: 1_000 })
  })
  it.each(['error', 'aborted'])('leaves out a response that ended with %s', (stopReason) => {
    expect(parseResponseGeneration({ ...response, stopReason }, startedAt + 1_000)).toBeUndefined()
  })
  it('needs a measurable span and generated output', () => {
    const completedAt = startedAt + 1_000
    expect(parseResponseGeneration({ ...response, role: 'user' }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration({ ...response, usage: { output: 0 } }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration({ ...response, usage: { output: -1 } }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration({ ...response, usage: undefined }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration({ ...response, timestamp: undefined }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration({ ...response, timestamp: 'not a date' }, completedAt)).toBeUndefined()
    expect(parseResponseGeneration(response, undefined)).toBeUndefined()
    expect(parseResponseGeneration(response, startedAt)).toBeUndefined()
    expect(parseResponseGeneration(response, startedAt - 1)).toBeUndefined()
    expect(parseResponseGeneration(null, completedAt)).toBeUndefined()
  })
})
