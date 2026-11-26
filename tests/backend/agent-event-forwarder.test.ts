import { describe, expect, it } from 'vitest'
import { AgentEventForwarder, slimForwardedEvent } from '../../electron/main/agent-rpc/events'
import { applyCompactionEvent } from '../../src/lib/events/compaction'
import type { PrimeEventEnvelope } from '../../src/types/api'

function forwarder(limits: Partial<{ maxEvents: number; maxEnvelopeBytes: number; maxWindowBytes: number; windowMs: number }> = {}) {
  const delivered: PrimeEventEnvelope[] = []
  const events = new AgentEventForwarder('runtime-1', (envelope) => delivered.push(envelope), limits)
  return { events, delivered }
}

describe('AgentEventForwarder runtime_exit exemption', () => {
  it('delivers runtime_exit under a saturated event-count limiter', () => {
    const { events, delivered } = forwarder({ maxEvents: 5 })
    for (let index = 0; index < 20; index += 1) events.emit({ type: 'message_update', index })
    const deliveredTypes = delivered.map(({ event }) => event.type)
    expect(deliveredTypes.filter((type) => type === 'message_update')).toHaveLength(5)

    events.emit({ type: 'runtime_exit', code: 1, expected: false })
    expect(delivered.at(-1)?.event).toMatchObject({ type: 'runtime_exit', code: 1 })
  })

  it('delivers runtime_exit under saturated lifecycle and byte limiters', () => {
    const { events, delivered } = forwarder({ maxWindowBytes: 512 })
    for (let index = 0; index < 40; index += 1) events.emit({ type: 'agent_start' })
    const beforeExit = delivered.filter(({ event }) => event.type === 'agent_start').length
    expect(beforeExit).toBeLessThanOrEqual(32)

    events.emit({ type: 'runtime_exit', code: null, signal: 'SIGKILL', expected: false })
    expect(delivered.filter(({ event }) => event.type === 'runtime_exit')).toHaveLength(1)
  })

  it('delivers runtime_exit at most once', () => {
    const { events, delivered } = forwarder()
    events.emit({ type: 'runtime_exit', code: 0, expected: true })
    events.emit({ type: 'runtime_exit', code: 0, expected: true })
    expect(delivered.filter(({ event }) => event.type === 'runtime_exit')).toHaveLength(1)
  })
})


