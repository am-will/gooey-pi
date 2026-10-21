import type { PrimeEventReplayStats } from '../../src/lib/events/reduce'
import { resetTranscriptIdsForTests } from '../../src/lib/events/ids'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PendingAgentEvent } from '../../src/app/agent-events'
import { createScopedRequestGuard } from '../../src/app/scoped-request'
import { areSidebarPropsEqual, boundedSidebarSessions, indexSidebarSessions, type SidebarProps } from '../../src/components/Sidebar'
import {
  ACTIVITY_BATCH,
  growActivityBatch,
  updateActivityCriteria,
  type ActivityViewState,
} from '../../src/pages/ActivityPage'
import { applyPrimeEvent, createPrimeEventBuffer, createSteerAcceptedEvent, createSteerPickupEvent, replayPrimeEvents } from '../../src/lib/events'
import { reconcileTranscripts } from '../../src/app/transcript-reconcile'
import { createSidebarActionProxy } from '../../src/hooks/useSidebarActions'
import { mergeSessionCatalog } from '../../src/hooks/useBootstrap'
import { shouldRefreshGitOnSessionTransition } from '../../src/lib/workspace'
import type { ProjectRecord, SessionRecord, TranscriptMessage } from '../../src/types/api'

Object.defineProperty(globalThis, 'self', { value: globalThis })
afterEach(() => vi.restoreAllMocks())
const { admitAgentEvent, eventsForWorkspace } = await import('../../src/app/agent-events')

const transcript = (): TranscriptMessage[] => [{
  id: 'assistant-1',
  role: 'assistant',
  timestamp: 1,
  streaming: true,
  parts: [{ type: 'text', text: 'loaded:' }],
}]

const delta = (text: string): Record<string, unknown> => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: text },
})

const transcriptText = (messages: TranscriptMessage[]) => {
  const part = messages[0]?.parts[0]
  return part?.type === 'text' ? part.text : undefined
}

function runTranscriptRace(frameBeforeRead: boolean): TranscriptMessage[] {
  const eventBuffer = createPrimeEventBuffer()
  const pendingLoad = { generation: 4, eventBuffer }
  const frameQueue: PendingAgentEvent[] = []
  const events = [delta('one'), delta('-two')]

  expect(events.map((event) => admitAgentEvent(4, event, pendingLoad, frameQueue))).toEqual(['transcript', 'transcript'])

  let messages: TranscriptMessage[] = []
  const flushFrame = () => {
    messages = eventsForWorkspace(frameQueue.splice(0), 4)
      .reduce((current, event) => applyPrimeEvent(current, event), messages)
  }
  const finishRead = () => { messages = eventBuffer.replay(transcript()) }

  if (frameBeforeRead) {
    flushFrame()
    finishRead()
  } else {
    finishRead()
    flushFrame()
  }
  return messages
}

describe('streamed transcript event ownership', () => {
  it('applies buffered deltas exactly once when the transcript read resolves before RAF', () => {
    expect(transcriptText(runTranscriptRace(false))).toBe('loaded:one-two')
  })

  it('applies buffered deltas exactly once and in order when RAF runs before the transcript read', () => {
    expect(transcriptText(runTranscriptRace(true))).toBe('loaded:one-two')
  })

  it('preserves frame order and rejects events from an old workspace generation', () => {
    const queue: PendingAgentEvent[] = [
      { generation: 2, event: delta('old') },
      { generation: 3, event: delta('new-1') },
      { generation: 3, event: delta('-new-2') },
    ]
    const messages = eventsForWorkspace(queue, 3).reduce(
      (current, event) => applyPrimeEvent(current, event),
      transcript(),
    )

    expect(transcriptText(messages)).toBe('loaded:new-1-new-2')
  })
})

const sidebarProps = (onNewSession: () => void): SidebarProps => ({
  projects: [],
  sessions: [],
  activeView: 'projects',
  onSelectProject: () => undefined,
  onSelectSession: () => undefined,
  onNavigate: () => undefined,
  onNewSession,
  onAddProject: () => undefined,
  onRemoveProject: () => undefined,
  onClose: () => undefined,
  onOpenPalette: () => undefined,
  onRenameSession: async () => undefined,
  onArchiveSession: async () => undefined,
})

