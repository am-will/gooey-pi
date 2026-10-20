import { describe, expect, it } from 'vitest'
import {
  MAX_PREVIEW_LENGTH,
  MAX_QUEUED_ACTIONS,
  emptySessionActionSnapshot,
  parseSessionActionSnapshot,
  previewMatchesPrompt,
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
})