describe('forwarded stream payloads', () => {
  it('removes repeated partial snapshots while preserving deltas, tool arguments, content and usage', () => {
    const event = {
      type: 'message_update', message: { role: 'assistant', usage: { output: 50 }, content: 'full snapshot' },
      assistantMessageEvent: { type: 'toolcall_end', partial: 'full snapshot', contentIndex: 3, delta: 'delta', content: 'content', toolCall: { id: 'call', name: 'Read', arguments: { path: 'a.ts' } }, futureField: true },
    }
    expect(slimForwardedEvent(event)).toEqual({
      type: 'message_update', message: { role: 'assistant', usage: { output: 50 } },
      assistantMessageEvent: { type: 'toolcall_end', contentIndex: 3, delta: 'delta', content: 'content', toolCall: { id: 'call', name: 'Read', arguments: { path: 'a.ts' } }, futureField: true },
    })
    expect(event.assistantMessageEvent.partial).toBe('full snapshot')
    const fallback = { type: 'message_update', delta: { type: 'text_delta', delta: 'fallback' } }
    expect(slimForwardedEvent(fallback)).toEqual(fallback)
    const complete = { type: 'message_end', message: { content: 'complete response' } }
    expect(slimForwardedEvent(complete)).toBe(complete)
  })

  it('strips bulk message histories from agent_end and turn_end without mutating the source frame', () => {
    const messages = [{ role: 'toolResult', content: [{ type: 'image', data: 'A'.repeat(1_024) }] }]
    const agentEnd = { type: 'agent_end', isTerminal: true, messages }
    expect(slimForwardedEvent(agentEnd)).toEqual({ type: 'agent_end', isTerminal: true })
    expect(agentEnd.messages).toBe(messages)

    const turnEnd = { type: 'turn_end', message: { role: 'assistant', content: 'done' }, toolResults: messages }
    expect(slimForwardedEvent(turnEnd)).toEqual({ type: 'turn_end' })
    expect(turnEnd.toolResults).toBe(messages)
  })

  it('preserves a minimal critical lifecycle event when an oversized frame exceeds maxEnvelopeBytes', () => {
    const { events, delivered } = forwarder({ maxEnvelopeBytes: 256, maxWindowBytes: 1_024 })
    events.emit({ type: 'agent_end', isTerminal: true, extra: 'x'.repeat(2_048) })

    expect(delivered.map(({ event }) => event.type)).toEqual(['transport_limit', 'agent_end'])
    expect(delivered[0]?.event).toMatchObject({ type: 'transport_limit', kind: 'envelope' })
    expect(delivered[1]?.event).toEqual({
      type: 'agent_end',
      isTerminal: true,
    })
  })

  it('prioritizes the critical fallback stub over transport_limit when windowBytes is nearly full', () => {
    const { events, delivered } = forwarder({ maxEnvelopeBytes: 256, maxWindowBytes: 512 })
    // Fill the window so ~152 bytes remain: enough for the agent_end stub, not
    // enough for both the transport_limit notice and the stub.
    events.emit({ type: 'message_update', pad: 'a'.repeat(180) })
    events.emit({ type: 'message_update', pad: 'b'.repeat(70) })
    const beforeCount = delivered.length

    events.emit({ type: 'agent_end', isTerminal: true, extra: 'x'.repeat(2_048) })

    const emitted = delivered.slice(beforeCount).map(({ event }) => event)
    expect(emitted).toEqual([{ type: 'agent_end', isTerminal: true }])
  })

  it('preserves compaction_end success outcome and bounded error/instruction metadata on fallback', () => {
    // Result-only success (no explicit completed flag), matching normal Pi compaction_end frames.
    const { events: resultOnlyEvents, delivered: resultOnlyDelivered } = forwarder({ maxEnvelopeBytes: 512, maxWindowBytes: 2_048 })
    resultOnlyEvents.emit({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      result: { summary: 'y'.repeat(2_048), tokensBefore: 120_000, firstKeptEntryId: 'entry-42' },
    })

    const resultOnlyStub = resultOnlyDelivered.find(({ event }) => event.type === 'compaction_end')?.event
    expect(resultOnlyStub).toEqual({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      completed: true,
      result: { tokensBefore: 120_000, firstKeptEntryId: 'entry-42' },
    })
    const resultOnlyTranscript = applyCompactionEvent([], resultOnlyStub!)
    expect(resultOnlyTranscript?.[0]?.parts[0]).toMatchObject({
      type: 'compaction',
      status: 'done',
      tokensBefore: 120_000,
      firstKeptEntryId: 'entry-42',
    })

    // Summary-only success (no tokensBefore/firstKeptEntryId/completed).
    const { events: summaryOnlyEvents, delivered: summaryOnlyDelivered } = forwarder({ maxEnvelopeBytes: 256, maxWindowBytes: 1_024 })
    summaryOnlyEvents.emit({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      result: { summary: 'z'.repeat(2_048) },
    })
    const summaryOnlyStub = summaryOnlyDelivered.find(({ event }) => event.type === 'compaction_end')?.event
    expect(summaryOnlyStub).toEqual({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      completed: true,
    })
    expect(applyCompactionEvent([], summaryOnlyStub!)?.[0]?.parts[0]).toMatchObject({
      type: 'compaction',
      status: 'done',
    })

    // Failed compaction preserves bounded errorMessage and customInstructions.
    const { events: failedEvents, delivered: failedDelivered } = forwarder({ maxEnvelopeBytes: 512, maxWindowBytes: 2_048 })
    failedEvents.emit({
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      willRetry: false,
      errorMessage: 'Provider rejected compaction request',
      customInstructions: 'Preserve API contracts',
      extra: 'w'.repeat(2_048),
    })
    const failedStub = failedDelivered.find(({ event }) => event.type === 'compaction_end')?.event
    expect(failedStub).toEqual({
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      willRetry: false,
      errorMessage: 'Provider rejected compaction request',
      customInstructions: 'Preserve API contracts',
    })
    expect(applyCompactionEvent([], failedStub!)?.[0]?.parts[0]).toMatchObject({
      type: 'compaction',
      status: 'failed',
      outcome: 'failed',
      error: 'Provider rejected compaction request',
      customInstructions: 'Preserve API contracts',
    })
  })
})
