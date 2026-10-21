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
