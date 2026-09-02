import { describe, expect, it } from 'vitest'
import { redactedStderrTail } from '../../electron/main/lib/process-detail'

describe('process detail', () => {
  it('strips ANSI escapes, selects the last line, redacts token-like runs, and caps output', () => {
    const detail = redactedStderrTail(
      '\u001b[31mfirst ghp_' + 'a'.repeat(40) + '\u001b[0m\n'
      + 'middle ' + 'x'.repeat(32) + '\n'
      + '\u001b[1mfinal line ' + 'B'.repeat(300) + '\u001b[0m\n',
    )
    expect(detail).toBe('final line [redacted]')
    expect(detail).not.toContain('\u001b')
    expect(detail.length).toBeLessThanOrEqual(200)
  })

  it('returns an empty string when stderr has no non-empty line', () => {
    expect(redactedStderrTail('\u001b[0m\n \n')).toBe('')
  })
})
