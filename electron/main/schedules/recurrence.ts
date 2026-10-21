import rrule from 'rrule'
import type { RRule as RRuleType } from 'rrule'
import type { ScheduleTiming } from '../../../src/types/api'
import { rejectUnknownKeys, requireRecord, requireString as requireValidatedString } from '../validation'

const { RRule } = rrule as typeof import('rrule')

export type { ScheduleTiming }

export const MAX_RRULE_LENGTH = 1024
export const MAX_PREVIEW_OCCURRENCES = 1_000
export const MAX_MISSED_OCCURRENCES = 100_000

const MAX_SKIPPED_CANDIDATES = 100_000
const MAX_RRULE_COUNT = 100_000
const MAX_RRULE_INTERVAL = 1_000_000
const MAX_RRULE_LIST_VALUES = 366
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i
const ALLOWED_RRULE_PARTS = new Set([
  'FREQ', 'UNTIL', 'COUNT', 'INTERVAL', 'BYSECOND', 'BYMINUTE', 'BYHOUR',
  'BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH', 'BYSETPOS', 'WKST',
])

interface LocalDateTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function requireString(value: unknown, label: string, max: number): string {
  return requireValidatedString(value, label, { min: 1, max })
}

function validCalendarDate(value: LocalDateTime): boolean {
  if (value.year < 1970 || value.year > 9999) return false
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second))
  return date.getUTCFullYear() === value.year && date.getUTCMonth() === value.month - 1 &&
    date.getUTCDate() === value.day && date.getUTCHours() === value.hour &&
    date.getUTCMinutes() === value.minute && date.getUTCSeconds() === value.second
}

function parseLocalDateTime(input: string): LocalDateTime {
  const match = LOCAL_DATE_PATTERN.exec(input)
  if (!match) throw new TypeError('timing.dtstartLocal must be a local ISO date and time without an offset')
  const value: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  }
  if (!validCalendarDate(value)) throw new TypeError('timing.dtstartLocal is not a valid calendar date and time')
  return value
}

function localIso(value: LocalDateTime): string {
  const pad = (number: number): string => String(number).padStart(2, '0')
  return `${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.day)}T${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`
}

function parseInstant(value: Date | string, label: string): Date {
  if (typeof value === 'string') return new Date(canonicalInstant(value, label))
  const date = new Date(value.getTime())
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid instant`)
  return date
}

function canonicalInstant(input: unknown, label = 'timing.at'): string {
  const value = requireString(input, label, 64)
  const match = INSTANT_PATTERN.exec(value)
  if (!match) throw new TypeError(`${label} must be an ISO timestamp with an explicit offset`)
  const local: LocalDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  }
  if (!validCalendarDate(local)) throw new TypeError(`${label} is not a valid calendar date and time`)
  if (match[7].toUpperCase() !== 'Z') {
    const [offsetHour, offsetMinute] = match[7].slice(1).split(':').map(Number)
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      throw new TypeError(`${label} has an invalid UTC offset`)
    }
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid instant`)
  return date.toISOString()
}

function canonicalTimeZone(input: unknown): string {
  const value = requireString(input, 'timing.timeZone', 128)
  if (value.trim() !== value) throw new TypeError('timing.timeZone must not contain surrounding whitespace')
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    throw new TypeError('timing.timeZone must be a valid IANA time zone')
  }
  return formatter.resolvedOptions().timeZone
}

