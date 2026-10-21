import { describe, expect, it } from 'vitest'
import { defaultForm, executionFromForm, formFromSchedule, targetFromForm, timingFromForm, validTimeZone } from '../../src/lib/schedule-form'
import type { AutomationScheduleRecord } from '../../src/types/api'

const record: AutomationScheduleRecord = {
  schemaVersion: 1, id: 'task', harness: 'omp', revision: 3, title: 'Task', prompt: 'Do work',
  target: { kind: 'session', projectId: 'project', sessionId: 'session' },
  timing: { kind: 'rrule', rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR', dtstartLocal: '2027-01-01T09:00:00', timeZone: 'UTC' },
  execution: { model: 'provider/model', thinking: 'high', speed: 'fast' }, status: 'active', createdBy: 'user',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', runs: [],
}

describe('schedule form mapping', () => {
  it('round-trips a supported recurring schedule target and execution', () => {
    const form = formFromSchedule(record, [], '')
    expect(form).toMatchObject({ title: 'Task', prompt: 'Do work', frequency: 'weekly', interval: '2', weekdays: ['MO', 'FR'], date: '2027-01-01', time: '09:00' })
    expect(timingFromForm(form)).toEqual(record.timing)
    expect(targetFromForm(form)).toEqual(record.target)
    expect(executionFromForm(form)).toEqual(record.execution)
  })
  it('creates a safe empty form without unauthorized targets or models', () => {
    const form = defaultForm([], [], [], '')
    expect(form.projectId).toBe('')
    expect(form.model).toBe('')
    expect(targetFromForm(form)).toEqual({ kind: 'project', projectId: '' })
    expect(executionFromForm(form)).toEqual({ model: '', thinking: 'auto', speed: 'normal' })
  })
  it('rejects missing fields and invalid time zones', () => {
    const form = defaultForm([], [], [], '')
    expect(timingFromForm({ ...form, date: '' })).toBeNull()
    expect(timingFromForm({ ...form, timeZone: 'not/a/timezone' })).toBeNull()
    expect(validTimeZone('UTC')).toBe(true)
    expect(validTimeZone('not/a/timezone')).toBe(false)
  })
})


it.each([
  'FREQ=DAILY;COUNT=4', 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20280101T000000Z',
  'FREQ=MONTHLY;BYMONTHDAY=15', 'FREQ=DAILY;BYHOUR=9,17', 'FREQ=MONTHLY;BYDAY=2MO',
  'FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=MO;BYDAY=FR', 'FREQ=DAILY;INTERVAL=0',
  'FREQ=DAILY;BYDAY=MO', 'FREQ=YEARLY',
])('retains advanced recurrence %s when editing unrelated fields', (rrule) => {
  const timing = { kind: 'rrule', rrule, dtstartLocal: '2027-01-01T09:00:00', timeZone: 'UTC' } as const
  const form = formFromSchedule({ ...record, timing }, [], '')
  expect(form.frequency).toBe('advanced')
  expect(form.advancedRrule).toBe(rrule)
  expect(timingFromForm({ ...form, title: 'Renamed' })).toEqual(timing)
})