describe('Sidebar memoization and scale bounds', () => {
  it('rejects a streaming parent rerender when navigation data and stable handlers are unchanged', () => {
    const callbacks = sidebarProps(() => undefined)
    const before = { ...callbacks }
    const streamedMessages = applyPrimeEvent(transcript(), delta('next frame'))
    const after = { ...callbacks }

    expect(streamedMessages).not.toBe(transcript())
    expect(areSidebarPropsEqual(before, after)).toBe(true)
  })

  it('keeps callback identities stable while dispatching to the latest App render', () => {
    let oldCalls = 0
    let newCalls = 0
    const previous = sidebarProps(() => { oldCalls += 1 })
    const proxy = createSidebarActionProxy(previous)
    const stable = proxy.callbacks
    proxy.update(sidebarProps(() => { newCalls += 1 }))

    expect(proxy.callbacks).toBe(stable)
    stable.onNewSession()
    expect(oldCalls).toBe(0)
    expect(newCalls).toBe(1)
    expect(areSidebarPropsEqual({ ...previous, ...stable }, { ...previous, ...proxy.callbacks })).toBe(true)
  })

  it('indexes 5,000 sessions once and bounds rendered rows per project', () => {
    const project: ProjectRecord = {
      id: 'large', harness: 'prime', name: 'Large', path: '/large', folders: ['/large'], primaryFolder: '/large',
      pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 5_000,
    }
    const sessions: SessionRecord[] = Array.from({ length: 5_000 }, (_, index) => ({
      id: `session-${index}`, harness: 'prime' as const, projectPath: '/large', filePath: `/sessions/${index}.jsonl`, title: `Session ${index}`,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
    }))
    const stats = { projectPaths: 0, sessionScans: 0 }
    const indexed = indexSidebarSessions([project], sessions, stats)
    const rows = boundedSidebarSessions(indexed.sessionsByProject.get(project.id) ?? [])

    expect(stats).toEqual({ projectPaths: 1, sessionScans: 5_000 })
    expect(indexed.activeSessions).toHaveLength(5_000)
    expect(rows).toHaveLength(7)
  })
})

describe('Activity batching', () => {
  const initial = (): ActivityViewState => ({ filter: 'all', query: '', visibleLimit: ACTIVITY_BATCH })

  it('grows by one bounded batch', () => {
    expect(growActivityBatch(initial(), 1_000).visibleLimit).toBe(500)
    expect(growActivityBatch({ ...initial(), visibleLimit: 750 }, 800).visibleLimit).toBe(800)
  })

  it('resets the limit atomically with query and filter changes', () => {
    const expanded = { ...initial(), visibleLimit: 750 }
    expect(updateActivityCriteria(expanded, { query: 'running' })).toEqual({
      filter: 'all', query: 'running', visibleLimit: ACTIVITY_BATCH,
    })
    expect(updateActivityCriteria(expanded, { filter: 'running' })).toEqual({
      filter: 'running', query: '', visibleLimit: ACTIVITY_BATCH,
    })
  })
})


afterEach(() => { vi.useRealTimers() })