function canonicalRrule(input: unknown): string {
  let value = requireString(input, 'timing.rrule', MAX_RRULE_LENGTH)
  if (/\r|\n|\0/.test(value)) throw new TypeError('timing.rrule must contain exactly one RRULE')
  value = value.toUpperCase()
  if (value.startsWith('RRULE:')) value = value.slice(6)
  if (!value.startsWith('FREQ=')) throw new TypeError('timing.rrule must start with FREQ')

  const seen = new Set<string>()
  const parts = value.split(';')
  for (const part of parts) {
    const equals = part.indexOf('=')
    if (equals <= 0 || equals === part.length - 1) throw new TypeError('timing.rrule contains an invalid part')
    const key = part.slice(0, equals)
    const raw = part.slice(equals + 1)
    if (!ALLOWED_RRULE_PARTS.has(key)) throw new TypeError(`timing.rrule contains unsupported ${key}`)
    if (seen.has(key)) throw new TypeError(`timing.rrule contains duplicate ${key}`)
    seen.add(key)
    if (raw.split(',').length > MAX_RRULE_LIST_VALUES) throw new TypeError(`timing.rrule ${key} has too many values`)
  }
  if (!seen.has('FREQ')) throw new TypeError('timing.rrule requires FREQ')
  if (seen.has('COUNT') && seen.has('UNTIL')) throw new TypeError('timing.rrule cannot combine COUNT and UNTIL')

  let options: ReturnType<typeof RRule.parseString>
  try {
    options = RRule.parseString(value)
    // Constructing catches combinations and ranges parseString alone accepts.
    new RRule(options)
  } catch {
    throw new TypeError('timing.rrule is invalid')
  }
  if (options.freq === RRule.SECONDLY) throw new TypeError('timing.rrule cannot recur more frequently than minutely')
  if (options.interval !== undefined && (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > MAX_RRULE_INTERVAL)) {
    throw new TypeError(`timing.rrule INTERVAL must be from 1 to ${MAX_RRULE_INTERVAL}`)
  }
  if (options.count !== undefined && options.count !== null &&
      (!Number.isInteger(options.count) || options.count < 1 || options.count > MAX_RRULE_COUNT)) {
    throw new TypeError(`timing.rrule COUNT must be from 1 to ${MAX_RRULE_COUNT}`)
  }
  const seconds = options.bysecond === undefined || options.bysecond === null
    ? []
    : Array.isArray(options.bysecond) ? options.bysecond : [options.bysecond]
  if (new Set(seconds).size > 1) throw new TypeError('timing.rrule cannot produce multiple occurrences within one minute')

  const canonicalParts = RRule.optionsToString(options).replace(/^RRULE:/, '').split(';').map((part) => {
    const [key, raw] = part.split('=', 2)
    if (!key.startsWith('BY') || !raw.includes(',')) return part
    const values = [...new Set(raw.split(','))]
    values.sort((left, right) => {
      const leftNumber = Number(left)
      const rightNumber = Number(right)
      return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
        ? leftNumber - rightNumber
        : left.localeCompare(right, 'en')
    })
    return `${key}=${values.join(',')}`
  })
  const order = [
    'FREQ', 'INTERVAL', 'WKST', 'COUNT', 'UNTIL', 'BYSETPOS', 'BYMONTH',
    'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYDAY', 'BYHOUR', 'BYMINUTE', 'BYSECOND',
  ]
  canonicalParts.sort((left, right) => order.indexOf(left.split('=', 1)[0]) - order.indexOf(right.split('=', 1)[0]))
  return canonicalParts.join(';')
}

function normalizeTiming(input: unknown, enforceFuture: boolean, now: Date): ScheduleTiming {
  const value = requireRecord(input, 'timing')
  if (value.kind === 'once') {
    rejectUnknownKeys(value, ['kind', 'at'], 'timing')
    const at = canonicalInstant(value.at)
    if (enforceFuture && Date.parse(at) <= now.getTime()) throw new TypeError('timing.at must be in the future')
    return { kind: 'once', at }
  }
  if (value.kind === 'rrule') {
    rejectUnknownKeys(value, ['kind', 'dtstartLocal', 'timeZone', 'rrule'], 'timing')
    const local = parseLocalDateTime(requireString(value.dtstartLocal, 'timing.dtstartLocal', 32))
    return {
      kind: 'rrule',
      dtstartLocal: localIso(local),
      timeZone: canonicalTimeZone(value.timeZone),
      rrule: canonicalRrule(value.rrule),
    }
  }
  throw new TypeError("timing.kind must be 'once' or 'rrule'")
}

export interface ScheduleTimingValidationOptions {
  now?: Date | string
}

