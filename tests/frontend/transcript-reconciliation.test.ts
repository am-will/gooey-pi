import { describe, expect, it } from 'vitest'
import {
  authoritativeTranscriptReadIsCurrent,
  isTranscriptTerminalEvent,
  needsTranscriptReconciliation,
  reconcileTranscriptMessages,
  reconciliationMatches,
  type TranscriptReconciliationMarker,
} from '../../src/app/agent-events'
import type { TranscriptMessage } from '../../src/types/api'

const marker: TranscriptReconciliationMarker = {
  generation: 7,
  runtimeId: 'runtime-current',
  sessionFile: '/sessions/current.jsonl',
}

describe('authoritative transcript reconciliation', () => {
  it('marks transport loss and waits for a terminal turn or runtime event', () => {
    expect(needsTranscriptReconciliation({ type: 'transport_error', error: 'the runtime event stream broke' })).toBe(true)
    expect(needsTranscriptReconciliation({ type: 'transport_limit', kind: 'count', error: 'event rate exceeded the desktop limit' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'transport_error' })).toBe(false)
    expect(isTranscriptTerminalEvent({ type: 'transport_limit' })).toBe(false)
    expect(isTranscriptTerminalEvent({ type: 'agent_end' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'error' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'extension_error' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'runtime_exit' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'compaction_end' })).toBe(true)
    expect(isTranscriptTerminalEvent({ type: 'compaction_end', willRetry: true })).toBe(false)
  })

  it('requires the same generation, runtime, and session before starting the reread', () => {
    expect(reconciliationMatches(marker, 7, 'runtime-current', '/sessions/current.jsonl')).toBe(true)
    expect(reconciliationMatches(marker, 8, 'runtime-current', '/sessions/current.jsonl')).toBe(false)
    expect(reconciliationMatches(marker, 7, 'runtime-new', '/sessions/current.jsonl')).toBe(false)
    expect(reconciliationMatches(marker, 7, 'runtime-current', '/sessions/other.jsonl')).toBe(false)
  })

  it('rejects a stale authoritative result after a workspace or runtime takeover', () => {
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-current')).toBe(true)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 8,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-current')).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/other.jsonl',
    }, 'runtime-current')).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, 'runtime-new')).toBe(false)
  })

  it('allows the terminal runtime result after runtime_exit clears the active runtime id', () => {
    expect(authoritativeTranscriptReadIsCurrent(marker, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
    }, null)).toBe(true)
  })

  it('merges background reads so a trailing optimistic user message survives', () => {
    const message = (id: string, role: TranscriptMessage['role'], text: string): TranscriptMessage => ({
      id, role, timestamp: 1, parts: [{ type: 'text', text }],
    })
    const persisted = message('record-1', 'assistant', 'earlier answer')
    const optimistic = message('user-1754500000000', 'user', 'run the tests')

    expect(reconcileTranscriptMessages([persisted, optimistic], [persisted]))
      .toEqual([persisted, optimistic])
    expect(reconcileTranscriptMessages(
      [persisted, optimistic],
      [persisted, message('record-2', 'user', 'run the tests')],
    )).toEqual([persisted, message('record-2', 'user', 'run the tests')])
  })

  it('preserves a local fallback notice until persistence catches up without duplicating it', () => {
    const message = (id: string, role: TranscriptMessage['role'], text: string): TranscriptMessage => ({
      id, role, timestamp: 1, parts: [{ type: 'text', text }],
    })
    const persisted = message('record-1', 'assistant', 'earlier answer')
    const fallbackText = 'Switched to anthropic/claude-sonnet due to a provider fallback'
    const fallback = message('fallback-1754500000000', 'system', fallbackText)
    const persistedFallback = message('record-2', 'system', fallbackText)

    expect(reconcileTranscriptMessages([persisted, fallback], [persisted]))
      .toEqual([persisted, fallback])
    expect(reconcileTranscriptMessages([persisted, fallback], [persisted, persistedFallback]))
      .toEqual([persisted, persistedFallback])
  })

  it('does not resurrect disk-loaded rows removed by an authoritative rewrite', () => {
    const message = (id: string, role: TranscriptMessage['role'], text: string): TranscriptMessage => ({
      id, role, timestamp: 1, parts: [{ type: 'text', text }],
    })
    const rewritten = [message('record-9', 'assistant', 'compacted summary')]
    expect(reconcileTranscriptMessages(
      [message('record-1', 'assistant', 'earlier'), message('record-2', 'user', 'old prompt')],
      rewritten,
    )).toEqual(rewritten)
  })

  it('rejects a reconciliation result after a new same-runtime prompt is admitted', () => {
    expect(authoritativeTranscriptReadIsCurrent({ ...marker, admissionRevision: 2 }, {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
      admissionRevision: 2,
    }, 'runtime-current')).toBe(true)
    const afterAdmission = {
      generation: 7,
      sessionFile: '/sessions/current.jsonl',
      admissionRevision: 3,
    }
    expect(authoritativeTranscriptReadIsCurrent(
      { ...marker, admissionRevision: 2 },
      afterAdmission,
      'runtime-current',
    )).toBe(false)
    expect(authoritativeTranscriptReadIsCurrent(
      { ...marker, admissionRevision: 2 },
      afterAdmission,
      null,
    )).toBe(false)
  })

})