describe('batched Prime event reduction', () => {
  it('anchors an accepted steer immediately, then marks the exact pickup boundary', () => {
    const steer = { id: 'queued-1', text: 'change direction', intent: 'steer' as const, timestamp: 2, parts: [{ type: 'text' as const, text: 'change direction' }] }
    const result = replayPrimeEvents(transcript(), [
      delta('before acceptance'),
      createSteerAcceptedEvent(steer),
      delta('still finishing the current work'),
      createSteerPickupEvent([steer]),
      { type: 'turn_start' },
      delta('after pickup'),
    ])

    expect(result.map((message) => [message.role, message.kind])).toEqual([
      ['assistant', undefined],
      ['user', undefined],
      ['assistant', undefined],
      ['system', 'steer-read-marker'],
      ['assistant', undefined],
    ])
    expect(result[1]).toMatchObject({ id: 'user-queued-1', steerState: 'read' })
    expect(result[2]?.parts).toEqual([{ type: 'text', text: 'still finishing the current work', partId: expect.any(String) }])
    expect(result[3]?.parts).toEqual([{ type: 'text', text: 'Steer read here', notice: { kind: 'steer-read', count: 1 } }])
    expect(result[4]?.parts).toEqual([{ type: 'text', text: 'after pickup', partId: expect.any(String) }])
  })

  it('places repeated picked-up steers between the tool segments that consumed them', () => {
    const result = replayPrimeEvents(transcript(), [
      { type: 'tool_execution_start', toolCallId: 'read', toolName: 'Read', args: { path: 'before.ts' } },
      createSteerPickupEvent([{ id: 'queued-1', text: 'change direction', intent: 'steer', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] }]),
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'write', toolName: 'Write', args: { path: 'after.ts' } },
      createSteerPickupEvent([{ id: 'queued-2', text: 'also compare the physics', intent: 'steer', timestamp: 3, parts: [{ type: 'text', text: 'also compare the physics' }] }]),
      { type: 'turn_start' },
      delta('continued after both pickups'),
    ])

    expect(result.map((message) => message.role)).toEqual(['assistant', 'user', 'system', 'assistant', 'user', 'system', 'assistant'])
    expect(result[0]?.streaming).toBe(false)
    expect(result[0]?.parts.some((part) => part.type === 'toolCall' && part.name === 'Read')).toBe(true)
    expect(result[1]).toMatchObject({ id: 'user-queued-1', timestamp: 2, parts: [{ type: 'text', text: 'change direction' }] })
    expect(result[2]).toMatchObject({ kind: 'steer-read-marker' })
    expect(result[3]).toMatchObject({ role: 'assistant', streaming: false })
    expect(result[3]?.parts.some((part) => part.type === 'toolCall' && part.name === 'Write')).toBe(true)
    expect(result[4]).toMatchObject({ id: 'user-queued-2', timestamp: 3, parts: [{ type: 'text', text: 'also compare the physics' }] })
    expect(result[5]).toMatchObject({ kind: 'steer-read-marker' })
    expect(result[6]?.streaming).toBe(true)
    expect(result[6]?.parts).toEqual([{ type: 'text', text: 'continued after both pickups', partId: expect.any(String) }])
  })

  it.each([false, true])('keeps tool execution in its owning segment across an accepted steer (delta first: %s)', (deltaFirst) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const start = deltaFirst
      ? { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 't1', name: 'Read', arguments: { path: 'a' } } } }
      : { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Read', args: { path: 'a' } }
    const events = [start, createSteerAcceptedEvent({ id: 'queued', text: 'redirect', intent: 'steer', timestamp: 2 }),
      { type: 'tool_execution_start', toolCallId: 't1', toolName: 'Read' },
      { type: 'tool_execution_update', toolCallId: 't1', toolName: 'Read', partialResult: 'partial' },
      { type: 'tool_execution_end', toolCallId: 't1', toolName: 'Read', result: 'done' }]
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(transcript(), events)
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    expect(batched).toEqual(sequential)
    expect(batched.map(({ role }) => role)).toEqual(['assistant', 'user'])
    expect(batched.flatMap(({ parts }) => parts).filter((part) => part.type === 'toolCall')).toHaveLength(1)
    expect(batched[0]?.parts.at(-1)).toMatchObject({ type: 'toolResult', text: 'done' })
  })

  it('does not reuse a completed id-less tool from before a steer', () => {
    const result = replayPrimeEvents(transcript(), [
      { type: 'tool_execution_start', toolName: 'bash' }, { type: 'tool_execution_end', toolName: 'bash', result: 'one-done' },
      createSteerAcceptedEvent({ id: 'queued', text: 'redirect', intent: 'steer', timestamp: 2 }),
      { type: 'tool_execution_start', toolName: 'bash' }, { type: 'tool_execution_end', toolName: 'bash', result: 'two-done' },
    ])
    expect(result.map(({ role }) => role)).toEqual(['assistant', 'user', 'assistant'])
    expect(result[0]?.parts.at(-1)).toMatchObject({ type: 'toolResult', text: 'one-done' })
    expect(result[2]?.parts.at(-1)).toMatchObject({ type: 'toolResult', text: 'two-done' })
  })

  it('is equivalent to ordered single-event reduction across text, thinking, and tool merges', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const events: Record<string, unknown>[] = [
      delta('hello'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' } },
      { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' }, partialResult: 'partial' },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '-after-tool' } },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: { output: 'done' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'tool-2', name: 'Write', arguments: { path: 'b' } } } },
      { type: 'tool_execution_end', toolCallId: 'tool-2', toolName: 'Write', result: 'written', isError: false },
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(transcript(), events)

    expect(batched).toEqual(sequential)
    expect(batched[0]?.parts.map((part) => part.type)).toEqual([
      'text', 'thinking', 'toolCall', 'toolResult', 'text', 'toolCall', 'toolResult',
    ])
  })

  it('walks a large transcript a bounded number of times for a large delta frame', () => {
    const source = Array.from({ length: 2_000 }, (_, index): TranscriptMessage => ({
      id: `message-${index}`,
      role: index === 1_999 ? 'assistant' : 'user',
      timestamp: index,
      streaming: index === 1_999,
      parts: index === 1_999 ? [{ type: 'text', text: '' }] : [{ type: 'text', text: 'old' }],
    }))
    let indexedReads = 0
    const measured = new Proxy(source, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) indexedReads += 1
        return Reflect.get(target, key, receiver)
      },
    })
    const result = replayPrimeEvents(measured, Array.from({ length: 1_000 }, () => delta('x')))

    expect(transcriptText([result.at(-1)!])).toBe('x'.repeat(1_000))
    expect(indexedReads).toBeLessThan(6_100)
  })
})