/** Validates untrusted timing data and returns its canonical, persistable form. */
export function validateScheduleTiming(
  input: unknown,
  options: ScheduleTimingValidationOptions | Date | string = {},
): ScheduleTiming {
  const now = options instanceof Date || typeof options === 'string' ? options : options.now ?? new Date()
  return normalizeTiming(input, true, parseInstant(now, 'now'))
}

export const canonicalizeScheduleTiming = validateScheduleTiming

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const existing = formatters.get(timeZone)
  if (existing) return existing
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  formatters.set(timeZone, formatter)
  return formatter
}

function localAt(instant: Date, timeZone: string): LocalDateTime {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const number = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value)
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
    second: number('second'),
  }
}

function wallClockEpoch(value: LocalDateTime): number {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
}

function instantForLocal(value: LocalDateTime, timeZone: string): Date {
  const desired = wallClockEpoch(value)
  let candidate = desired
  const candidates = new Set<number>()
  for (let iteration = 0; iteration < 8; iteration += 1) {
    candidates.add(candidate)
    const observed = wallClockEpoch(localAt(new Date(candidate), timeZone))
    const difference = desired - observed
    if (difference === 0) return new Date(candidate)
    candidate += difference
  }

  // A local time in a spring-forward gap has no exact instant. Shift it forward
  // by the gap, which is deterministic and matches common calendar behavior.
  const later = [...candidates]
    .map((milliseconds) => ({ milliseconds, wall: wallClockEpoch(localAt(new Date(milliseconds), timeZone)) }))
    .filter(({ wall }) => wall > desired)
    .sort((left, right) => (left.wall - desired) - (right.wall - desired))[0]
  if (later) return new Date(later.milliseconds)
  throw new RangeError('timing.dtstartLocal cannot be represented in timing.timeZone')
}

function fakeUtc(value: LocalDateTime): Date {
  return new Date(wallClockEpoch(value))
}

function recurrenceFor(
  timing: Extract<ScheduleTiming, { kind: 'rrule' }>,
  reference: Date,
): { recurrence: RRuleType; until: Date | null; candidateLimit: number } {
  const options = RRule.parseString(timing.rrule)
  const until = options.until ?? null
  const count = options.count ?? null
  const originalStart = fakeUtc(parseLocalDateTime(timing.dtstartLocal))
  options.dtstart = originalStart
  // Unbounded fixed-duration rules otherwise make rrule scan every period
  // since DTSTART for every query. Rebase by whole intervals near the cursor;
  // this preserves the recurrence phase and DTSTART-derived minute/second values.
  const fixedFrequencyUnits = new Map([
    [RRule.MINUTELY, 60_000],
    [RRule.HOURLY, 3_600_000],
    [RRule.DAILY, 86_400_000],
    [RRule.WEEKLY, 604_800_000],
  ])
  const fixedFrequencyUnit = options.freq === undefined ? undefined : fixedFrequencyUnits.get(options.freq)
  if (count === null && fixedFrequencyUnit !== undefined) {
    const step = fixedFrequencyUnit * (options.interval ?? 1)
    const referenceWall = fakeUtc(localAt(reference, timing.timeZone)).getTime()
    const elapsed = referenceWall - originalStart.getTime()
    if (elapsed > step * 3) {
      const steps = Math.max(0, Math.floor(elapsed / step) - 2)
      options.dtstart = new Date(originalStart.getTime() + steps * step)
    }
  }
  // UNTIL is an absolute UTC instant for a zoned DTSTART. Enforce it after wall
  // time conversion rather than letting rrule compare it with the fake UTC date.
  options.until = null
  // Recurrence expansion happens on a UTC-backed wall-clock calendar. Conversion
  // to a real instant is deliberately separate so results do not depend on the
  // machine's own time zone (rrule's TZID Date behavior otherwise can).
  options.tzid = null
  return {
    recurrence: new RRule(options, true),
    until,
    candidateLimit: count ?? MAX_SKIPPED_CANDIDATES,
  }
}

