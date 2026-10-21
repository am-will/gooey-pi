import { describe, expect, it } from 'vitest'
import { ContextUsageProjection, LiveContextUsageTracker, withLiveContextUsage } from '../../electron/main/agent-rpc/context-usage'

const usage = (tokens: number) => ({ tokens, contextWindow: 100_000, percent: tokens / 1_000 })
const assistantEnd = (output: number) => ({ type: 'message_end', message: { role: 'assistant', usage: { output } } })
const assistantStart = { type: 'message_start', message: { role: 'assistant' } }
const userStart = { type: 'message_start', message: { role: 'user', content: 'go' } }

describe('live context usage tracking', () => {
  it('uses reported output usage and falls back to streaming character estimates', () => {
    const tracker = new LiveContextUsageTracker()

    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 60 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    })
    expect(tracker.tokens).toBe(100)

    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 160 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'more' },
    })
    expect(tracker.tokens).toBe(160)

    tracker.handleEvent({ type: 'message_end', message: { role: 'assistant', usage: { output: 200 } } })
    expect(tracker.tokens).toBe(200)
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 5 } },
      assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(40) },
    })
    expect(tracker.tokens).toBe(210)
  })

  it('never moves backward during a stream and resets on the next user message', () => {
    const tracker = new LiveContextUsageTracker()
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 80 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'first' },
    })
    const update = tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 50 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'second' },
    })
    expect(update.changed).toBe(false)
    expect(tracker.tokens).toBe(80)

    expect(tracker.handleEvent({ type: 'message_start', message: { role: 'user', content: 'next' } })).toEqual({ changed: true, reset: true })
    expect(tracker.tokens).toBe(0)
  })

  it('ignores contradictory or malformed usage fields', () => {
    const tracker = new LiveContextUsageTracker()
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'user', usage: { output: 999 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'ignored' },
    })
    tracker.handleEvent({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: -1 } },
      assistantMessageEvent: { type: 'text_delta', delta: '12345678' },
    })
    expect(tracker.tokens).toBe(2)
  })
})

describe('live context usage projection', () => {
  it('adds only activity beyond the snapshot baseline', () => {
    expect(withLiveContextUsage(
      { tokens: 50_000, contextWindow: 100_000, percent: 50 },
      350,
      200,
    )).toEqual({ tokens: 50_150, contextWindow: 100_000, percent: 50.14999999999999 })
  })

  it('preserves unknown post-compaction usage', () => {
    const unknown = { tokens: null, contextWindow: 100_000, percent: null } as const
    expect(withLiveContextUsage(unknown, 1_000, 0)).toBe(unknown)
  })
})

describe('context usage projection', () => {
  it('keeps output live until a snapshot that includes it arrives', () => {
    const projection = new ContextUsageProjection()
    expect(projection.current()).toBeUndefined()
    projection.applySnapshot(usage(40_000))
    expect(projection.handleEvent(userStart)).toBe(true)
    expect(projection.generation).toBe(1)

    expect(projection.handleEvent(assistantEnd(200))).toBe(true)
    expect(projection.current()?.tokens).toBe(40_200)
    // A fast stats answer that predates persistence keeps the output live.
    projection.applySnapshot(usage(40_000), projection.activityTokens)
    expect(projection.current()?.tokens).toBe(40_200)
    // A snapshot that grew by at least the output already counts it.
    projection.applySnapshot(usage(40_300), projection.activityTokens)
    expect(projection.current()?.tokens).toBe(40_300)
  })

  it('bakes live output at a run boundary and forgets everything on reset', () => {
    const projection = new ContextUsageProjection()
    projection.applySnapshot(usage(40_000))
    projection.handleEvent(assistantEnd(500))
    projection.bake()
    expect(projection.current()?.tokens).toBe(40_500)
    projection.applySnapshot(usage(40_400), projection.activityTokens)
    expect(projection.current()?.tokens).toBe(40_400)

    projection.reset()
    expect(projection.current()).toBeUndefined()
    expect(projection.activityTokens).toBe(0)
    expect(projection.generation).toBe(1)
  })

  it('projects only the response in flight when snapshots omit the latest output', () => {
    const projection = new ContextUsageProjection()
    projection.applySnapshot(usage(20_000))
    projection.handleEvent(userStart)
    // Prompt-only snapshots (OMP) count a response's output only once the next prompt replays it.
    let prompt = 20_000
    for (let turn = 0; turn < 15; turn += 1) {
      projection.handleEvent(assistantStart)
      projection.handleEvent(assistantEnd(3_000))
      projection.applySnapshot(usage(prompt), projection.activityTokens)
      expect(projection.current()?.tokens).toBe(prompt + 3_000)
      projection.applySnapshot(usage(prompt + 800), projection.activityTokens)
      expect(projection.current()?.tokens).toBe(prompt + 800 + 3_000)
      prompt += 600 + 800
    }
  })

  it('leaves snapshots that already count completed output untouched at the next request', () => {
    const projection = new ContextUsageProjection()
    projection.applySnapshot(usage(40_000))
    projection.handleEvent(userStart)
    projection.handleEvent(assistantEnd(500))
    projection.applySnapshot(usage(40_500), projection.activityTokens)
    expect(projection.handleEvent(assistantStart)).toBe(false)
    expect(projection.current()?.tokens).toBe(40_500)
  })

  it('drops live output at compaction and invalidates stats requested before it ends', () => {
    const projection = new ContextUsageProjection()
    projection.applySnapshot(usage(150_000))
    projection.handleEvent(userStart)
    projection.handleEvent(assistantEnd(3_000))
    expect(projection.current()?.tokens).toBe(153_000)

    expect(projection.handleEvent({ type: 'compaction_start', reason: 'threshold' })).toBe(true)
    expect(projection.current()?.tokens).toBe(150_000)
    const generation = projection.generation
    projection.handleEvent({ type: 'compaction_end', aborted: false, willRetry: false })
    expect(projection.generation).toBe(generation + 1)
    projection.applySnapshot(usage(40_000))
    expect(projection.current()?.tokens).toBe(40_000)
  })
})