describe('Sidebar root-render isolation', () => {
  it('retains every callback identity across transcript-only renders while dispatching current actions', () => {
    let selected = 'old'
    const old = sidebarProps(() => { selected = 'old-called' })
    const proxy = createSidebarActionProxy(old)
    const first = { ...old, ...proxy.callbacks }
    const latest = { ...first, onNewSession: () => { selected = 'latest-called' } }
    proxy.update(latest)
    const afterTranscriptRender = { ...first, ...proxy.callbacks }

    expect(areSidebarPropsEqual(first, afterTranscriptRender)).toBe(true)
    expect(Object.keys(proxy.callbacks).every((key) => (
      first[key as keyof SidebarProps] === afterTranscriptRender[key as keyof SidebarProps]
    ))).toBe(true)
    afterTranscriptRender.onNewSession()
    expect(selected).toBe('latest-called')
  })
})


describe('linear event batches', () => {
  it('is equivalent to sequential replay across text, tools, errors, and turn boundaries', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42)
    const events: Record<string, unknown>[] = [
      { type: 'turn_start' },
      delta('hello'),
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'plan' } },
      { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' } },
      { type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'Read', args: { path: 'a' }, partialResult: 'partial' },
      { type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'Read', result: 'done' },
      delta(' world'),
      { type: 'agent_end' },
      { type: 'turn_start' },
      { type: 'message_update', delta: { type: 'toolcall_end', toolCall: { id: 'tool-2', name: 'Write', arguments: { path: 'b' } } } },
      { type: 'tool_execution_end', toolCallId: 'tool-2', toolName: 'Write', result: { output: 'saved' } },
      { type: 'runtime_exit', expected: true },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    expect(replayPrimeEvents(transcript(), events)).toEqual(sequential)
  })

  it('pairs id-less tool executions onto one tool row instead of adding a phantom row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
    const events: Record<string, unknown>[] = [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolName: 'Anonymous', args: { path: 'a' } },
      { type: 'tool_execution_end', toolName: 'Anonymous', result: 'done' },
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(transcript(), events)

    expect(batched).toEqual(sequential)
    const parts = batched[0]?.parts ?? []
    expect(parts.filter((part) => part.type === 'toolCall')).toHaveLength(1)
    expect(parts.filter((part) => part.type === 'toolResult')).toHaveLength(1)
    const call = parts.find((part) => part.type === 'toolCall')
    expect(call && 'id' in call ? call.id : undefined).toBeTruthy()
  })

  it('keeps the args captured at tool start when an execution update omits them', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    resetTranscriptIdsForTests()
    const events: Record<string, unknown>[] = [
      { type: 'turn_start' },
      { type: 'tool_execution_start', toolCallId: 'one', toolName: 'One', args: { command: 'ls -la' } },
      { type: 'tool_execution_update', toolCallId: 'one', toolName: 'One', partialResult: 'partial' },
    ]
    const messages = replayPrimeEvents(transcript(), events)
    const call = messages.flatMap((message) => message.parts).find((part) => part.type === 'toolCall')
    expect(call && 'args' in call ? call.args : undefined).toEqual({ command: 'ls -la' })
  })

  it('matches single-event semantics for deterministic mixed-event permutations', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    const pool: Record<string, unknown>[] = [
      { type: 'turn_start' }, delta('a'),
      { type: 'message_update', delta: { type: 'thinking_delta', delta: 'b' } },
      { type: 'tool_execution_start', toolCallId: 'one', toolName: 'One', args: 1 },
      { type: 'tool_execution_update', toolCallId: 'one', toolName: 'One', partialResult: 'partial' },
      { type: 'tool_execution_end', toolCallId: 'one', toolName: 'One', result: 'done' },
      { type: 'tool_execution_start', toolName: 'Anonymous' },
      { type: 'tool_execution_update', toolName: 'Anonymous', partialResult: 'partial' },
      { type: 'tool_execution_end', toolName: 'Anonymous', result: 'done' },
      { type: 'agent_end' }, { type: 'error', message: 'failed' },
      { type: 'runtime_exit', expected: true },
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: false, result: { summary: 'Trimmed earlier work.', tokensBefore: 4_096, firstKeptEntryId: 'kept-1' } },
      { type: 'compaction_end', reason: 'manual', aborted: true },
    ]
    let seed = 0x5eed
    const random = () => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed }
    for (let run = 0; run < 100; run += 1) {
      const events = Array.from({ length: 80 }, () => pool[random() % pool.length])
      resetTranscriptIdsForTests()
      const sequential = events.reduce((current, event) => applyPrimeEvent(current, event), transcript())
      resetTranscriptIdsForTests()
      expect(replayPrimeEvents(transcript(), events)).toEqual(sequential)
    }
  })

  it('opens a fresh assistant turn after a compaction row carried over from a prior batch', () => {
    vi.spyOn(Date, 'now').mockReturnValue(7)
    const batchA: Record<string, unknown>[] = [{ type: 'compaction_start', reason: 'threshold' }]
    const batchB: Record<string, unknown>[] = [
      { type: 'agent_start' },
      delta('after compaction'),
      { type: 'agent_end' },
    ]
    resetTranscriptIdsForTests()
    const sequential = [...batchA, ...batchB].reduce((current, event) => applyPrimeEvent(current, event), transcript())
    resetTranscriptIdsForTests()
    const batched = replayPrimeEvents(replayPrimeEvents(transcript(), batchA), batchB)

    expect(batched).toEqual(sequential)
    expect(batched.filter((message) => message.role === 'assistant')).toHaveLength(2)
    expect(batched.at(-1)?.parts).toMatchObject([{ type: 'text', text: 'after compaction' }])
  })

  it('uses one bounded state commit for each sustained frame batch', () => {
    const original: TranscriptMessage[] = Array.from({ length: 500 }, (_, index) => ({
      id: `message-${index}`, role: index === 499 ? 'assistant' : 'user', timestamp: index,
      streaming: index === 499, parts: [{ type: 'text', text: index === 499 ? '' : 'stable' }],
    }))
    let state = original
    let commits = 0
    for (let batch = 0; batch < 50; batch += 1) {
      const events = Array.from({ length: 200 }, () => delta('x'))
      const stats: PrimeEventReplayStats = { messageScans: 0, eventScans: 0, partScans: 0, transcriptCopies: 0 }
      const next = replayPrimeEvents(state, events, stats)
      commits += 1
      expect(stats.messageScans).toBe(500)
      expect(stats.eventScans).toBe(200)
      expect(stats.partScans).toBeLessThanOrEqual(2)
      expect(stats.transcriptCopies).toBe(1)
      expect(next[0]).toBe(state[0])
      state = next
    }
    expect(commits).toBe(50)
    expect(transcriptText([state[499]])).toHaveLength(10_000)
  })
})

