import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'
import type { AutomationScheduleRecord, ScheduleRunRecord, ScheduleRunStatus } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const execution = { model: 'auto', thinking: 'auto', speed: 'normal' } as const
const epoch = Date.parse('2030-01-01T00:00:00.000Z')

function run(id: number, taskId: string, status: ScheduleRunStatus = 'succeeded', queuedAt = new Date(epoch + id * 1_000).toISOString()): ScheduleRunRecord {
  return {
    id: `run-${id}`,
    taskId,
    taskRevision: 1,
    trigger: 'scheduled',
    scheduledFor: queuedAt,
    queuedAt,
    startedAt: status === 'queued' ? undefined : queuedAt,
    finishedAt: status === 'queued' || status === 'running' ? undefined : queuedAt,
    status,
    execution,
  }
}

function schedule(id: number, runs: ScheduleRunRecord[] = []): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: `schedule-${id}`,
    harness: 'prime',
    revision: 1,
    title: `Schedule ${id}`,
    prompt: 'Retain bounded history',
    target: { kind: 'project', projectId: 'project-one' },
    timing: { kind: 'once', at: '2040-01-01T00:00:00.000Z' },
    execution,
    status: 'paused',
    createdBy: 'user',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
    runs,
  }
}

function schedulesWithRuns(count: number, status: ScheduleRunStatus = 'succeeded'): AutomationScheduleRecord[] {
  const schedules: AutomationScheduleRecord[] = []
  for (let first = 0, scheduleIndex = 0; first < count; first += 50, scheduleIndex += 1) {
    const taskId = `schedule-${scheduleIndex}`
    const runs = Array.from({ length: Math.min(50, count - first) }, (_, offset) => run(first + offset, taskId, status))
    schedules.push(schedule(scheduleIndex, runs))
  }
  return schedules
}

function stateWithSchedules(schedules: AutomationScheduleRecord[]) {
  return { version: 4, projects: [], settings: {}, archivedSessions: [], dismissedProjectPaths: [], schedules }
}

function stateFile(state: unknown): { path: string; store: JsonStateStore } {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-run-retention-'))
  dirs.push(dir)
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify(state))
  return { path, store: new JsonStateStore(path) }
}

function allRuns(store: JsonStateStore): ScheduleRunRecord[] {
  return store.snapshot().schedules.flatMap((task) => task.runs)
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try { assertion(); return } catch { await new Promise((resolve) => setTimeout(resolve, 10)) }
  }
  assertion()
}

