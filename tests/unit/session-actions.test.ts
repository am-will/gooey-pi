import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_LENGTH,
  MAX_QUEUED_ACTIONS,
  consumeDeliveredPrompt,
  emptySessionActionSnapshot,
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
    expect(parseSessionActionSnapshot({
      queuedCount: 1,
      steering: ['x'.repeat(MAX_PREVIEW_LENGTH + 1)],
      followUps: [],
    })).toBeNull()
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