describe('external sync reconciliation', () => {
  const syncTranscript = (): TranscriptMessage[] => [
    { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'question' }] },
    { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'text', text: 'answer' }, { type: 'toolCall', id: 'tool-1', name: 'Read', args: { path: 'a' } }] },
    { id: 'assistant-2', role: 'assistant', timestamp: 3, streaming: true, parts: [{ type: 'text', text: 'stream' }] },
  ]

  it('keeps object identity for unchanged messages across a sync tick so memoized rows skip re-rendering', () => {
    const current = syncTranscript()
    const fromDisk = structuredClone(current)
    const streamedPart = fromDisk[2]!.parts[0]
    if (streamedPart?.type === 'text') streamedPart.text = 'stream-extended'

    const merged = reconcileTranscripts(current, fromDisk)

    expect(merged[0]).toBe(current[0])
    expect(merged[1]).toBe(current[1])
    expect(merged[2]).not.toBe(current[2])
    expect(merged[2]).toBe(fromDisk[2])
  })

  it('returns the current array identity when a re-read changes nothing', () => {
    const current = syncTranscript()
    expect(reconcileTranscripts(current, structuredClone(current))).toBe(current)
  })

  it('treats absent optional fields and undefined values as equal, but not content changes', () => {
    const current = syncTranscript()
    const fromDisk = structuredClone(current)
    fromDisk[0]!.agentName = undefined
    expect(reconcileTranscripts(current, fromDisk)[0]).toBe(current[0])

    const changedArgs = structuredClone(current)
    const tool = changedArgs[1]!.parts[1]
    if (tool?.type === 'toolCall') tool.args = { path: 'b' }
    expect(reconcileTranscripts(current, changedArgs)[1]).toBe(changedArgs[1])
  })

  it('adopts reordered and new messages from the authoritative read', () => {
    const current = syncTranscript()
    const fromDisk = [...structuredClone(current), { id: 'assistant-3', role: 'assistant' as const, timestamp: 4, parts: [] }]
    const merged = reconcileTranscripts(current, fromDisk)
    expect(merged).toHaveLength(4)
    expect(merged[0]).toBe(current[0])
    expect(merged[3]).toBe(fromDisk[3])
  })
})

