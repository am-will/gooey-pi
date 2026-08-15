import type { AutomationScheduleRecord, ScheduleRunRecord } from '../../../src/types/api'

export const MAX_RUNS_PER_TASK = 50
export const MAX_GLOBAL_RUNS = 2_000

interface IndexedRun {
  scheduleIndex: number
  runIndex: number
  run: ScheduleRunRecord
}

function isActive(run: ScheduleRunRecord): boolean {
  return run.status === 'queued' || run.status === 'running'
}

function queuedTime(run: ScheduleRunRecord): number {
  const parsed = Date.parse(run.queuedAt)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

/**
 * Sort terminal history from oldest to newest. Persisted timestamps are the
 * primary authority; schedule and run order make equal timestamps stable.
 */
function oldestFirst(left: IndexedRun, right: IndexedRun): number {
  return queuedTime(left.run) - queuedTime(right.run)
    || left.scheduleIndex - right.scheduleIndex
    || left.runIndex - right.runIndex
}

function removeRunIndexes(task: AutomationScheduleRecord, indexes: Set<number>): void {
  if (indexes.size === 0) return
  task.runs = task.runs.filter((_run, index) => !indexes.has(index))
}

/**
 * Enforces scheduled-run retention for every draft-state entry point.
 *
 * Active queued/running records are never history and are therefore never
 * evicted. Each task retains its newest terminal records within a 50-record
 * budget after accounting for active records, then the state retains the
 * newest terminal records within the 2,000-record global budget. The only
 * permitted temporary overflow is when active records alone exceed a budget;
 * later status transitions normalize the state again.
 */
export function normalizeScheduleRunHistory(schedules: AutomationScheduleRecord[]): void {
  for (const [scheduleIndex, task] of schedules.entries()) {
    const activeCount = task.runs.filter(isActive).length
    const terminalBudget = Math.max(0, MAX_RUNS_PER_TASK - activeCount)
    const terminals = task.runs
      .map((run, runIndex): IndexedRun => ({ scheduleIndex, runIndex, run }))
      .filter(({ run }) => !isActive(run))
      .sort(oldestFirst)
    const evictionCount = Math.max(0, terminals.length - terminalBudget)
    removeRunIndexes(task, new Set(terminals.slice(0, evictionCount).map(({ runIndex }) => runIndex)))
  }

  const indexed = schedules.flatMap((task, scheduleIndex) => (
    task.runs.map((run, runIndex): IndexedRun => ({ scheduleIndex, runIndex, run }))
  ))
  const activeCount = indexed.filter(({ run }) => isActive(run)).length
  const terminalBudget = Math.max(0, MAX_GLOBAL_RUNS - activeCount)
  const terminals = indexed.filter(({ run }) => !isActive(run)).sort(oldestFirst)
  const evictionCount = Math.max(0, terminals.length - terminalBudget)
  if (evictionCount === 0) return

  const removals = new Map<number, Set<number>>()
  for (const { scheduleIndex, runIndex } of terminals.slice(0, evictionCount)) {
    const indexes = removals.get(scheduleIndex) ?? new Set<number>()
    indexes.add(runIndex)
    removals.set(scheduleIndex, indexes)
  }
  for (const [scheduleIndex, indexes] of removals) removeRunIndexes(schedules[scheduleIndex], indexes)
}
