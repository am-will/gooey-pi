import { describe, expect, it } from 'vitest'
import { AgentEventForwarder, slimForwardedEvent } from '../../electron/main/agent-rpc/events'
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

    expect(delivered.some(({ event }) => event.type === 'transport_limit' && event.kind === 'envelope')).toBe(true)
    expect(delivered.find(({ event }) => event.type === 'agent_end')?.event).toEqual({
      type: 'agent_end',
      isTerminal: true,
    })

    const { events: compactionEvents, delivered: compactionDelivered } = forwarder({ maxEnvelopeBytes: 256, maxWindowBytes: 1_024 })
    compactionEvents.emit({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      completed: true,
      result: { summary: 'y'.repeat(2_048) },
    })

    expect(compactionDelivered.some(({ event }) => event.type === 'transport_limit' && event.kind === 'envelope')).toBe(true)
    expect(compactionDelivered.find(({ event }) => event.type === 'compaction_end')?.event).toEqual({
      type: 'compaction_end',
      reason: 'overflow',
      aborted: false,
      willRetry: false,
      completed: true,
    })
  })
})
