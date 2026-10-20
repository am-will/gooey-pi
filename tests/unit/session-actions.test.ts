import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_LENGTH,
  MAX_QUEUED_ACTIONS,
  emptySessionActionSnapshot,
  isRuntimeIdle,
  parseSessionActionSnapshot,
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