function expandRruleInstants(
  timing: Extract<ScheduleTiming, { kind: 'rrule' }>,
  after: Date,
  count: number,
  untilExclusive?: Date,
): Date[] {
  const { recurrence, until, candidateLimit } = recurrenceFor(timing, after)
  const result: Date[] = []
  let candidates = 0
  // Every IANA offset is within a day of UTC; two days safely retain boundary candidates across offset changes.
  const earliestWall = fakeUtc(localAt(after, timing.timeZone)).getTime() - 2 * 86_400_000
  recurrence.all((candidate) => {
    candidates += 1
    if (candidates > Math.max(candidateLimit, count + MAX_PREVIEW_OCCURRENCES)) {
      throw new RangeError('recurrence search exceeded its iteration limit')
    }
    if (candidate.getTime() < earliestWall) return true
    const instant = instantForLocal({
      year: candidate.getUTCFullYear(),
      month: candidate.getUTCMonth() + 1,
      day: candidate.getUTCDate(),
      hour: candidate.getUTCHours(),
      minute: candidate.getUTCMinutes(),
      second: candidate.getUTCSeconds(),
    }, timing.timeZone)
    if (until && instant.getTime() > until.getTime()) return false
    if (instant.getTime() <= after.getTime()) return true
    if (untilExclusive && instant.getTime() >= untilExclusive.getTime()) return false
    result.push(instant)
    return result.length < count
  })
  return result
}

/** Returns the first occurrence strictly after `after`, or null once exhausted. */
export function nextScheduleOccurrence(timing: ScheduleTiming, after: Date | string): string | null {
  const normalized = normalizeTiming(timing, false, new Date(0))
  const afterDate = parseInstant(after, 'after')
  if (normalized.kind === 'once') return Date.parse(normalized.at) > afterDate.getTime() ? normalized.at : null
  return expandRruleInstants(normalized, afterDate, 1)[0]?.toISOString() ?? null
}

export const nextOccurrence = nextScheduleOccurrence

/** Returns up to `count` occurrences strictly after `after`. */
export function previewScheduleOccurrences(
  timing: ScheduleTiming,
  count: number,
  after: Date | string = new Date(),
): string[] {
  if (!Number.isInteger(count) || count < 0 || count > MAX_PREVIEW_OCCURRENCES) {
    throw new TypeError(`count must be an integer from 0 to ${MAX_PREVIEW_OCCURRENCES}`)
  }
  if (count === 0) return []
  const normalized = normalizeTiming(timing, false, new Date(0))
  const cursor = parseInstant(after, 'after')
  if (normalized.kind === 'once') return Date.parse(normalized.at) > cursor.getTime() ? [normalized.at] : []
  return expandRruleInstants(normalized, cursor, count).map((instant) => instant.toISOString())
}

export const previewOccurrences = previewScheduleOccurrences

/** Counts occurrences in the half-open interval [`fromInclusive`, `untilExclusive`). */
export function countMissedOccurrences(
  timing: ScheduleTiming,
  fromInclusive: Date | string,
  untilExclusive: Date | string,
  limit = MAX_MISSED_OCCURRENCES,
): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MISSED_OCCURRENCES) {
    throw new TypeError(`limit must be an integer from 1 to ${MAX_MISSED_OCCURRENCES}`)
  }
  const normalized = normalizeTiming(timing, false, new Date(0))
  const start = parseInstant(fromInclusive, 'fromInclusive')
  const end = parseInstant(untilExclusive, 'untilExclusive')
  if (end.getTime() <= start.getTime()) return 0
  if (normalized.kind === 'once') {
    const occurrence = Date.parse(normalized.at)
    return occurrence >= start.getTime() && occurrence < end.getTime() ? 1 : 0
  }

  const occurrences = expandRruleInstants(normalized, new Date(start.getTime() - 1), limit + 1, end)
  if (occurrences.length > limit) throw new RangeError('missed occurrence count exceeded its iteration limit')
  return occurrences.length
}

export const countMissedScheduleOccurrences = countMissedOccurrences
