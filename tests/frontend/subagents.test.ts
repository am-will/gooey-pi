import { describe, expect, it } from 'vitest'
import {
  applySubagentEvent,
  applySubagentRoster,
  EMPTY_SUBAGENT_ROSTER,
  isSubagentEvent,
  isTerminalSubagentStatus,
  pruneFinishedSubagents,
  sortSubagents,
  SUBAGENT_SUBSCRIPTION_FOR_INSPECTION,
  type SubagentRoster,
} from '../../src/lib/subagents'
import fixture from '../fixtures/omp-subagent-frames.json'

/**
 * Every frame here was captured from a live `omp --mode rpc` session
 * (omp 17.2.9, two parallel `task` subagents) rather than hand-written, so a
 * field this reducer reads from the wrong place fails here instead of in
 * production. See tests/fixtures/omp-subagent-frames.json.
 */
const frames = fixture.frames as Array<Record<string, unknown>>
const lifecycle = frames.filter((frame) => frame.type === 'subagent_lifecycle')
const progress = frames.filter((frame) => frame.type === 'subagent_progress')

function replay(input: Array<Record<string, unknown>>, from: SubagentRoster = EMPTY_SUBAGENT_ROSTER): SubagentRoster {
  return input.reduce((roster, frame) => applySubagentEvent(roster, frame), from)
}

describe('subagent frame identity', () => {
  it('reads progress identity from the nested progress object, which carries no payload.id', () => {
    // This is the field our reverse-engineered client got wrong: it probed
    // payload.id / agentId / sessionId, none of which exist on a real
    // subagent_progress frame.
    expect(progress.length).toBeGreaterThan(0)
    for (const frame of progress) expect(frame.payload).not.toHaveProperty('id')

    const roster = replay(progress)
    expect(roster.map((entry) => entry.id).sort()).toEqual(['AlphaReader', 'BetaReader'])
  })

  it('uses description as the display name and agent as the agent type', () => {
    // `agent` is the spawned agent type ("task"), not the instance name.
    const roster = replay(lifecycle)
    const alpha = roster.find((entry) => entry.id === 'AlphaReader')
    expect(alpha?.description).toBe('AlphaReader')
    expect(alpha?.agent).toBe('task')
    expect(alpha?.agentSource).toBe('bundled')
    expect(alpha?.parentToolCallId).toBeTypeOf('string')
  })

  it('classifies only the statuses the harness actually emits', () => {
    const statuses = new Set(replay(frames).map((entry) => entry.status))
    for (const status of statuses) expect(status).not.toBe('unknown')
    expect(isTerminalSubagentStatus('completed')).toBe(true)
    expect(isTerminalSubagentStatus('failed')).toBe(true)
    expect(isTerminalSubagentStatus('running')).toBe(false)
  })
})

