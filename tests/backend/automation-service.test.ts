import { BoundedRecurrenceEvaluator } from '../../electron/main/schedules/recurrence-evaluator'
import { recurrenceWorkerFixture } from '../helpers/recurrence-worker'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertNoMcpAuthenticationCommand, NETWORK_MCP_AUTH_UNAVAILABLE } from '../../src/lib/mcp-policy'
import type { ScheduleExecution, ScheduleTarget } from '../../src/types/api'
import { AutomationService, ScheduleBlockedError } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'

let workerFixture: Awaited<ReturnType<typeof recurrenceWorkerFixture>>
beforeAll(async () => { workerFixture = await recurrenceWorkerFixture() })
afterAll(async () => { await workerFixture.dispose() })
function recurrence(): BoundedRecurrenceEvaluator { return new BoundedRecurrenceEvaluator({ workerUrl: workerFixture.url }) }

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
  it('uses isolated recurrence evaluation for public previews', async () => {
    const service = new AutomationService(store(), {
      recurrence, validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => ({}), now: () => new Date('2030-01-01T00:00:00Z'),
    })
    try {
      await expect(service.preview({ kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=DAILY' }, 2)).resolves.toMatchObject({ occurrences: ['2030-01-01T09:00:00.000Z', '2030-01-02T09:00:00.000Z'] })
      await expect(service.preview({ kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30' }, 1)).rejects.toThrow('time budget')
    } finally { await service.stop() }
  })

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

  it('keeps an edited paused schedule paused until explicitly resumed', async () => {
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => ({}), now: () => new Date('2030-01-01T00:00:00Z'),
    })
    const created = await service.create({ prompt: 'Review', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const paused = await service.pause(created.id)
    const updated = await service.update(created.id, { revision: paused.revision, title: 'Revised' })
    expect(updated).toMatchObject({ status: 'paused', nextRunAt: undefined, title: 'Revised' })
    await service.stop()
  })

  it('rejects forbidden prompts on create, update, resume, and run now before validation or persistence', async () => {
    const stateStore = store()
    const legacy = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: async () => ({}),
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    const normal = await legacy.create({ prompt: 'Allowed', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const forbidden = await legacy.create({ prompt: '/mcp login notion', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    await legacy.pause(forbidden.id)
    const validateTarget = vi.fn(async () => undefined)
    const validateExecution = vi.fn(async () => undefined)
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      validatePrompt: assertNoMcpAuthenticationCommand,
      validateTarget,
      validateExecution,
      run,
      now: () => new Date('2030-01-01T01:00:00Z'),
    })

    await expect(service.create({ prompt: '/mcp login create', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })).rejects.toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)
    await expect(service.update(normal.id, { revision: normal.revision, prompt: '/mcp login update' })).rejects.toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)
    await expect(service.resume(forbidden.id)).rejects.toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)
    await expect(service.runNow(forbidden.id)).rejects.toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)

    expect(validateTarget).not.toHaveBeenCalled()
    expect(validateExecution).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(service.list()).toHaveLength(2)
    expect(service.get(normal.id)).toMatchObject({ revision: 1, prompt: 'Allowed', runs: [] })
    expect(service.get(forbidden.id)).toMatchObject({ revision: 2, status: 'paused', nextRunAt: undefined, runs: [] })
  })

  it('blocks legacy active prompts once on startup while leaving paused cleanup records unchanged', async () => {
    const stateStore = store()
    const legacy = new AutomationService(stateStore, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: async () => ({}),
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    const active = await legacy.create({ prompt: '/mcp login active', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const paused = await legacy.create({ prompt: '/mcp login paused', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const pausedRecord = await legacy.pause(paused.id)
    const validateTarget = vi.fn(async () => undefined)
    const validateExecution = vi.fn(async () => undefined)
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      validatePrompt: assertNoMcpAuthenticationCommand,
      validateTarget,
      validateExecution,
      run,
      now: () => new Date('2030-01-01T01:00:00Z'),
    })

    await service.start()
    expect(service.get(active.id)).toMatchObject({
      revision: active.revision + 1,
      status: 'blocked',
      blockedReason: NETWORK_MCP_AUTH_UNAVAILABLE,
      nextRunAt: undefined,
      updatedAt: '2030-01-01T01:00:00.000Z',
      runs: [],
    })
    expect(service.get(paused.id)).toEqual(pausedRecord)
    await service.stop()
    await service.start()
    expect(service.get(active.id).revision).toBe(active.revision + 1)
    await expect(service.resume(paused.id)).rejects.toThrow(NETWORK_MCP_AUTH_UNAVAILABLE)
    expect(service.get(paused.id)).toEqual(pausedRecord)
    expect(validateTarget).not.toHaveBeenCalled()
    expect(validateExecution).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    await service.stop()
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

  it('announces the persisted running state before a run completes', async () => {
    let finish: () => void = () => undefined
    const run = vi.fn(() => new Promise<Record<string, never>>((resolve) => { finish = () => resolve({}) }))
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined, validateExecution: async () => undefined,
      run, now: () => new Date('2030-01-01T00:00:00Z'),
    })
    const task = await service.create({ prompt: 'Review', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const statuses: string[] = []
    service.onDidChange(() => { statuses.push(service.get(task.id).runs[0]?.status ?? 'missing') })
    await service.runNow(task.id)
    await eventually(() => expect(statuses).toEqual(['queued', 'running']))
    finish()
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
      await expect(service.runNow(deleted.id)).rejects.toThrow('already queued')
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

  it('cancels a stale queued generation before dispatch and runs the updated generation', async () => {
    const started: Array<{ id: string; prompt: string; revision: number }> = []
    const releases: Array<() => void> = []
    const run = vi.fn((task: { id: string; prompt: string; revision: number }) => {
      started.push({ id: task.id, prompt: task.prompt, revision: task.revision })
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
    const v1 = await service.create({ prompt: 'Generation v1', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })

    try {
      await service.runNow(first.id)
      await service.runNow(second.id)
      await eventually(() => expect(started.map(({ id }) => id)).toEqual([first.id, second.id]))
      const staleRun = await service.runNow(v1.id)
      const v2 = await service.update(v1.id, { revision: v1.revision, prompt: 'Generation v2' })
      const currentRun = await service.runNow(v2.id)

      releases[0]()
      await eventually(() => expect(service.get(v2.id).runs.find(({ id }) => id === currentRun.id)?.status).toBe('succeeded'))
      expect(started).toContainEqual({ id: v2.id, prompt: 'Generation v2', revision: 2 })
      const runs = service.get(v2.id).runs
      expect(runs.find(({ id }) => id === staleRun.id)).toMatchObject({
        taskRevision: 1,
        status: 'cancelled',
        finishedAt: '2030-01-01T00:00:00.000Z',
        error: 'Scheduled task changed before this queued run could start.',
      })
      expect(runs.find(({ id }) => id === currentRun.id)).toMatchObject({ taskRevision: 2, status: 'succeeded' })
      expect(started).not.toContainEqual(expect.objectContaining({ id: v1.id, revision: 1 }))
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

  it('does not advance an occurrence when persisting its queued run fails', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined, validateExecution: async () => undefined, run, now: () => now,
    })
    const task = await service.create({ prompt: 'Atomic claim', target, timing: onceAt('2030-01-01T00:00:00.010Z'), execution })
    await service.start()
    const originalUpdate = stateStore.update.bind(stateStore)
    const writes = vi.spyOn(stateStore, 'update').mockImplementation((mutator) => originalUpdate((state) => {
      const result = mutator(state)
      if (state.schedules.some((candidate) => candidate.runs.some((record) => record.status === 'queued'))) throw new Error('Queued record write failed')
      return result
    }))
    let observed: () => void = () => undefined
    const failed = new Promise<void>((resolve) => { observed = resolve })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => { void service.stop(); observed() })
    try {
      now = new Date('2030-01-01T00:00:00.010Z')
      await failed
      expect(service.get(task.id)).toMatchObject({ status: 'active', nextRunAt: task.nextRunAt, runs: [] })
      expect(run).not.toHaveBeenCalled()
    } finally { writes.mockRestore(); logged.mockRestore(); await service.stop() }
  })

  it('blocks only an over-budget legacy rule while recovering other tasks', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const service = new AutomationService(stateStore, {
      recurrence: () => new BoundedRecurrenceEvaluator({ workerUrl: workerFixture.url, computeTimeoutMs: 100 }),
      validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => ({}), now: () => now,
    })
    const bad = await service.create({ prompt: 'Bad legacy rule', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    const good = await service.create({ prompt: 'Good legacy rule', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    await stateStore.update((state) => {
      for (const task of state.schedules) {
        task.timing = { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: task.id === bad.id ? 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30' : 'FREQ=DAILY' }
        task.nextRunAt = '2030-01-01T09:00:00.000Z'
      }
    })
    now = new Date('2030-01-09T12:00:00Z')
    try {
      await service.start()
      expect(service.get(bad.id)).toMatchObject({ status: 'blocked', blockedReason: expect.stringContaining('time budget'), nextRunAt: undefined })
      expect(service.get(good.id)).toMatchObject({ status: 'active', nextRunAt: '2030-01-10T09:00:00.000Z', runs: [expect.objectContaining({ status: 'skipped', skippedCount: 9 })] })
    } finally { await service.stop() }
  })

  it('waits for interrupted recurrence recovery on shutdown without blocking the task', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const engine = recurrence()
    const originalCount = engine.countMissed.bind(engine)
    let entered: () => void = () => undefined
    const evaluating = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(engine, 'countMissed').mockImplementation((...args) => { const result = originalCount(...args); entered(); return result })
    const service = new AutomationService(stateStore, {
      recurrence: () => engine, validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => ({}), now: () => now,
    })
    const task = await service.create({ prompt: 'Legacy rule', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    await stateStore.update((state) => {
      state.schedules[0].timing = { kind: 'rrule', dtstartLocal: '2030-01-01T09:00:00', timeZone: 'UTC', rrule: 'FREQ=MINUTELY;BYMONTH=2;BYMONTHDAY=30' }
      state.schedules[0].nextRunAt = '2030-01-01T09:00:00.000Z'
    })
    now = new Date('2030-01-09T12:00:00Z')
    const starting = service.start()
    await evaluating
    await service.stop()
    await starting
    expect(service.get(task.id)).toMatchObject({ status: 'active', runs: [] })
  })

  it('spaces retries after bookkeeping failures instead of hot-looping a due task', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const service = new AutomationService(stateStore, {
      validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => ({}), now: () => now,
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let attempts = 0
    let writes: ReturnType<typeof vi.spyOn> | undefined
    try {
      await service.create({ prompt: 'Due task', target, timing: onceAt('2030-01-01T00:00:00.001Z'), execution })
      await service.start()
      const original = stateStore.update.bind(stateStore)
      writes = vi.spyOn(stateStore, 'update').mockImplementation((mutator) => original((state) => {
        const value = mutator(state)
        if (state.schedules.some((task) => task.runs.some((run) => run.status === 'queued'))) { attempts += 1; throw new Error('Disk write refused') }
        return value
      }))
      now = new Date('2030-01-01T00:00:00.001Z')
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(attempts).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(attempts).toBe(2)
    } finally { writes?.mockRestore(); logged.mockRestore(); await service.stop(); vi.useRealTimers() }
  })

  it('blocks a scheduled definition when its executor reports lost authorization', async () => {
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined, validateExecution: async () => undefined,
      run: async () => { throw new ScheduleBlockedError('Project authorization was revoked') },
      now: () => new Date('2030-01-01T00:00:00Z'),
    })
    const task = await service.create({ prompt: 'Review', target, timing: onceAt('2030-01-02T00:00:00Z'), execution })
    try {
      await service.runNow(task.id)
      await eventually(() => expect(service.get(task.id)).toMatchObject({ status: 'blocked', nextRunAt: undefined, blockedReason: 'Project authorization was revoked', runs: [expect.objectContaining({ status: 'failed' })] }))
    } finally { await service.stop() }
  })

  it('checks the wall clock promptly after sleep instead of waiting for the original long delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = new Date('2030-01-01T00:00:00Z')
    let dispatched: () => void = () => undefined
    const entered = new Promise<void>((resolve) => { dispatched = resolve })
    const run = vi.fn(async () => { dispatched(); return {} })
    const service = new AutomationService(store(), {
      validateTarget: async () => undefined, validateExecution: async () => undefined, run, now: () => now,
    })
    try {
      await service.create({ prompt: 'Wake task', target, timing: onceAt('2030-01-01T01:00:00Z'), execution })
      await service.start()
      now = new Date('2030-01-01T01:00:00Z')
      await vi.advanceTimersByTimeAsync(15_000)
      await entered
      expect(run).toHaveBeenCalledOnce()
    } finally { await service.stop(); vi.useRealTimers() }
  })

  it('records missed occurrences as skipped without dispatching them', async () => {
    const stateStore = store()
    let now = new Date('2030-01-01T00:00:00Z')
    const run = vi.fn(async () => ({}))
    const service = new AutomationService(stateStore, {
      recurrence,
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
