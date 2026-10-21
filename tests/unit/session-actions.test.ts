import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_LENGTH,
  MAX_QUEUED_ACTIONS,
  consumeDeliveredPrompt,
  emptySessionActionSnapshot,
  isRuntimeIdle,
  parseSessionActionSnapshot,
  previewMatchesPrompt,
  sameSessionActions,
  withoutActiveAction,
} from '../../src/lib/session-actions'

describe('session action snapshots', () => {
  it('parses queue previews and active action state', () => {
    expect(parseSessionActionSnapshot({
      queuedCount: 2,
      steering: ['change direction'],
      followUps: ['run this after the turn'],
      active: { kind: 'turn', phase: 'preparing', label: 'Preparing' },
    })).toEqual({
      queuedCount: 2,
      steering: ['change direction'],
      followUps: ['run this after the turn'],
      active: { kind: 'turn', phase: 'preparing', label: 'Preparing' },
    })
  })

  it('rejects malformed snapshots without throwing', () => {
    expect(parseSessionActionSnapshot(null)).toBeNull()
    expect(parseSessionActionSnapshot({ queuedCount: -1, steering: [], followUps: [] })).toBeNull()
    expect(parseSessionActionSnapshot({ queuedCount: 1, steering: 'not-an-array', followUps: [] })).toBeNull()
    expect(parseSessionActionSnapshot({ queuedCount: 1, steering: [], followUps: [], active: { kind: 'bad', phase: 'bad' } })).toBeNull()
  })

  it('rejects queue snapshots over the payload bounds', () => {
    expect(parseSessionActionSnapshot({
      queuedCount: MAX_QUEUED_ACTIONS + 1,
      steering: [],
      followUps: [],
    })).toBeNull()
    expect(parseSessionActionSnapshot({
      queuedCount: 1,
      steering: Array.from({ length: MAX_QUEUED_ACTIONS + 1 }, () => 'item'),
      followUps: [],
    })).toBeNull()
  })

  it('truncates over-long previews instead of discarding the snapshot', () => {
    const longSteer = 'steer '.repeat(2_000).slice(0, 10_000)
    const snapshot = parseSessionActionSnapshot({
      queuedCount: 2,
      steering: [longSteer, 'short steer'],
      followUps: ['x'.repeat(MAX_PREVIEW_LENGTH + 1)],
      active: { kind: 'turn', phase: 'running', label: 'y'.repeat(MAX_PREVIEW_LENGTH + 10) },
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.queuedCount).toBe(2)
    expect(snapshot?.steering[0]).toHaveLength(MAX_PREVIEW_LENGTH)
    expect(longSteer.startsWith(snapshot?.steering[0] ?? '')).toBe(true)
    expect(snapshot?.steering[1]).toBe('short steer')
    expect(snapshot?.followUps).toEqual(['x'.repeat(MAX_PREVIEW_LENGTH)])
    expect(snapshot?.active).toEqual({ kind: 'turn', phase: 'running', label: 'y'.repeat(MAX_PREVIEW_LENGTH) })
    expect(parseSessionActionSnapshot({ queuedCount: 1, steering: ['z'.repeat(MAX_PREVIEW_LENGTH)], followUps: [] })?.steering[0])
      .toHaveLength(MAX_PREVIEW_LENGTH)
  })

  it('still rejects non-string previews and labels', () => {
    expect(parseSessionActionSnapshot({ queuedCount: 1, steering: [42], followUps: [] })).toBeNull()
    expect(parseSessionActionSnapshot({ queuedCount: 1, steering: [], followUps: [null] })).toBeNull()
    expect(parseSessionActionSnapshot({ queuedCount: 0, steering: [], followUps: [], active: { kind: 'turn', phase: 'running', label: 5 } })).toBeNull()
  })

  it('provides a fresh empty snapshot for runtimes without queue state', () => {
    const first = emptySessionActionSnapshot()
    const second = emptySessionActionSnapshot()
    first.steering.push('mutated')
    expect(second).toEqual({ queuedCount: 0, steering: [], followUps: [] })
  })

  it('matches a preview to its prompt literally or by a compacted prefix', () => {
    expect(previewMatchesPrompt('change direction', 'change direction')).toBe(true)
    expect(previewMatchesPrompt('a very long steer', 'a very long steer that the scheduler compacted')).toBe(true)
    expect(previewMatchesPrompt('a long preview with more', 'a long preview')).toBe(true)
    expect(previewMatchesPrompt('change direction', 'keep going')).toBe(false)
  })

  it('compares snapshots by queue contents and active action', () => {
    const snapshot = { queuedCount: 1, steering: ['steer'], followUps: [], active: { kind: 'turn' as const, phase: 'running' as const } }
    expect(sameSessionActions(snapshot, { ...snapshot, steering: ['steer'] })).toBe(true)
    expect(sameSessionActions(undefined, snapshot)).toBe(false)
    expect(sameSessionActions(snapshot, { ...snapshot, steering: [] })).toBe(false)
    expect(sameSessionActions(snapshot, { ...snapshot, followUps: ['later'] })).toBe(false)
    expect(sameSessionActions(snapshot, { queuedCount: 1, steering: ['steer'], followUps: [] })).toBe(false)
    expect(sameSessionActions(snapshot, { ...snapshot, active: { kind: 'turn', phase: 'running', label: 'steer' } })).toBe(false)
  })
})

describe('delivered queued prompts', () => {
  const running = { kind: 'turn' as const, phase: 'running' as const }

  it('consumes a matching steer before a follow-up with the same text', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 2, steering: ['same text'], followUps: ['same text'], active: running }, 'same text'))
      .toEqual({ queuedCount: 1, steering: [], followUps: ['same text'], active: running })
  })

  it('falls back to the follow-up queue and removes only the first match', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 3, steering: ['other'], followUps: ['next', 'next'], active: running }, 'next'))
      .toEqual({ queuedCount: 2, steering: ['other'], followUps: ['next'], active: running })
  })

  it('matches a compacted preview of a long prompt', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: ['a long steer'], followUps: [] }, 'a long steer the scheduler compacted'))
      .toMatchObject({ queuedCount: 0, steering: [] })
  })

  it('returns null when no queued preview matches', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: ['queued steer'], followUps: [] }, 'harness notification')).toBeNull()
    expect(consumeDeliveredPrompt(emptySessionActionSnapshot(), 'first prompt')).toBeNull()
  })

  it('matches an image-only prompt only to an empty preview', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: ['queued steer'], followUps: [] }, '')).toBeNull()
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: [''], followUps: [] }, 'harness notification')).toBeNull()
    expect(consumeDeliveredPrompt({ queuedCount: 2, steering: ['queued steer', ''], followUps: [] }, ''))
      .toMatchObject({ queuedCount: 1, steering: ['queued steer'] })
  })

  it('never drops the queued count below zero', () => {
    expect(consumeDeliveredPrompt({ queuedCount: 0, steering: ['steer'], followUps: [] }, 'steer')?.queuedCount).toBe(0)
  })

  it('keeps the active action and marks a running turn when the snapshot had none', () => {
    const command = { kind: 'session_command' as const, phase: 'committing' as const, label: 'compact' }
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: ['steer'], followUps: [], active: command }, 'steer')?.active).toEqual(command)
    expect(consumeDeliveredPrompt({ queuedCount: 1, steering: ['steer'], followUps: [] }, 'steer')?.active).toEqual(running)
  })
})