describe('subagent roster reduction', () => {
  it('carries a real run from started through running to completed', () => {
    const roster = replay(frames)
    const beta = roster.find((entry) => entry.id === 'BetaReader')
    expect(beta?.status).toBe('completed')
    expect(beta?.toolCount).toBeGreaterThan(0)
    expect(beta?.requests).toBeGreaterThan(0)
    expect(beta?.tokens).toBeGreaterThan(0)
    expect(beta?.durationMs).toBeGreaterThan(0)
    expect(beta?.resolvedModel).toBeTypeOf('string')
    expect(beta?.lastIntent).toBeTypeOf('string')
    expect(beta?.recentTools?.[0]?.tool).toBeTypeOf('string')
  })

  it('never blanks a field an earlier frame supplied', () => {
    // A lifecycle frame carries no metrics; applying one after progress must
    // not wipe toolCount/tokens off the row.
    const withProgress = replay(progress)
    const enriched = withProgress.find((entry) => entry.id === 'AlphaReader')
    expect(enriched?.toolCount).toBeGreaterThan(0)

    const after = applySubagentEvent(withProgress, lifecycle.find((frame) => (frame.payload as Record<string, unknown>).id === 'AlphaReader')!)
    const row = after.find((entry) => entry.id === 'AlphaReader')
    expect(row?.toolCount).toBe(enriched?.toolCount)
    expect(row?.resolvedModel).toBe(enriched?.resolvedModel)
  })

  it('ignores frames it cannot use without throwing', () => {
    const roster = replay(frames)
    for (const junk of [
      { type: 'subagent_progress' },
      { type: 'subagent_progress', payload: {} },
      { type: 'subagent_lifecycle', payload: { status: 'running' } },
      { type: 'subagent_event', payload: { id: 'not-in-roster' } },
      { type: 'tool_execution_update', toolName: 'grep' },
      { type: 'subagent_progress', payload: { progress: { id: 42 } } },
    ]) {
      expect(() => applySubagentEvent(roster, junk)).not.toThrow()
      expect(applySubagentEvent(roster, junk)).toBe(roster)
    }
  })

  it('treats a subagent_event only as a liveness touch', () => {
    // GooeyPi never subscribes at the `events` level, but another client can
    // move the harness there. Such a frame must not grow the roster or store
    // the inner agent stream.
    const roster = replay(lifecycle)
    const touched = applySubagentEvent(roster, { type: 'subagent_event', payload: { id: 'AlphaReader', event: { type: 'message_update', delta: { type: 'text_delta', delta: 'x' } } } }, 9_999)
    expect(touched).toHaveLength(roster.length)
    expect(touched.find((entry) => entry.id === 'AlphaReader')?.updatedAt).toBe(9_999)
    expect(JSON.stringify(touched)).not.toContain('text_delta')
  })

  it('recognises exactly the three subagent frame types', () => {
    expect(isSubagentEvent({ type: 'subagent_lifecycle' })).toBe(true)
    expect(isSubagentEvent({ type: 'subagent_progress' })).toBe(true)
    expect(isSubagentEvent({ type: 'subagent_event' })).toBe(true)
    expect(isSubagentEvent({ type: 'tool_execution_start' })).toBe(false)
    expect(isSubagentEvent({})).toBe(false)
  })
})

describe('get_subagents roster merge', () => {
  it('reads a real get_subagents response body', () => {
    const roster = applySubagentRoster(EMPTY_SUBAGENT_ROSTER, fixture.getSubagentsResponseData)
    expect(roster).toHaveLength(2)
    expect(roster.map((entry) => entry.id).sort()).toEqual(['AlphaReader', 'BetaReader'])
    expect(roster[0].status).toBe('running')
    expect(roster[0].contextWindow).toBeGreaterThan(0)
  })

  it('merges rather than replaces, so a finished subagent does not vanish', () => {
    // OMP drops a subagent from get_subagents the moment it finishes; a
    // wholesale replace would recreate the blind spot this panel closes.
    const finished = replay(frames)
    expect(finished.some((entry) => isTerminalSubagentStatus(entry.status))).toBe(true)
    const merged = applySubagentRoster(finished, { subagents: [] })
    expect(merged).toHaveLength(finished.length)
    expect(applySubagentRoster(finished, null)).toBe(finished)
    expect(applySubagentRoster(finished, { subagents: 'nope' })).toBe(finished)
  })
})

describe('roster presentation', () => {
  it('retires finished rows only when the next parent turn starts', () => {
    const finished = replay(frames)
    const pruned = pruneFinishedSubagents(finished)
    expect(pruned.every((entry) => !isTerminalSubagentStatus(entry.status))).toBe(true)
    // Idempotent, and returns the same reference when nothing changes.
    expect(pruneFinishedSubagents(pruned)).toBe(pruned)
  })

  it('keeps running rows above finished ones and orders by parent index', () => {
    const roster: SubagentRoster = [
      { id: 'c', status: 'completed', index: 0, updatedAt: 1 },
      { id: 'b', status: 'running', index: 2, updatedAt: 1 },
      { id: 'a', status: 'running', index: 1, updatedAt: 1 },
    ]
    expect(sortSubagents(roster).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('event-volume mitigation', () => {
  it('inspects at the progress level, never at events', () => {
    // `events` re-broadcasts each subagent's own message_update /
    // tool_execution_* stream through the same non-critical forwarder budget
    // as the parent transcript. Measured on omp 17.2.9 for the same two-
    // subagent workload: progress = 82 progress frames, 0 event frames, peak
    // 9 frames/s; events = 90 progress + 196 event frames, peak 43 frames/s.
    expect(SUBAGENT_SUBSCRIPTION_FOR_INSPECTION).toBe('progress')
  })
})
