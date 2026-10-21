import { describe, expect, it } from 'vitest'
import {
  MAX_MISSED_OCCURRENCES,
  MAX_PREVIEW_OCCURRENCES,
  MAX_RRULE_LENGTH,
  countMissedOccurrences,
  nextScheduleOccurrence,
  previewScheduleOccurrences,
  validateScheduleTiming,
  type ScheduleTiming,
} from '../../electron/main/schedules/recurrence'

const dailyNewYork: ScheduleTiming = {
  kind: 'rrule',
  dtstartLocal: '2024-03-09T09:00:00',
  timeZone: 'America/New_York',
  rrule: 'FREQ=DAILY',
}

describe('schedule recurrence validation', () => {
  it('canonicalizes future one-time timestamps to UTC', () => {
    expect(validateScheduleTiming(
      { kind: 'once', at: '2030-06-01T12:30:00+02:00' },
      { now: '2030-06-01T10:29:59.999Z' },
    )).toEqual({ kind: 'once', at: '2030-06-01T10:30:00.000Z' })
  })

  it('requires one-time timestamps to be valid, explicit, and future', () => {
    const now = { now: '2030-01-01T00:00:00.000Z' }
    expect(() => validateScheduleTiming({ kind: 'once', at: '2030-01-01T00:00:00Z' }, now)).toThrow(/future/i)
    expect(() => validateScheduleTiming({ kind: 'once', at: '2030-01-01T00:00:00' }, now)).toThrow(/explicit offset/i)
    expect(() => validateScheduleTiming({ kind: 'once', at: '2030-02-30T00:00:00Z' }, now)).toThrow(/calendar/i)
    expect(() => validateScheduleTiming({ kind: 'once', at: '2030-01-01T00:00:00+15:00' }, { now: '2029-01-01T00:00:00Z' })).toThrow(/offset/i)
  })

  it('canonicalizes recurring input without depending on the host time zone', () => {
    expect(validateScheduleTiming({
      kind: 'rrule',
      dtstartLocal: '2028-02-29T09:05',
      timeZone: 'America/New_York',
      rrule: 'rrule:freq=weekly;byday=mo,we;interval=2',
    })).toEqual({
      kind: 'rrule',
      dtstartLocal: '2028-02-29T09:05:00',
      timeZone: 'America/New_York',
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
    })
  })

  it('rejects invalid local dates, zones, shapes, and unknown keys', () => {
    expect(() => validateScheduleTiming({ ...dailyNewYork, dtstartLocal: '2024-02-30T09:00' })).toThrow(/calendar/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, dtstartLocal: '2024-01-01T09:00Z' })).toThrow(/without an offset/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, timeZone: 'Mars/Olympus_Mons' })).toThrow(/IANA/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, surprise: true })).toThrow(/surprise/)
    expect(() => validateScheduleTiming(null)).toThrow(/object/i)
    expect(() => validateScheduleTiming({ kind: 'cron' })).toThrow(/kind/i)
  })

  it('bounds and restricts hostile RRULE input', () => {
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: `FREQ=DAILY;${'X'.repeat(MAX_RRULE_LENGTH)}` })).toThrow(/too long/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY\nDTSTART:20240101T000000Z' })).toThrow(/exactly one/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY;FREQ=WEEKLY' })).toThrow(/duplicate/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY;X-EXEC=YES' })).toThrow(/unsupported/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=SECONDLY' })).toThrow(/minutely/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=MINUTELY;BYSECOND=0,30' })).toThrow(/within one minute/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY;COUNT=100001' })).toThrow(/COUNT/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY;INTERVAL=1000001' })).toThrow(/INTERVAL/i)
    expect(() => validateScheduleTiming({ ...dailyNewYork, rrule: 'FREQ=DAILY;COUNT=2;UNTIL=20300101T000000Z' })).toThrow(/combine/i)
  })
})

