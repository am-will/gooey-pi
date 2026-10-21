import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentEventForwarder } from '../../electron/main/agent-rpc'

// Complements tests/backend/security.test.ts, which already covers the
// envelope byte bound, aggregate window byte bound for normal events, and
// agent_end surviving count saturation. These tests pin the runtime_exit
// exemption, exactly-once limit reporting, and the reserve interplay.

interface Forwarded { runtimeId: string; event: Record<string, unknown> }

function forwarder(limits: Partial<{ maxEvents: number; maxEnvelopeBytes: number; maxWindowBytes: number; windowMs: number }>, now?: () => number): { events: Forwarded['event'][]; emit: (event: Record<string, unknown>) => void } {
  const events: Forwarded['event'][] = []
  const instance = new AgentEventForwarder('runtime-test', (envelope: Forwarded) => events.push(envelope.event), limits, now)
  return { events, emit: (event) => instance.emit(event) }
}

const bytesOf = (event: Record<string, unknown>) => Buffer.byteLength(JSON.stringify({ runtimeId: 'runtime-test', event }), 'utf8')

afterEach(() => { vi.useRealTimers() })

describe('AgentEventForwarder runtime_exit exemption', () => {
  it('delivers runtime_exit exactly once per runtime while the normal-event limiter is saturated', () => {
    const { events, emit } = forwarder({ maxEvents: 3, windowMs: 60_000 })
    for (let index = 0; index < 20; index += 1) emit({ type: 'message_update', index })
    emit({ type: 'runtime_exit', code: 1, expected: false })
    emit({ type: 'runtime_exit', code: 1, expected: false })

    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(3)
    // runtime_exit bypasses the limiter but is deduplicated per runtime lifetime.
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    // Saturation is reported exactly once per window, not once per drop.
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(1)
  })

  it('lets critical events spend the byte reserve that normal events cannot touch', () => {
    const { events, emit } = forwarder({ maxEvents: 100, maxEnvelopeBytes: 10_000, maxWindowBytes: 1_000, windowMs: 60_000 })
    // reserve = min(64 KiB, 1000/4) = 250, so normal events stop at 750 bytes.
    const filler = { type: 'message_update', value: 'x'.repeat(700 - bytesOf({ type: 'message_update', value: '' })) }
    expect(bytesOf(filler)).toBe(700)
    emit(filler)
    expect(events).toHaveLength(1)

    const blocked = { type: 'message_update', value: 'y'.repeat(60) }
    emit(blocked)
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(1)
    const byteReports = events.filter((event) => event.type === 'transport_limit')
    expect(byteReports).toHaveLength(1)
    expect(String(byteReports[0].error)).toContain('byte rate')

    // A runtime_exit of comparable size still fits inside the reserved
    // headroom between 750 and the full 1000-byte window.
    emit({ type: 'runtime_exit', code: 3, expected: false })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)

    // The full window cap still applies to critical events; the drop is
    // silent because the bytes limit was already reported this window.
    emit({ type: 'runtime_exit', code: 3, expected: false, padding: 'z'.repeat(400) })
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(1)
  })

  it('caps repeated lifecycle events while runtime_exit stays deduplicated', () => {
    const { events, emit } = forwarder({ maxEvents: 5, windowMs: 60_000 })
    for (let index = 0; index < 40; index += 1) emit({ type: 'runtime_exit', code: 0, expected: true })
    // runtime_exit is terminal: repeated emits collapse to the single delivery.
    expect(events.filter((event) => event.type === 'runtime_exit')).toHaveLength(1)
    for (let index = 0; index < 40; index += 1) emit({ type: 'agent_start', index })
    const started = events.filter((event) => event.type === 'agent_start').length
    expect(started).toBeGreaterThan(5)
    expect(started).toBeLessThanOrEqual(32)
  })

  it('resets saturation after monotonic time elapses despite a backward wall-clock step', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let elapsed = 0
    const { events, emit } = forwarder({ maxEvents: 1, windowMs: 1_000 }, () => elapsed)
    emit({ type: 'message_update', index: 0 })
    emit({ type: 'message_update', index: 1 })
    expect(events.map((event) => event.type)).toEqual(['message_update', 'transport_limit'])

    vi.setSystemTime(900_000)
    elapsed = 1_500
    emit({ type: 'message_update', index: 2 })
    emit({ type: 'message_update', index: 3 })
    expect(events.filter((event) => event.type === 'message_update')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(2)
  })
})
