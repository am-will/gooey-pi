import { describe, expect, it } from 'vitest'
import { AGENT_EVENT_QUEUE_LIMIT, admitAgentEvent, contextUsageFromEvent, type PendingAgentEvent } from '../../src/app/agent-events'
import { replayPrimeEvents } from '../../src/lib/events'

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
  it.each(['model_change', 'model_changed'])('adds one notice for a %s event and resumes streaming below it', (type) => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } },
      { type, model: 'anthropic/claude-sonnet', resolvedModelIsFallback: true },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } },
    ])

    expect(messages).toHaveLength(3)
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'before', partId: expect.any(String) }])
    expect(messages[1]).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'Switched to anthropic/claude-sonnet due to a provider fallback' }],
    })
    expect(messages[2]?.parts).toEqual([{ type: 'text', text: 'after', partId: expect.any(String) }])
  })

  it('deduplicates consecutive fallback notices and ignores non-fallback model changes', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'model_change', model: 'anthropic/claude-sonnet', role: 'fallback' },
      { type: 'model_change', model: 'anthropic/claude-sonnet', role: 'fallback' },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'default' },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'compaction' },
      { type: 'model_change', provider: 'openai', modelId: 'gpt-5' },
    ])

    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1)
    expect(messages[1]?.parts).toMatchObject([{ type: 'text', text: 'Switched to anthropic/claude-sonnet due to a provider fallback' }])
  })

  it('supports split provider and model identifiers', () => {
    const messages = replayPrimeEvents([], [
      { type: 'model_changed', provider: 'openai', modelId: 'gpt-5', role: 'fallback' },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      role: 'system',
      parts: [{ type: 'text', text: 'Switched to openai/gpt-5 due to a provider fallback' }],
    })
  })

  it('does not render or finalize streaming for ordinary model changes', () => {
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'default' },
      { type: 'model_change', model: 'anthropic/claude-haiku', role: 'compaction' },
      { type: 'model_change', provider: 'anthropic', modelId: 'claude-opus' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'beforeafter', partId: expect.any(String) }])
  })
})