describe('catalog tick session identity', () => {
  const record = (filePath: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: filePath, harness: 'prime', projectPath: '/project', filePath, title: 'Session',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle', depth: 0, ...overrides,
  })

  it('bumps syncRevision only for sessions whose file changed and keeps identity for the rest', () => {
    const current = [record('/a.jsonl', { syncRevision: 3 }), record('/b.jsonl', { syncRevision: 5 })]
    const merged = mergeSessionCatalog(
      current,
      [record('/a.jsonl'), record('/b.jsonl')],
      undefined,
      new Map([['/a.jsonl', 7]]),
      0,
    )
    expect(merged[0]?.syncRevision).toBe(7)
    expect(merged[0]).not.toBe(current[0])
    expect(merged[1]).toBe(current[1])
    expect(merged[1]?.syncRevision).toBe(5)
  })

  it('does not spread a catalog-only revision onto untouched sessions', () => {
    const current = [record('/a.jsonl', { syncRevision: 3 }), record('/b.jsonl', { syncRevision: 5 })]
    const merged = mergeSessionCatalog(
      current,
      [record('/a.jsonl', { updatedAt: '2026-01-02T00:00:00.000Z' }), record('/b.jsonl')],
      undefined,
      new Map(),
      9,
    )
    expect(merged[0]?.syncRevision).toBe(9)
    expect(merged[1]).toBe(current[1])
    expect(merged[1]?.syncRevision).toBe(5)
  })
})

