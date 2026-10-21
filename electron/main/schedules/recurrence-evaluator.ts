import { Worker } from 'node:worker_threads'
import type { ScheduleTiming } from '../../../src/types/api'
import { isRecord } from '../validation'
import { countMissedOccurrences, nextScheduleOccurrence, previewScheduleOccurrences } from './recurrence'
import type { RecurrenceJob, RecurrenceRequest } from './recurrence-protocol'

export interface ScheduleRecurrence {
  next(timing: ScheduleTiming, after: Date): Promise<string | null>
  preview(timing: ScheduleTiming, count: number, after: Date): Promise<string[]>
  countMissed(timing: ScheduleTiming, from: Date, until: Date, limit: number): Promise<number>
  close(): Promise<void>
}

interface PendingEvaluation {
  id: number
  job: RecurrenceJob
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface RecurrenceEvaluatorOptions {
  workerUrl?: URL
  computeTimeoutMs?: number
  startupTimeoutMs?: number
  maxPending?: number
}

export class RecurrenceEvaluationError extends Error {}

/** One bounded worker isolates RRULE loops that may never emit an occurrence or yield to a callback. */
export class BoundedRecurrenceEvaluator implements ScheduleRecurrence {
  private worker: Worker | null = null
  private ready = false
  private closed = false
  private sequence = 0
  private active: PendingEvaluation | undefined
  private readonly pending: PendingEvaluation[] = []
  private startupTimer: NodeJS.Timeout | undefined
  private computeTimer: NodeJS.Timeout | undefined
  private readonly workerUrl: URL
  private readonly computeTimeoutMs: number
  private readonly startupTimeoutMs: number
  private readonly maxPending: number

  constructor(options: RecurrenceEvaluatorOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL('./recurrence-worker.js', import.meta.url)
    this.computeTimeoutMs = options.computeTimeoutMs ?? 500
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000
    this.maxPending = options.maxPending ?? 32
  }

  async next(timing: ScheduleTiming, after: Date): Promise<string | null> {
    if (timing.kind === 'once') return nextScheduleOccurrence(timing, after)
    const value = await this.evaluate({ kind: 'next', timing, after: after.toISOString() })
    if (value === null || this.isInstant(value)) return value
    throw new RecurrenceEvaluationError('The recurrence worker returned an invalid next occurrence')
  }

  async preview(timing: ScheduleTiming, count: number, after: Date): Promise<string[]> {
    if (timing.kind === 'once') return previewScheduleOccurrences(timing, count, after)
    const value = await this.evaluate({ kind: 'preview', timing, count, after: after.toISOString() })
    if (Array.isArray(value) && value.length <= count && value.every((item): item is string => this.isInstant(item))) return value
    throw new RecurrenceEvaluationError('The recurrence worker returned invalid preview occurrences')
  }

  async countMissed(timing: ScheduleTiming, from: Date, until: Date, limit: number): Promise<number> {
    if (timing.kind === 'once') return countMissedOccurrences(timing, from, until, limit, { saturate: true })
    const value = await this.evaluate({ kind: 'missed', timing, from: from.toISOString(), until: until.toISOString(), limit, saturate: true })
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit) return value
    throw new RecurrenceEvaluationError('The recurrence worker returned an invalid missed count')
  }

  async close(): Promise<void> {
    this.closed = true
    await this.retire(new RecurrenceEvaluationError('Recurrence evaluation was stopped'))
  }

  private isInstant(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
  }

  private evaluate(job: RecurrenceJob): Promise<unknown> {
    if (this.closed) return Promise.reject(new RecurrenceEvaluationError('Recurrence evaluation was stopped'))
    if (this.pending.length >= this.maxPending) return Promise.reject(new RecurrenceEvaluationError('Too many recurrence evaluations are pending'))
    return new Promise((resolve, reject) => {
      this.pending.push({ id: ++this.sequence, job, resolve, reject })
      if (!this.worker) this.startWorker()
      this.pump()
    })
  }

  private startWorker(): void {
    try {
      const worker = new Worker(this.workerUrl)
      this.worker = worker
      worker.on('message', (message: unknown) => { if (this.worker === worker) this.receive(message) })
      worker.once('error', (error) => { if (this.worker === worker) void this.retire(error) })
      worker.once('exit', () => {
        if (this.worker === worker) void this.retire(new RecurrenceEvaluationError('The recurrence worker exited unexpectedly'))
      })
      this.startupTimer = setTimeout(() => {
        void this.retire(new RecurrenceEvaluationError('The recurrence worker did not become ready in time'))
      }, this.startupTimeoutMs)
      this.startupTimer.unref()
    } catch (error) {
      void this.retire(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private receive(message: unknown): void {
    if (!isRecord(message)) { void this.retire(new RecurrenceEvaluationError('Invalid recurrence worker response')); return }
    if (message.type === 'ready' && !this.ready) {
      clearTimeout(this.startupTimer)
      this.startupTimer = undefined
      this.ready = true
      this.pump()
      return
    }
    const active = this.active
    if (message.type !== 'result' || !active || message.id !== active.id || typeof message.success !== 'boolean') {
      void this.retire(new RecurrenceEvaluationError('Unexpected recurrence worker response')); return
    }
    clearTimeout(this.computeTimer)
    this.computeTimer = undefined
    this.active = undefined
    if (message.success) active.resolve(message.value)
    else {
      const detail = typeof message.error === 'string' ? message.error.slice(0, 4_000) : 'Recurrence evaluation failed'
      active.reject(message.name === 'TypeError' ? new TypeError(detail) : message.name === 'RangeError' ? new RangeError(detail) : new RecurrenceEvaluationError(detail))
    }
    this.pump()
  }

  private pump(): void {
    if (!this.worker || !this.ready || this.active) return
    const next = this.pending.shift()
    if (!next) { this.worker.unref(); return }
    this.active = next
    this.worker.ref()
    this.computeTimer = setTimeout(() => {
      void this.retire(new RecurrenceEvaluationError(`Recurrence evaluation exceeded its ${this.computeTimeoutMs}ms time budget; simplify the rule and try again`))
    }, this.computeTimeoutMs)
    this.computeTimer.unref()
    try { this.worker.postMessage({ id: next.id, job: next.job } satisfies RecurrenceRequest) }
    catch (error) { void this.retire(error instanceof Error ? error : new Error(String(error))) }
  }

  private async retire(error: Error): Promise<void> {
    const worker = this.worker
    this.worker = null
    this.ready = false
    clearTimeout(this.startupTimer)
    clearTimeout(this.computeTimer)
    this.startupTimer = undefined
    this.computeTimer = undefined
    this.active?.reject(error)
    this.active = undefined
    for (const item of this.pending.splice(0)) item.reject(error)
    if (worker) await worker.terminate().catch(() => undefined)
  }
}
