import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleExecution, ScheduleTarget } from '../../src/types/api'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
function store(): JsonStateStore {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-automation-'))
  dirs.push(dir)
  return new JsonStateStore(join(dir, 'state.json'))
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const target: ScheduleTarget = { kind: 'project', projectId: 'project-one' }
const execution: ScheduleExecution = { model: 'auto', thinking: 'auto', speed: 'normal' }
const onceAt = (time: string) => ({ kind: 'once' as const, at: time })

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { assertion(); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  assertion()
}

describe('AutomationService', () => {
  it('creates, updates, pauses, resumes, and deletes versioned tasks', async () => {
    let now = new Date('2030-01-01T00:00:00Z')
    const service = new AutomationService(store(), {
      validateTarget: vi.fn(async () => undefined),
      validateExecution: vi.fn(async () => undefined),
      run: vi.fn(async () => ({})),
      now: () => now,
    })
    const created = await service.create({
      title: 'Triage', prompt: 'Review issues', target,
      timing: onceAt('2030-01-02T09:00:00Z'), execution,
    })
    expect(created).toMatchObject({ harness: 'prime', revision: 1, status: 'active', createdBy: 'user', nextRunAt: '2030-01-02T09:00:00.000Z' })

    now = new Date('2030-01-01T01:00:00Z')
    const updated = await service.update(created.id, { revision: 1, title: 'Morning triage', timing: onceAt('2030-01-03T09:00:00Z') })
    expect(updated).toMatchObject({ revision: 2, title: 'Morning triage', nextRunAt: '2030-01-03T09:00:00.000Z' })
    await expect(service.update(created.id, { revision: 1, title: 'stale' })).rejects.toThrow(/changed/i)

    const paused = await service.pause(created.id)
    expect(paused).toMatchObject({ revision: 3, status: 'paused', nextRunAt: undefined })
    const resumed = await service.resume(created.id)
    expect(resumed).toMatchObject({ revision: 4, status: 'active', nextRunAt: '2030-01-03T09:00:00.000Z' })
    expect(await service.delete(created.id)).toBe(true)
    expect(service.list()).toEqual([])
  })

  it('keeps OMP and pi schedules isolated and routes validation and runs by harness', async () => {
    const validateTarget = vi.fn(async () => undefined)
    const validateExecution = vi.fn(async () => undefined)
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(store(), {
      validateTarget,
      validateExecution,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const prime = await service.create({ prompt: 'Prime run', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const omp = await service.create({ prompt: 'OMP run', target, timing: onceAt('2030-01-02T00:00:00Z'), execution }, 'user', 'omp')
    const pi = await service.create({ prompt: 'Pi run', target, timing: onceAt('2030-01-02T00:00:00Z'), execution }, 'user', 'pi')
    expect(service.list('prime').map((task) => task.id)).toEqual([prime.id])
    expect(service.list('omp').map((task) => task.id)).toEqual([omp.id])
    expect(service.list('pi').map((task) => task.id)).toEqual([pi.id])
    expect(validateTarget).toHaveBeenCalledWith(target, 'omp')
    expect(validateExecution).toHaveBeenCalledWith(execution, 'omp')
    expect(validateTarget).toHaveBeenCalledWith(target, 'pi')
    expect(validateExecution).toHaveBeenCalledWith(execution, 'pi')
    await service.runNow(omp.id)
    await eventually(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: omp.id, harness: 'omp' })))
    await service.runNow(pi.id)
    await eventually(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: pi.id, harness: 'pi' })))
    await service.stop()
  })

  it('runs a manual project task and persists its linked session result', async () => {
    const run = vi.fn(async () => ({ sessionId: 'fresh-session', sessionFile: '/tmp/fresh-session.jsonl' }))
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const task = await service.create({ prompt: 'Do the work', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const queued = await service.runNow(task.id)
    expect(queued.status).toBe('queued')
    await eventually(() => expect(service.get(task.id).runs[0]).toMatchObject({
      id: queued.id, status: 'succeeded', sessionId: 'fresh-session', sessionFile: '/tmp/fresh-session.jsonl',
    }))
    expect(run).toHaveBeenCalledOnce()
    await service.stop()
  })

  it('does not dispatch a queued run after its task is deleted', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const run = vi.fn((task: { id: string }) => {
      started.push(task.id)
      if (started.length > 2) return Promise.resolve({})
      return new Promise<Record<string, never>>((resolveRun) => releases.push(() => resolveRun({})))
    })
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const first = await service.create({ prompt: 'First blocker', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const second = await service.create({ prompt: 'Second blocker', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const deleted = await service.create({ prompt: 'Delete before dispatch', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const next = await service.create({ prompt: 'Run after deletion', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })

    try {
      await service.runNow(first.id)
      await service.runNow(second.id)
      await eventually(() => expect(started).toEqual([first.id, second.id]))
      await service.runNow(deleted.id)
      await service.runNow(deleted.id)
      expect(await service.delete(deleted.id)).toBe(true)
      await service.runNow(next.id)

      releases[0]()
      await eventually(() => expect(started).toHaveLength(3))
      expect(started[2]).toBe(next.id)
      expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ id: deleted.id }))
    } finally {
      for (const release of releases) release()
      await service.stop()
    }
  })

  it('revalidates a queued task against persisted state immediately before dispatch', async () => {
    const stateStore = store()
    const started: string[] = []
    const releases: Array<() => void> = []
    const run = vi.fn((task: { id: string }) => {
      started.push(task.id)
      if (started.length > 2) return Promise.resolve({})
      return new Promise<Record<string, never>>((resolveRun) => releases.push(() => resolveRun({})))
    })
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const first = await service.create({ prompt: 'First blocker', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const second = await service.create({ prompt: 'Second blocker', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const stale = await service.create({ prompt: 'Stale queued task', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const next = await service.create({ prompt: 'Run after stale entry', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })

    try {
      await service.runNow(first.id)
      await service.runNow(second.id)
      await eventually(() => expect(started).toEqual([first.id, second.id]))
      await service.runNow(stale.id)
      // Model a queued entry whose persisted task disappears without the
      // in-memory queue receiving the public delete notification.
      await stateStore.update((state) => {
        const index = state.schedules.findIndex((task) => task.id === stale.id)
        state.schedules.splice(index, 1)
      })
      await service.runNow(next.id)

      releases[0]()
      await eventually(() => expect(started).toHaveLength(3))
      expect(started[2]).toBe(next.id)
      expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ id: stale.id }))
    } finally {
      for (const release of releases) release()
      await service.stop()
    }
  })

  it('allows an already-running task to finish after its schedule is deleted', async () => {
    let resolveRun: () => void = () => undefined
    let settled = false
    const run = vi.fn(() => new Promise<Record<string, never>>((resolveDispatch) => {
      resolveRun = () => resolveDispatch({})
    }).finally(() => { settled = true }))
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const task = await service.create({ prompt: 'Already running', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    await service.runNow(task.id)
    await eventually(() => expect(run).toHaveBeenCalledOnce())

    expect(await service.delete(task.id)).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveRun()
    await service.stop()
    expect(settled).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('records missed occurrences as skipped without dispatching them', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run,
      now: () => now,
    })
    const task = await service.create({
      prompt: 'Hourly check', target,
      timing: { kind: 'rrule', dtstartLocal: '2030-01-01T01:00:00', timeZone: 'UTC', rrule: 'FREQ=HOURLY' }, execution,
    })
    now = new Date('2030-01-01T04:30:00Z')
    await service.start()
    const recovered = service.get(task.id)
    expect(recovered.runs[0]).toMatchObject({ status: 'skipped', skippedCount: 4 })
    expect(recovered.nextRunAt).toBe('2030-01-01T05:00:00.000Z')
    expect(run).not.toHaveBeenCalled()
    await service.stop()
  })

  it('marks runs stranded as queued/running by a previous process as interrupted on start', async () => {
    const stateStore = store()
    let resolveRun: () => void = () => undefined
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: () => new Promise((resolveDispatch) => { resolveRun = () => resolveDispatch({}) }),
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    await service.start()
    const task = await service.create({ prompt: 'Long job', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    await service.runNow(task.id)
    await eventually(() => expect(service.get(task.id).runs[0].status).toBe('running'))

    // A second service over the same store models an app relaunch: the old
    // process never finished, so its run must surface as interrupted.
    const relaunched = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: async () => ({}),
      now: () => new Date('2030-01-01T01:00:00Z'),
    })
    await relaunched.start()
    expect(relaunched.get(task.id).runs[0]).toMatchObject({ status: 'interrupted', finishedAt: '2030-01-01T01:00:00.000Z' })
    await relaunched.stop()
    resolveRun()
    await service.stop()
  })

  it('contains dispatch bookkeeping failures without an unhandled rejection', async () => {
    const stateStore = store()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => { rejections.push(reason) }
    process.on('unhandledRejection', onRejection)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const service = new AutomationService(stateStore, {
        validateTarget: async () => undefined,
        validateExecution: async () => undefined,
        // Exercise the guarded failure bookkeeping chain.
        run: async () => { throw new Error('runtime unavailable') },
        now: () => new Date('2030-01-01T00:00:00Z'),
      })
      await service.start()
      const task = await service.create({ prompt: 'Doomed job', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
      await service.runNow(task.id)
      await eventually(() => expect(service.get(task.id).runs[0].status).toBe('failed'))
      await service.stop()
      // Give any stray rejection a macrotask to surface before asserting.
      await new Promise((resolveWait) => setTimeout(resolveWait, 20))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
      consoleError.mockRestore()
    }
  })
})
