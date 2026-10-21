import { afterEach, describe, expect, it, vi } from 'vitest'
import { basename, formatRelative } from '../../src/lib/data'

afterEach(() => { vi.useRealTimers() })

describe('formatRelative', () => {
  it('returns an empty label for missing or unparseable timestamps instead of throwing', () => {
    expect(formatRelative(undefined)).toBe('')
    expect(formatRelative('not a date')).toBe('')
    expect(formatRelative(Number.NaN)).toBe('')
    expect(formatRelative(Number.POSITIVE_INFINITY)).toBe('')
  })

  it('labels timestamps within a minute as now', () => {
    expect(formatRelative(Date.now())).toBe('now')
    expect(formatRelative(new Date().toISOString())).toBe('now')
  })

  it('formats timestamps a week or more away in weeks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-15T12:00:00.000Z'))
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    expect(formatRelative('2026-03-08T12:00:00.000Z')).toBe(formatter.format(-1, 'week'))
    expect(formatRelative(Date.parse('2026-03-29T12:00:00.000Z'))).toBe(formatter.format(2, 'week'))
  })
})

describe('basename', () => {
  it('returns the last segment of POSIX paths, ignoring trailing separators', () => {
    expect(basename('/a/b')).toBe('b')
    expect(basename('/a/b/')).toBe('b')
  })

  it('returns the last segment of Windows paths, ignoring trailing separators', () => {
    expect(basename('C:\\a\\b')).toBe('b')
    expect(basename('C:\\a\\b\\')).toBe('b')
    expect(basename('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe')
    expect(basename('\\\\server\\share\\repo')).toBe('repo')
  })

  it('keeps bare names and the root unchanged', () => {
    expect(basename('repo')).toBe('repo')
    expect(basename('/')).toBe('/')
  })
})
