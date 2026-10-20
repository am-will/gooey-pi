import { describe, expect, it } from 'vitest'
import { THINKING_LEVEL_LABELS } from '../../src/lib/thinking-levels'
import { PRIME_THINKING_LEVELS } from '../../src/types/api'

describe('THINKING_LEVEL_LABELS', () => {
  it('labels exactly the known thinking levels with distinct, non-empty names', () => {
    expect(Object.keys(THINKING_LEVEL_LABELS).sort()).toEqual([...PRIME_THINKING_LEVELS].sort())
    const labels = PRIME_THINKING_LEVELS.map((level) => THINKING_LEVEL_LABELS[level])
    for (const label of labels) expect(label.trim()).not.toBe('')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('uses the composer wording for medium and xhigh', () => {
    expect(THINKING_LEVEL_LABELS.medium).toBe('Standard')
    expect(THINKING_LEVEL_LABELS.xhigh).toBe('Extra high')
  })
})
