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
})