describe('finished runs', () => {
  it('drops only the active action and leaves the queue alone', () => {
    const queued = { queuedCount: 1, steering: [], followUps: ['next'] }
    expect(withoutActiveAction({ ...queued, active: { kind: 'turn', phase: 'running' } as const })).toEqual(queued)
    expect(withoutActiveAction(queued)).toEqual(queued)
  })
})

describe('isRuntimeIdle', () => {
  const quiet = { isStreaming: false, isCompacting: false, sessionActions: emptySessionActionSnapshot() }

  it('treats a quiet runtime with or without queue state as idle', () => {
    expect(isRuntimeIdle(quiet)).toBe(true)
    expect(isRuntimeIdle({ isStreaming: false })).toBe(true)
  })

  it('is busy while streaming or compacting', () => {
    expect(isRuntimeIdle({ ...quiet, isStreaming: true })).toBe(false)
    expect(isRuntimeIdle({ ...quiet, isCompacting: true })).toBe(false)
  })

  it('is busy while steers or follow-ups are queued between turns', () => {
    expect(isRuntimeIdle({ ...quiet, sessionActions: { queuedCount: 1, steering: ['steer'], followUps: [] } })).toBe(false)
    expect(isRuntimeIdle({ ...quiet, sessionActions: { queuedCount: 1, steering: [], followUps: ['after this'] } })).toBe(false)
    // Harnesses may report a count without previews; the count alone still blocks.
    expect(isRuntimeIdle({ ...quiet, sessionActions: { queuedCount: 2, steering: [], followUps: [] } })).toBe(false)
  })

  it('is busy while a session action is active', () => {
    for (const phase of ['preparing', 'committing', 'running'] as const) {
      expect(isRuntimeIdle({ ...quiet, sessionActions: { queuedCount: 0, steering: [], followUps: [], active: { kind: 'turn', phase } } })).toBe(false)
    }
    expect(isRuntimeIdle({ ...quiet, sessionActions: { queuedCount: 0, steering: [], followUps: [], active: { kind: 'session_command', phase: 'running' } } })).toBe(false)
  })
})