describe('schedule occurrence expansion', () => {
  it('returns null for an exhausted one-time timing and is strict after the cursor', () => {
    const timing: ScheduleTiming = { kind: 'once', at: '2030-01-01T00:00:00.000Z' }
    expect(nextScheduleOccurrence(timing, '2029-12-31T23:59:59.999Z')).toBe('2030-01-01T00:00:00.000Z')
    expect(nextScheduleOccurrence(timing, timing.at)).toBeNull()
    expect(previewScheduleOccurrences(timing, 5, timing.at)).toEqual([])
  })

  it('keeps a New York wall-clock hour across the spring DST transition', () => {
    expect(previewScheduleOccurrences(dailyNewYork, 4, '2024-03-08T00:00:00Z')).toEqual([
      '2024-03-09T14:00:00.000Z',
      '2024-03-10T13:00:00.000Z',
      '2024-03-11T13:00:00.000Z',
      '2024-03-12T13:00:00.000Z',
    ])
  })

  it('keeps a New York wall-clock hour across the fall DST transition', () => {
    const timing: ScheduleTiming = { ...dailyNewYork, dtstartLocal: '2024-11-02T09:00:00' }
    expect(previewScheduleOccurrences(timing, 3, '2024-11-01T00:00:00Z')).toEqual([
      '2024-11-02T13:00:00.000Z',
      '2024-11-03T14:00:00.000Z',
      '2024-11-04T14:00:00.000Z',
    ])
  })

  it('deterministically shifts a nonexistent local time forward by the DST gap', () => {
    const timing: ScheduleTiming = {
      kind: 'rrule',
      dtstartLocal: '2024-03-10T02:30:00',
      timeZone: 'America/New_York',
      rrule: 'FREQ=DAILY;COUNT=2',
    }
    expect(previewScheduleOccurrences(timing, 3, '2024-03-09T00:00:00Z')).toEqual([
      '2024-03-10T07:30:00.000Z',
      '2024-03-11T06:30:00.000Z',
    ])
  })

  it('applies an RRULE UNTIL value as an absolute UTC instant', () => {
    const excluded: ScheduleTiming = { ...dailyNewYork, rrule: 'FREQ=DAILY;UNTIL=20240310T125959Z' }
    const included: ScheduleTiming = { ...dailyNewYork, rrule: 'FREQ=DAILY;UNTIL=20240310T130000Z' }
    expect(previewScheduleOccurrences(excluded, 5, '2024-03-08T00:00:00Z')).toEqual([
      '2024-03-09T14:00:00.000Z',
    ])
    expect(previewScheduleOccurrences(included, 5, '2024-03-08T00:00:00Z')).toEqual([
      '2024-03-09T14:00:00.000Z',
      '2024-03-10T13:00:00.000Z',
    ])
  })

  it('rejects ambiguous cursor strings without an explicit offset', () => {
    expect(() => nextScheduleOccurrence(dailyNewYork, '2024-03-08T00:00:00')).toThrow(/explicit offset/i)
  })

  it('honors COUNT and produces deterministic UTC ISO strings', () => {
    const timing: ScheduleTiming = {
      kind: 'rrule',
      dtstartLocal: '2025-01-01T00:00:00',
      timeZone: 'Asia/Kathmandu',
      rrule: 'FREQ=DAILY;COUNT=2',
    }
    expect(nextScheduleOccurrence(timing, '2024-01-01T00:00:00Z')).toBe('2024-12-31T18:15:00.000Z')
    expect(previewScheduleOccurrences(timing, 5, '2024-01-01T00:00:00Z')).toEqual([
      '2024-12-31T18:15:00.000Z',
      '2025-01-01T18:15:00.000Z',
    ])
  })

  it('walks more than a thousand historical monthly and yearly occurrences', () => {
    const old: ScheduleTiming = { kind: 'rrule', dtstartLocal: '1970-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=YEARLY' }
    expect(nextScheduleOccurrence(old, '4000-06-01T00:00:00Z')).toBe('4001-01-01T09:00:00.000Z')
    expect(nextScheduleOccurrence({ ...old, rrule: 'FREQ=MONTHLY' }, '2100-06-01T00:00:00Z')).toBe('2100-06-01T09:00:00.000Z')
  })

  it('bounds preview sizes before expansion', () => {
    expect(() => previewScheduleOccurrences(dailyNewYork, MAX_PREVIEW_OCCURRENCES + 1, '2024-01-01T00:00:00Z')).toThrow(/count/i)
    expect(() => previewScheduleOccurrences(dailyNewYork, -1, '2024-01-01T00:00:00Z')).toThrow(/count/i)
  })
})

describe('missed schedule occurrence counting', () => {
  const hourly: ScheduleTiming = {
    kind: 'rrule',
    dtstartLocal: '2025-01-01T00:00:00',
    timeZone: 'UTC',
    rrule: 'FREQ=HOURLY',
  }

  it('counts a from-inclusive, until-exclusive interval', () => {
    expect(countMissedOccurrences(hourly, '2025-01-01T00:00:00Z', '2025-01-01T03:00:00Z')).toBe(3)
    expect(countMissedOccurrences(hourly, '2025-01-01T00:00:00.001Z', '2025-01-01T03:00:00Z')).toBe(2)
    expect(countMissedOccurrences(hourly, '2025-01-01T03:00:00Z', '2025-01-01T03:00:00Z')).toBe(0)
    expect(countMissedOccurrences(hourly, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(8_760)
  })

  it('counts one-time timings using the same boundary semantics', () => {
    const once: ScheduleTiming = { kind: 'once', at: '2025-01-01T01:00:00.000Z' }
    expect(countMissedOccurrences(once, once.at, '2025-01-01T02:00:00Z')).toBe(1)
    expect(countMissedOccurrences(once, '2025-01-01T00:00:00Z', once.at)).toBe(0)
  })

  it('fast-forwards old unbounded fixed-duration rules without an unbounded scan', () => {
    const oldMinutely: ScheduleTiming = {
      kind: 'rrule',
      dtstartLocal: '1970-01-01T00:00:00',
      timeZone: 'UTC',
      rrule: 'FREQ=MINUTELY',
    }
    expect(nextScheduleOccurrence(oldMinutely, '2030-01-01T00:00:00Z')).toBe('2030-01-01T00:01:00.000Z')
    expect(nextScheduleOccurrence({ ...oldMinutely, rrule: 'FREQ=DAILY' }, '2030-01-01T00:00:00Z')).toBe('2030-01-02T00:00:00.000Z')
  })

  it('allows bounded lower-bound reporting for a long minutely missed gap', () => {
    const minutely: ScheduleTiming = { ...hourly, rrule: 'FREQ=MINUTELY' }
    expect(countMissedOccurrences(minutely, '2025-01-01T00:00:00Z', '2025-01-09T00:00:00Z', 10_000, { saturate: true })).toBe(10_000)
  })

  it('fails closed when a caller-provided or global hard limit is exceeded', () => {
    const minutely: ScheduleTiming = { ...hourly, rrule: 'FREQ=MINUTELY' }
    expect(() => countMissedOccurrences(minutely, '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', 10)).toThrow(/iteration limit/i)
    expect(() => countMissedOccurrences(minutely, '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', MAX_MISSED_OCCURRENCES + 1)).toThrow(/limit/i)
  })
})
