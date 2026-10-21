import { afterEach, describe, expect, it } from 'vitest'
import { applySessionLifecycleEvent, sessionLifecycleChange } from '../../src/app/session-attention'
import { applyPrimeEvent, replayPrimeEvents } from '../../src/lib/events'
import { setFormattingLocaleForTests, translate } from '../../src/lib/i18n'
import type { SessionRecord, TranscriptMessage } from '../../src/types/api'

const session = (): SessionRecord => ({
  id: 'session',
  harness: 'prime',
  filePath: '/sessions/session.jsonl',
  projectPath: '/project',
  title: 'Session',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const delta = (text: string): Record<string, unknown> => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: text },
})

const streamingAssistant = (text?: string): TranscriptMessage[] => [{
  id: 'assistant-1',
  role: 'assistant',
  timestamp: 1,
  streaming: true,
  parts: text === undefined ? [] : [{ type: 'text', text }],
}]

// Cases below switch the plain-module locale mirror; restore it even when a
// case fails so the rest of the suite keeps the English default.
afterEach(() => setFormattingLocaleForTests('en'))

describe('provider auto-retry session lifecycle', () => {
  it('returns a session to running when a retry is scheduled after agent_end', () => {
    const ended = applySessionLifecycleEvent(session(), { type: 'agent_end' }, false, 1)
    expect(ended).toMatchObject({ status: 'complete', unread: true })
    const retrying = applySessionLifecycleEvent(ended, { type: 'auto_retry_start', attempt: 1, delayMs: 1000 }, false, 2)
    expect(retrying).toMatchObject({ status: 'running', unread: false })
  })

  it('marks the session failed only when retries are exhausted', () => {
    expect(sessionLifecycleChange({ type: 'auto_retry_end', success: false, attempt: 3 })).toMatchObject({ status: 'failed' })
    expect(sessionLifecycleChange({ type: 'auto_retry_end', success: true, attempt: 1 })).toBeUndefined()
  })
})

describe('provider auto-retry transcript continuity', () => {
  it('reopens the finalized tail assistant and removes the empty-turn fallback', () => {
    const afterEnd = applyPrimeEvent(streamingAssistant(), { type: 'agent_end' })
    expect(afterEnd[0]).toMatchObject({ streaming: false, parts: [{ type: 'text', text: 'Completed without a text response.' }] })

    const retrying = applyPrimeEvent(afterEnd, { type: 'auto_retry_start', attempt: 1, delayMs: 1000 })
    expect(retrying[0].streaming).toBe(true)
    expect(retrying[0].completedAt).toBeUndefined()
    expect(retrying[0].parts).toEqual([])
  })

  it('keeps real content from the failed attempt when reopening', () => {
    const afterEnd = applyPrimeEvent(streamingAssistant('partial answer'), { type: 'agent_end' })
    const retrying = applyPrimeEvent(afterEnd, { type: 'auto_retry_start', attempt: 1 })
    expect(retrying[0].streaming).toBe(true)
    expect(retrying[0].parts).toEqual([{ type: 'text', text: 'partial answer' }])
  })

  it('streams the retried turn into the same assistant row, batched and sequential alike', () => {
    const events: Record<string, unknown>[] = [
      { type: 'agent_end' },
      { type: 'auto_retry_start', attempt: 1 },
      { type: 'agent_start' },
      delta('recovered'),
      { type: 'agent_end' },
    ]
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), streamingAssistant())
    const batched = replayPrimeEvents(streamingAssistant(), events)
    for (const result of [sequential, batched]) {
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ streaming: false, parts: [{ type: 'text', text: 'recovered' }] })
    }
  })

  it('leaves the transcript finalized when retries are exhausted', () => {
    const events: Record<string, unknown>[] = [
      { type: 'agent_end' },
      { type: 'auto_retry_end', success: false, attempt: 3, finalError: 'overloaded' },
    ]
    const result = replayPrimeEvents(streamingAssistant('partial answer'), events)
    expect(result[0]).toMatchObject({ streaming: false })
  })

  // Replay applies events one at a time, so the fallback row keeps the language
  // that was active when the turn ended; recognising it must not depend on the
  // language active when the retry arrives.
  it('removes the empty-turn fallback after the interface language changed', () => {
    setFormattingLocaleForTests('ja')
    const afterEnd = applyPrimeEvent(streamingAssistant(), { type: 'agent_end' })
    expect(afterEnd[0]).toMatchObject({ streaming: false, parts: [{ type: 'text', text: translate('ja', 'transcript.emptyTurn') }] })

    setFormattingLocaleForTests('en')
    const retrying = applyPrimeEvent(afterEnd, { type: 'auto_retry_start', attempt: 1, delayMs: 1000 })
    expect(retrying[0].streaming).toBe(true)
    expect(retrying[0].parts).toEqual([])
  })
})

describe('transcript row identity across languages', () => {
  // The tool id is the reducer's reconciliation key for a row, so it must not
  // follow the interface language; only the placeholder name shown to the user
  // is translated.
  it('names a tool row the harness never named with a language-independent id', () => {
    setFormattingLocaleForTests('ja')
    const japanese = applyPrimeEvent(streamingAssistant(), { type: 'tool_execution_end' })
    setFormattingLocaleForTests('en')
    const english = applyPrimeEvent(streamingAssistant(), { type: 'tool_execution_end' })

    const japanesePart = japanese[0].parts.find((part) => part.type === 'toolCall')
    const englishPart = english[0].parts.find((part) => part.type === 'toolCall')
    expect(japanesePart?.id).toBe('tool-fallback:Tool')
    expect(englishPart?.id).toBe(japanesePart?.id)
    expect(japanesePart?.name).toBe(translate('ja', 'transcript.toolFallback'))
    expect(englishPart?.name).toBe('Tool')
  })
})
