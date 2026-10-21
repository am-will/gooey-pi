import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BoundedRecurrenceEvaluator } from '../../electron/main/schedules/recurrence-evaluator'
import type { ScheduleTiming } from '../../src/types/api'
import { recurrenceWorkerFixture } from '../helpers/recurrence-worker'

let fixture: Awaited<ReturnType<typeof recurrenceWorkerFixture>>
const evaluators: BoundedRecurrenceEvaluator[] = []
beforeAll(async () => { fixture = await recurrenceWorkerFixture() })
afterEach(async () => { await Promise.all(evaluators.splice(0).map((evaluator) => evaluator.close())) })
afterAll(async () => { await fixture.dispose() })
function evaluator(options: { computeTimeoutMs?: number; maxPending?: number } = {}): BoundedRecurrenceEvaluator {
  const value = new BoundedRecurrenceEvaluator({ workerUrl: fixture.url, ...options })
  evaluators.push(value)
  return value
}
const daily: ScheduleTiming = { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=DAILY' }
const impossible: ScheduleTiming = { ...daily, rrule: 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30' }

describe('isolated recurrence evaluation', () => {
  it('runs real previews', async () => {
    expect(await evaluator().preview(daily, 2, new Date('2030-01-01T00:00:00Z'))).toEqual(['2030-01-01T09:00:00.000Z', '2030-01-02T09:00:00.000Z'])
  })

  it('walks historical yearly rules', async () => {
    expect(await evaluator().next({ ...daily, dtstartLocal: '1970-01-01T09:00:00', rrule: 'FREQ=YEARLY' }, new Date('4000-06-01T00:00:00Z'))).toBe('4001-01-01T09:00:00.000Z')
  })

  it('saturates missed counts', async () => {
    expect(await evaluator().countMissed({ ...daily, dtstartLocal: '2030-01-01T00:00:00', rrule: 'FREQ=MINUTELY' }, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-09T00:00:00Z'), 10_000)).toBe(10_000)
  })

  it('exhausts a bounded minutely rule before the cursor', async () => {
    // Prove the 100,000-candidate result independently of machine speed; the default deadline is tested separately.
    expect(await evaluator({ computeTimeoutMs: 5_000 }).next({ ...daily, dtstartLocal: '1970-01-01T00:00:00', rrule: 'FREQ=MINUTELY;COUNT=100000' }, new Date('2030-01-01T00:00:00Z'))).toBeNull()
  })

  it('enforces the default 500ms compute budget in the real worker', async () => {
    const service = evaluator()
    await service.next(daily, new Date('2030-01-01T00:00:00Z'))
    await expect(service.preview(impossible, 1, new Date('2030-01-01T00:00:00Z'))).rejects.toThrow('500ms time budget')
  })

  it('keeps the event loop responsive during a rule that never produces a candidate', async () => {
    const service = evaluator({ computeTimeoutMs: 100 })
    // Warm startup separately so the assertion proves a running RRULE, not module loading.
    await service.next(daily, new Date('2030-01-01T00:00:00Z'))
    let ticks = 0
    const heartbeat = setInterval(() => { ticks += 1 }, 5)
    try {
      await expect(service.preview(impossible, 1, new Date('2030-01-01T00:00:00Z'))).rejects.toThrow('time budget')
      expect(ticks).toBeGreaterThan(1)
      expect(await service.next(daily, new Date('2030-01-01T00:00:00Z'))).toBe('2030-01-01T09:00:00.000Z')
    } finally { clearInterval(heartbeat) }
  })

  it('bounds pending work and rejects active and queued work on shutdown', async () => {
    const service = evaluator({ computeTimeoutMs: 1_000, maxPending: 1 })
    await service.next(daily, new Date('2030-01-01T00:00:00Z'))
    const active = service.next(impossible, new Date('2030-01-01T00:00:00Z'))
    const activeRejected = expect(active).rejects.toThrow('stopped')
    const pending = service.next(daily, new Date('2030-01-01T00:00:00Z'))
    const pendingRejected = expect(pending).rejects.toThrow('stopped')
    await expect(service.next(daily, new Date('2030-01-01T00:00:00Z'))).rejects.toThrow('Too many')
    await service.close()
    await Promise.all([activeRejected, pendingRejected])
    await expect(service.next(daily, new Date('2030-01-01T00:00:00Z'))).rejects.toThrow('stopped')
  })

  it('retains valid sparse rules instead of banning their shape', async () => {
    expect(await evaluator().next({ ...daily, dtstartLocal: '2030-01-01T09:00:00', rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO' }, new Date('2030-01-01T00:00:00Z'))).toBe('2044-02-29T09:00:00.000Z')
  })
})