describe('scheduled run history retention', () => {
  it.each([1_999, 2_000])('preserves %s valid terminal runs at and below the global boundary', (count) => {
    const { store } = stateFile(stateWithSchedules(schedulesWithRuns(count)))
    expect(allRuns(store)).toHaveLength(count)
  })

  it('evicts the globally oldest terminal run when parsing 2,001 records', () => {
    const schedules = schedulesWithRuns(2_001)
    const displaced = schedules[20].runs[10]
    displaced.queuedAt = '2020-01-01T00:00:00.000Z'
    displaced.finishedAt = displaced.queuedAt

    const { store } = stateFile(stateWithSchedules(schedules))
    const retained = allRuns(store)
    expect(retained).toHaveLength(2_000)
    expect(retained.map(({ id }) => id)).not.toContain(displaced.id)
    expect(retained.map(({ id }) => id)).toContain('run-0')
    expect(retained.map(({ id }) => id)).toContain('run-2000')
  })

  it('applies the global invariant while migrating pre-harness schedule state', () => {
    const legacySchedules = schedulesWithRuns(2_001).map(({ harness: _harness, ...task }) => task)
    const { store } = stateFile({ ...stateWithSchedules([]), version: 2, schedules: legacySchedules })

    expect(allRuns(store)).toHaveLength(2_000)
    expect(store.snapshot().schedules.every(({ harness }) => harness === 'prime')).toBe(true)
    expect(allRuns(store).map(({ id }) => id)).not.toContain('run-0')
  })

  it('uses schedule and run order as a stable tie-breaker without reordering retained history', () => {
    const schedules = schedulesWithRuns(2_001)
    for (const candidate of schedules.flatMap((task) => task.runs)) {
      candidate.queuedAt = '2030-01-01T00:00:00.000Z'
      candidate.finishedAt = candidate.queuedAt
    }

    const { store } = stateFile(stateWithSchedules(schedules))
    const retained = allRuns(store)
    expect(retained).toHaveLength(2_000)
    expect(retained[0].id).toBe('run-1')
    expect(retained.at(-1)?.id).toBe('run-2000')
  })

  it('keeps active records and only overflows when active records alone exceed a cap', () => {
    const mixed = schedulesWithRuns(1_999, 'queued')
    mixed.push(schedule(40, [run(1_999, 'schedule-40'), run(2_000, 'schedule-40')]))
    const { store: mixedStore } = stateFile(stateWithSchedules(mixed))
    const mixedRuns = allRuns(mixedStore)
    expect(mixedRuns).toHaveLength(2_000)
    expect(mixedRuns.filter(({ status }) => status === 'queued')).toHaveLength(1_999)
    expect(mixedRuns.map(({ id }) => id)).not.toContain('run-1999')
    expect(mixedRuns.map(({ id }) => id)).toContain('run-2000')

    const activeOnly = schedulesWithRuns(2_001, 'running')
    const { store: activeStore } = stateFile(stateWithSchedules(activeOnly))
    expect(allRuns(activeStore)).toHaveLength(2_001)

    activeOnly.push(schedule(41, [run(2_001, 'schedule-41'), run(2_002, 'schedule-41')]))
    const { store: activeMixedStore } = stateFile(stateWithSchedules(activeOnly))
    const activeMixedRuns = allRuns(activeMixedStore)
    expect(activeMixedRuns).toHaveLength(2_001)
    expect(activeMixedRuns.every(({ status }) => status === 'running')).toBe(true)
  })

  it('applies the same active-safe rule to the 50-run per-task cap', () => {
    const terminalTask = schedule(0, Array.from({ length: 51 }, (_, index) => run(index, 'schedule-0')))
    const activeTask = schedule(1, Array.from({ length: 51 }, (_, index) => run(100 + index, 'schedule-1', 'queued')))
    const { store } = stateFile(stateWithSchedules([terminalTask, activeTask]))

    expect(store.snapshot().schedules[0].runs.map(({ id }) => id)).toEqual(Array.from({ length: 50 }, (_, index) => `run-${index + 1}`))
    expect(store.snapshot().schedules[1].runs).toHaveLength(51)
  })

  it('persists the normalized state and preserves it across a parse/persist restart round trip', async () => {
    const { path, store } = stateFile(stateWithSchedules(schedulesWithRuns(2_001)))
    expect(allRuns(store)).toHaveLength(2_000)

    await store.update(() => undefined)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as { schedules: AutomationScheduleRecord[] }
    expect(persisted.schedules.flatMap((task) => task.runs)).toHaveLength(2_000)
    expect(allRuns(new JsonStateStore(path)).map(({ id }) => id)).toEqual(allRuns(store).map(({ id }) => id))
  })

  it('reconciles an active-only overflow after restart without retaining more than 2,000 terminal records', async () => {
    const { store } = stateFile(stateWithSchedules(schedulesWithRuns(2_001, 'running')))
    const service = new AutomationService(store, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: async () => ({}),
      now: () => new Date('2035-01-01T00:00:00.000Z'),
    })

    await service.start()
    const reconciled = allRuns(store)
    expect(reconciled).toHaveLength(2_000)
    expect(reconciled.every(({ status }) => status === 'interrupted')).toBe(true)
    expect(reconciled.map(({ id }) => id)).not.toContain('run-0')
    await service.stop()
  })

  it('evicts another task\'s oldest terminal record for the first run of a new task at the boundary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-run-retention-service-'))
    dirs.push(dir)
    const store = new JsonStateStore(join(dir, 'state.json'))
    let releaseRun: () => void = () => undefined
    const execute = vi.fn(() => new Promise<Record<string, never>>((resolve) => { releaseRun = () => resolve({}) }))
    const service = new AutomationService(store, {
      validateTarget: async () => undefined,
      validateExecution: async () => undefined,
      run: execute,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
    })
    await service.start()
    const newTask = await service.create({
      prompt: 'First run at the boundary',
      target: { kind: 'project', projectId: 'project-one' },
      timing: { kind: 'once', at: '2040-01-01T00:00:00.000Z' },
      execution,
    })
    await store.update((state) => { state.schedules.push(...schedulesWithRuns(2_000)) })

    const queued = await service.runNow(newTask.id)
    const retained = allRuns(store)
    expect(retained).toHaveLength(2_000)
    expect(retained.map(({ id }) => id)).not.toContain('run-0')
    expect(retained.map(({ id }) => id)).toContain(queued.id)

    await eventually(() => expect(execute).toHaveBeenCalledOnce())
    releaseRun()
    await service.stop()
  })
})
