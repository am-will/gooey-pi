import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_QUEUE_LIMIT, admitAgentEvent, contextUsageFromEvent, sessionUsageFromEvent, type PendingAgentEvent } from '../../src/app/agent-events'
import { replayPrimeEvents } from '../../src/lib/events'
import { contextDialLabel, formatSessionCost, formatSessionTokens } from '../../src/lib/format-cost'

describe('context usage events', () => {
  it('accepts bounded authoritative usage and preserves post-compaction unknowns', () => {
    expect(contextUsageFromEvent({
      type: 'context_usage', contextUsage: { tokens: 50_000, contextWindow: 100_000, percent: 50 },
    })).toEqual({ tokens: 50_000, contextWindow: 100_000, percent: 50 })
    expect(contextUsageFromEvent({
      type: 'context_usage', contextUsage: { tokens: null, contextWindow: 100_000, percent: null },
    })).toEqual({ tokens: null, contextWindow: 100_000, percent: null })
  })

  it('rejects malformed, negative, and unrelated payloads', () => {
    expect(contextUsageFromEvent({ type: 'message_end' })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: -1, contextWindow: 100, percent: 0 } })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: 1, contextWindow: 0, percent: 1 } })).toBeNull()
    expect(contextUsageFromEvent({ type: 'context_usage', contextUsage: { tokens: 1, contextWindow: 100, percent: Number.NaN } })).toBeNull()
  })
})

describe('session usage events', () => {
  const tokens = { input: 10_000, output: 2_000, cacheRead: 500, cacheWrite: 100, total: 12_600 }

  it('accepts cost with or without a token breakdown and a null cost', () => {
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: 0.42, tokens } })).toEqual({ cost: 0.42, tokens })
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: 0.42 } })).toEqual({ cost: 0.42 })
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: null, tokens } })).toEqual({ cost: null, tokens })
  })

  it('rejects malformed, negative, and unrelated payloads', () => {
    expect(sessionUsageFromEvent({ type: 'context_usage', sessionUsage: { cost: 1 } })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage' })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: -1 } })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: Number.NaN } })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: '1' } })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: 1, tokens: { ...tokens, output: -1 } } })).toBeNull()
    expect(sessionUsageFromEvent({ type: 'session_usage', sessionUsage: { cost: 1, tokens: { input: 1 } } })).toBeNull()
  })

  it('formats cost, treats a zero cost with spent tokens as unavailable pricing, and hides empty sessions', () => {
    expect(formatSessionCost({ cost: 0.4321, tokens })).toBe('$0.43')
    expect(formatSessionCost({ cost: 0.001, tokens })).toBe('<$0.01')
    expect(formatSessionCost({ cost: 0, tokens })).toBe('Pricing unavailable')
    expect(formatSessionCost({ cost: null, tokens })).toBe('Pricing unavailable')
    expect(formatSessionCost({ cost: 0, tokens: { ...tokens, total: 0 } })).toBeNull()
    expect(formatSessionCost({ cost: null })).toBeNull()
    expect(formatSessionCost(undefined)).toBeNull()
    expect(formatSessionTokens({ cost: 1, tokens })).toBe('10,000 in / 2,000 out / 600 cached')
    expect(formatSessionTokens({ cost: 1 })).toBeNull()
  })

  it('appends the session cost to the context dial label only when known', () => {
    const contextUsage = { tokens: 12_000, contextWindow: 100_000, percent: 12 }
    expect(contextDialLabel(contextUsage, undefined)).toBe('12,000 / 100,000 tokens')
    expect(contextDialLabel(contextUsage, { cost: 0.42, tokens })).toBe('12,000 / 100,000 tokens \u00b7 $0.42 session cost')
    expect(contextDialLabel(contextUsage, { cost: 0, tokens })).toBe('12,000 / 100,000 tokens \u00b7 pricing unavailable')
    expect(contextDialLabel({ tokens: null, contextWindow: 100_000, percent: null }, { cost: 0.42 })).toBe('Context usage unavailable until the next response')
  })
})

describe('agent event admission bound', () => {
  it('admits frame events until the queue bound and reports overflow past it', () => {
    const queue: PendingAgentEvent[] = []
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('frame')
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('frame')
    expect(admitAgentEvent(1, { type: 'message_update' }, null, queue, 2)).toBe('overflow')
    expect(queue).toHaveLength(2)
  })

  it('keeps routing to a pending transcript load regardless of queue depth', () => {
    const queue: PendingAgentEvent[] = Array.from({ length: 2 }, () => ({ generation: 1, event: {} }))
    const buffered: Record<string, unknown>[] = []
    const pendingLoad = { generation: 1, eventBuffer: { push: (event: Record<string, unknown>) => { buffered.push(event) } } }
    expect(admitAgentEvent(1, { type: 'message_update' }, pendingLoad as never, queue, 2)).toBe('transcript')
    expect(buffered).toHaveLength(1)
  })

  it('exposes a bounded default queue limit', () => {
    expect(AGENT_EVENT_QUEUE_LIMIT).toBe(50_000)
  })
})

describe('provider fallback events', () => {
  it('adds a notice for an applied fallback and resumes streaming below it', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } },
      { type: 'retry_fallback_applied', from: 'anthropic/claude-opus', to: 'anthropic/claude-sonnet', role: 'fallback' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'before', partId: expect.any(String) }])
    expect(messages[1]).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'Switched to anthropic/claude-sonnet due to a provider fallback (original: anthropic/claude-opus)' }],
    })
    expect(messages[2]?.parts).toEqual([{ type: 'text', text: 'after', partId: expect.any(String) }])
  })

  it('does not add a row for a succeeded fallback', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'retry_fallback_succeeded', model: 'anthropic/claude-sonnet', role: 'fallback' },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('assistant')
  })

  it('deduplicates identical applied fallback notices', () => {
    const messages = replayPrimeEvents([], [
      { type: 'retry_fallback_applied', from: 'anthropic/claude-opus', to: 'anthropic/claude-sonnet', role: 'fallback' },
      { type: 'retry_fallback_applied', from: 'anthropic/claude-opus', to: 'anthropic/claude-sonnet', role: 'fallback' },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'Switched to anthropic/claude-sonnet due to a provider fallback (original: anthropic/claude-opus)' }],
    })
  })

  it('ignores unrelated model events without finalizing streaming', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } },
      { type: 'model_changed' },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'default' },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'fallback' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      streaming: true,
      parts: [{ type: 'text', text: 'beforeafter', partId: expect.any(String) }],
    })
  })
})
