import { describe, expect, it } from 'vitest'
import { THINKING_LEVEL_KEYS } from '../../src/lib/thinking-levels'
import { englishCatalog } from '../../src/lib/locales/english'
import { PRIME_THINKING_LEVELS } from '../../src/types/api'

describe('THINKING_LEVEL_KEYS', () => {
  it('labels exactly the known thinking levels with distinct, non-empty names', () => {
    expect(Object.keys(THINKING_LEVEL_KEYS).sort()).toEqual([...PRIME_THINKING_LEVELS].sort())
    const labels = PRIME_THINKING_LEVELS.map((level) => englishCatalog[THINKING_LEVEL_KEYS[level]])
    for (const label of labels) expect(label.trim()).not.toBe('')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('uses the composer wording for medium and xhigh', () => {
    expect(englishCatalog[THINKING_LEVEL_KEYS.medium]).toBe('Standard')
    expect(englishCatalog[THINKING_LEVEL_KEYS.xhigh]).toBe('Extra high')
  })
})
