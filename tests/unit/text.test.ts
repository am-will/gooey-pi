import { describe, expect, it } from 'vitest'
import { compactText } from '../../src/lib/text'

describe('compactText', () => {
  it('collapses whitespace runs and trims the ends', () => {
    expect(compactText('  Fix\n\tthe   flaky\r\n test  ')).toBe('Fix the flaky test')
    expect(compactText(' \n\t ')).toBe('')
  })

  it('keeps text at exactly the limit unchanged', () => {
    const exact = 'a'.repeat(100)
    expect(compactText(exact, 100)).toBe(exact)
  })

  it('clips text one past the limit to max characters ending in an ellipsis', () => {
    const clipped = compactText('a'.repeat(101), 100)
    expect(clipped).toBe(`${'a'.repeat(99)}…`)
    expect(clipped).toHaveLength(100)
  })

  it('measures the limit after collapsing whitespace', () => {
    expect(compactText(`${'a'.repeat(50)}\n\n\n${'b'.repeat(49)}`, 100)).toBe(`${'a'.repeat(50)} ${'b'.repeat(49)}`)
  })

  it('defaults to a 160-character limit', () => {
    expect(compactText('x'.repeat(160))).toHaveLength(160)
    expect(compactText('x'.repeat(161))).toBe(`${'x'.repeat(159)}…`)
  })
})