describe('streaming markdown parse throttling', () => {
  it('parses at most once per interval while holding the previous committed snapshot', async () => {
    const { advanceStreamingParse, STREAMING_PARSE_INTERVAL_MS } = await import('../../src/components/MarkdownText')
    const first = advanceStreamingParse({ boundary: 0, lastParseAt: 0 }, 10, false, 1_000)
    expect(first.state).toEqual({ boundary: 10, lastParseAt: 1_000 })
    expect(first.delayMs).toBeUndefined()

    // More deltas inside the interval: keep the coherent old snapshot and retry later.
    const throttled = advanceStreamingParse(first.state, 25, false, 1_040)
    expect(throttled.state).toBe(first.state)
    expect(throttled.delayMs).toBe(STREAMING_PARSE_INTERVAL_MS - 40)

    // A newline in the unparsed tail commits immediately.
    const newline = advanceStreamingParse(first.state, 25, true, 1_040)
    expect(newline.state).toEqual({ boundary: 25, lastParseAt: 1_040 })

    // Once the interval elapses the boundary advances.
    const elapsed = advanceStreamingParse(first.state, 25, false, 1_000 + STREAMING_PARSE_INTERVAL_MS)
    expect(elapsed.state.boundary).toBe(25)

    // Unchanged text is a no-op; shrunk text re-parses from the new end.
    expect(advanceStreamingParse(elapsed.state, 25, false, 2_000).state).toBe(elapsed.state)
    expect(advanceStreamingParse(elapsed.state, 5, false, 2_000).state).toEqual({ boundary: 5, lastParseAt: 2_000 })
  })

  it('summarizes the transcript with a single reverse walk that stops at the first text part', async () => {
    const { summarizeTranscript } = await import('../../src/components/inspector/SummaryPanel')
    const messages: TranscriptMessage[] = [
      { id: 'user-1', role: 'user', timestamp: 1, parts: [{ type: 'text', text: 'ask' }] },
      { id: 'assistant-1', role: 'assistant', timestamp: 2, parts: [{ type: 'toolCall', id: 'a', name: 'Read' }, { type: 'text', text: 'first answer' }] },
      { id: 'assistant-2', role: 'assistant', timestamp: 3, parts: [{ type: 'text', text: 'final answer' }, { type: 'toolCall', id: 'b', name: 'Write' }] },
      { id: 'tool-1', role: 'tool', timestamp: 4, parts: [{ type: 'toolResult', name: 'Write', text: 'done' }] },
    ]
    expect(summarizeTranscript(messages)).toEqual({ toolCount: 2, lastText: 'final answer' })
    expect(summarizeTranscript([])).toEqual({ toolCount: 0, lastText: undefined })
  })
})

describe('git refresh scheduling', () => {
  it('fires once when an externally running session stops, never per catalog tick', () => {
    expect(shouldRefreshGitOnSessionTransition('running', 'running', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', 'complete', false)).toBe(true)
    expect(shouldRefreshGitOnSessionTransition('complete', 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('idle', 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition(undefined, 'complete', false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', undefined, false)).toBe(false)
    expect(shouldRefreshGitOnSessionTransition('running', 'complete', true)).toBe(false)
  })
})

describe('scoped async ownership', () => {
  it('rejects stale request generations and paths', () => {
    const guard = createScopedRequestGuard()
    const global = guard.begin(3)
    const project = guard.begin(4, '/project')
    expect(guard.isCurrent(global, 3)).toBe(false)
    expect(guard.isCurrent(project, 4, '/other')).toBe(false)
    expect(guard.isCurrent(project, 3, '/project')).toBe(false)
    expect(guard.isCurrent(project, 4, '/project')).toBe(true)
    guard.invalidate()
    expect(guard.isCurrent(project, 4, '/project')).toBe(false)
  })

})
