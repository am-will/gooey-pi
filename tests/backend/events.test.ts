import { describe, expect, it, vi } from 'vitest'
import { applyPrimeEvent, createPrimeEventBuffer, replayPrimeEvents, resetTranscriptIdsForTests } from '../../src/lib/events'
import type { TranscriptMessage } from '../../src/types/api'

const streamingMessage = (): TranscriptMessage => ({
  id: 'assistant-1', role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text: 'partial' }],
})

describe('agent transport events', () => {
  it('finalizes the stream and shows transport errors', () => {
    const messages = applyPrimeEvent([streamingMessage()], { type: 'transport_error', error: 'Malformed agent output' })

    expect(messages[0].streaming).toBe(false)
    expect(messages.at(-1)?.role).toBe('system')
    expect(messages.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'Malformed agent output' }])
  })

  it('keeps the stream open when the desktop rate limiter drops events', () => {
    const messages = applyPrimeEvent([streamingMessage()], { type: 'transport_limit', kind: 'count', error: 'Prime Agent event rate exceeded the desktop limit' })

    expect(messages[0].streaming).toBe(true)
    expect(messages.at(-1)?.role).toBe('assistant')
  })

  it('explains an unexpected runtime exit without duplicating an existing error', () => {
    const exited = applyPrimeEvent([streamingMessage()], { type: 'runtime_exit', code: 2, expected: false })
    expect(exited.at(-1)?.parts[0]).toMatchObject({ type: 'text', text: 'The agent stopped unexpectedly (exit code 2). Send the message again to restart it.' })

    const afterTransportError = applyPrimeEvent(exited, { type: 'runtime_exit', code: 2, expected: false })
    expect(afterTransportError).toHaveLength(exited.length)
  })

  it('nests live agent messages in the streaming assistant activity', () => {
    const event = {
      type: 'custom_message', customType: 'agent_message', content: 'fallback',
      details: { message: 'Review complete.', from: { sessionName: 'reviewer' } },
    }
    const applied = applyPrimeEvent([streamingMessage()], event)
    expect(applied[0].parts.at(-1)).toMatchObject({ type: 'agentMessage', text: 'Review complete.', agentName: 'reviewer' })

    const buffered = createPrimeEventBuffer()
    buffered.push(event)
    expect(buffered.replay([streamingMessage()])[0].parts.at(-1)).toMatchObject({ type: 'agentMessage', text: 'Review complete.', agentName: 'reviewer' })
  })

  it('replays live events over an older transcript load result', () => {
    const pendingLoadEvents = createPrimeEventBuffer()
    pendingLoadEvents.push({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' plus live output' } })
    pendingLoadEvents.push({ type: 'agent_end' })

    const loaded = pendingLoadEvents.replay([streamingMessage()])
    expect(pendingLoadEvents.size).toBe(2)
    expect(loaded[0].parts).toEqual([{ type: 'text', text: 'partial plus live output' }])
    expect(loaded[0].streaming).toBe(false)
  })

  it('keeps automatic continuations in the same assistant turn after an agent end', () => {
    const events: Record<string, unknown>[] = [
      { type: 'agent_end' },
      {
        type: 'custom_message', customType: 'agent_message', content: 'fallback',
        details: { message: 'Child work finished.', from: { sessionName: 'reviewer' } },
      },
      { type: 'agent_end' },
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'next-tool', toolName: 'Read', args: { path: 'next.ts' } },
      { type: 'tool_execution_end', toolCallId: 'next-tool', toolName: 'Read', result: 'done' },
      { type: 'agent_end' },
    ]
    const assertContinuousTurn = (messages: TranscriptMessage[]) => {
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({ id: 'assistant-1', role: 'assistant', streaming: false })
      expect(messages[0].parts.map((part) => part.type)).toEqual(['text', 'agentMessage', 'toolCall', 'toolResult'])
    }

    assertContinuousTurn(events.reduce((messages, event) => applyPrimeEvent(messages, event), [streamingMessage()]))
    const buffered = createPrimeEventBuffer()
    for (const event of events) buffered.push(event)
    assertContinuousTurn(buffered.replay([streamingMessage()]))
  })

  it('renders compaction start and completion without leaving a silent assistant stream', () => {
    const started = applyPrimeEvent([streamingMessage()], { type: 'compaction_start', reason: 'overflow' })
    expect(started[0]).toMatchObject({ role: 'assistant', streaming: false, parts: [{ type: 'text', text: 'partial' }] })
    expect(started.at(-1)).toMatchObject({
      role: 'system', streaming: true,
      parts: [{ type: 'compaction', status: 'running', reason: 'overflow' }],
    })

    const finished = applyPrimeEvent(started, {
      type: 'compaction_end', reason: 'overflow', willRetry: true, aborted: false,
      result: { summary: 'Earlier work was summarized.', tokensBefore: 99_175, firstKeptEntryId: 'kept-1' },
    })
    expect(finished.at(-1)).toMatchObject({ role: 'system', streaming: false, completedAt: expect.any(Number) })
    expect(finished.at(-1)?.parts[0]).toMatchObject({
      type: 'compaction', status: 'done', reason: 'overflow', tokensBefore: 99_175,
      summary: 'Earlier work was summarized.', willRetry: true,
    })
  })

  it('completes a result-less end that the harness adapter marked completed', () => {
    const started = applyPrimeEvent([streamingMessage()], { type: 'compaction_start', reason: 'threshold' })
    const finished = applyPrimeEvent(started, { type: 'compaction_end', aborted: false, willRetry: false, completed: true })
    expect(finished.at(-1)).toMatchObject({ role: 'system', streaming: false })
    expect(finished.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'done', reason: 'threshold' })
    expect(finished.at(-1)?.parts[0]).not.toHaveProperty('outcome', 'failed')
  })

  it('renders a warning end without a result as skipped', () => {
    const started = applyPrimeEvent([streamingMessage()], { type: 'compaction_start', reason: 'threshold' })
    const finished = applyPrimeEvent(started, { type: 'compaction_end', aborted: false, willRetry: false, errorSeverity: 'warning' })
    expect(finished.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'failed', outcome: 'skipped' })
  })

  it('keeps OMP idle and incomplete compaction reasons', () => {
    for (const reason of ['idle', 'incomplete']) {
      const started = applyPrimeEvent([], { type: 'compaction_start', reason })
      expect(started.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'running', reason })
      const finished = applyPrimeEvent([], { type: 'compaction_end', reason, aborted: false, willRetry: false, completed: true })
      expect(finished.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'done', reason })
    }
  })

  it('drops unknown compaction reasons, including inherited object keys', () => {
    for (const reason of ['unknown', 'toString', '__proto__', 42]) {
      const started = applyPrimeEvent([], { type: 'compaction_start', reason })
      expect(started.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'running', reason: undefined })
    }
  })

  it('keeps the running row reason and instructions when the end omits them', () => {
    const started = applyPrimeEvent([streamingMessage()], { type: 'compaction_start', reason: 'manual', customInstructions: 'Keep the API notes.' })
    const finished = applyPrimeEvent(started, {
      type: 'compaction_end', aborted: false, willRetry: false,
      result: { summary: 'Summarized.', tokensBefore: 80_000, firstKeptEntryId: 'kept-2' },
    })
    expect(finished.at(-1)?.parts[0]).toMatchObject({
      type: 'compaction', status: 'done', reason: 'manual', customInstructions: 'Keep the API notes.', summary: 'Summarized.',
    })
  })

  it('does not duplicate the persisted failure outcome and end event', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_786_074_279_000)
    const events: Record<string, unknown>[] = [
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'message_end',
        message: { role: 'custom', customType: 'compaction_outcome', content: 'Auto-compaction skipped: no model', details: { reason: 'threshold', outcome: 'skipped' } },
      },
      { type: 'compaction_end', reason: 'threshold', aborted: false, errorSeverity: 'warning', errorMessage: 'Auto-compaction skipped: no model' },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), [streamingMessage()])
    const buffered = createPrimeEventBuffer()
    for (const event of events) buffered.push(event)
    resetTranscriptIdsForTests()
    expect(buffered.replay([streamingMessage()])).toEqual(sequential)
    expect(sequential.filter((message) => message.parts.some((part) => part.type === 'compaction'))).toHaveLength(1)
    expect(sequential.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'failed', outcome: 'skipped' })
    now.mockRestore()
  })

  it('keeps each OMP compaction method as its own row when they share a reason', () => {
    // OMP falls back from a shake pass to context-full for one trigger; both ends carry the stamped start reason.
    const events: Record<string, unknown>[] = [
      { type: 'compaction_start', reason: 'threshold', action: 'shake' },
      {
        type: 'compaction_end', reason: 'threshold', action: 'shake', aborted: false, willRetry: false, skipped: true, errorSeverity: 'warning',
        errorMessage: 'Auto-shake found nothing eligible to drop; trying the next preferred compaction method.',
      },
      { type: 'compaction_start', reason: 'threshold', action: 'context-full' },
      { type: 'compaction_end', reason: 'threshold', action: 'context-full', aborted: false, willRetry: false, skipped: true, errorSeverity: 'warning' },
    ]
    const compactions = (messages: TranscriptMessage[]) => messages.flatMap((message) => message.parts.filter((part) => part.type === 'compaction'))

    const fallback = events.reduce((current, event) => applyPrimeEvent(current, event), [streamingMessage()])
    expect(compactions(fallback)).toMatchObject([
      { status: 'failed', outcome: 'skipped', reason: 'threshold', action: 'shake' },
      { status: 'failed', outcome: 'skipped', reason: 'threshold', action: 'context-full' },
    ])
    // The same method skipping again for the same reason still collapses into one row.
    const repeated = [...events.slice(2), ...events.slice(2)].reduce((current, event) => applyPrimeEvent(current, event), [streamingMessage()])
    expect(compactions(repeated)).toHaveLength(1)
  })

  it('mints distinct message ids for turns created in the same millisecond', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_786_074_279_000)
    const events: Record<string, unknown>[] = [
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } },
      { type: 'agent_end' },
      { type: 'error', message: 'boundary failed' },
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } },
    ]
    const assertDistinctIds = (messages: TranscriptMessage[]) => {
      expect(messages.length).toBeGreaterThanOrEqual(3)
      expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length)
    }

    assertDistinctIds(events.reduce<TranscriptMessage[]>((current, event) => applyPrimeEvent(current, event), []))
    assertDistinctIds(replayPrimeEvents([], events))
    now.mockRestore()
  })

  it('suppresses a duplicate system row for consecutive transport failures', () => {
    const sequential = [
      { type: 'error', message: 'first failure' },
      { type: 'transport_error', error: 'second failure' },
    ].reduce((current, event) => applyPrimeEvent(current, event), [streamingMessage()])
    expect(sequential.filter((message) => message.role === 'system')).toHaveLength(1)

    const batched = replayPrimeEvents([streamingMessage()], [
      { type: 'error', message: 'first failure' },
      { type: 'transport_error', error: 'second failure' },
    ])
    expect(batched.filter((message) => message.role === 'system')).toHaveLength(1)
  })

  it('does not duplicate a compaction already present in an authoritative reload', () => {
    const loaded: TranscriptMessage[] = [{
      id: 'persisted-compaction', role: 'system',
      parts: [{ type: 'compaction', status: 'done', reason: 'overflow', tokensBefore: 99_175, firstKeptEntryId: 'kept-1', summary: 'Earlier work.' }],
    }]
    const replayed = createPrimeEventBuffer()
    replayed.push({ type: 'compaction_start', reason: 'overflow' })
    replayed.push({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 'Earlier work.', tokensBefore: 99_175, firstKeptEntryId: 'kept-1' } })
    const result = replayed.replay(loaded)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('persisted-compaction')
  })
})
