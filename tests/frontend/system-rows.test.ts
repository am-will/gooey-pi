import { describe, expect, it } from 'vitest'
import { isSystemReport } from '../../src/lib/system-rows'
import type { TranscriptMessage } from '../../src/types/api'

const row = (role: TranscriptMessage['role'], kind?: TranscriptMessage['kind']): TranscriptMessage => ({
  id: 'row', role, kind, parts: [{ type: 'text', text: 'row' }],
})

describe('system row classification', () => {
  it('reads a system row without a kind as a report and the neutral kinds as not', () => {
    expect(isSystemReport(row('system'))).toBe(true)
    expect(isSystemReport(row('system', 'notice'))).toBe(false)
    expect(isSystemReport(row('system', 'steer-read-marker'))).toBe(false)
    expect(isSystemReport(row('assistant'))).toBe(false)
    expect(isSystemReport(undefined)).toBe(false)
  })

  it('reads a kind it does not know as neutral as a report', () => {
    expect(isSystemReport(row('system', 'unclassified' as TranscriptMessage['kind']))).toBe(true)
  })
})
