/**
 * Shared async primitives for the main process. These replace the hand-rolled
 * limiters and in-flight dedupe caches that previously lived in the session
 * catalog, session service, plugin discovery, and process admission paths.
 */

/** Stable, locale-independent path ordering used by every catalog sort. */
export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Maps values with bounded concurrency. `null` results are filtered out;
 * results arrive in completion order, matching the previous worker pools.
 */
export async function mapLimit<T, U>(values: readonly T[], limit: number, mapper: (value: T) => Promise<U | null>): Promise<U[]> {
  const result: U[] = []
  let index = 0
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = values[index++]
      const mapped = await mapper(current)
      if (mapped !== null) result.push(mapped)
    }
  }))
  return result
}

export interface SingleFlight<K, V> {
  /** Joins the in-flight operation for `key`, or starts one; the entry clears once it settles. */
  run(key: K, factory: () => Promise<V>): Promise<V>
  get(key: K): Promise<V> | undefined
  readonly size: number
}

/** Keyed in-flight dedupe: concurrent callers for one key share one operation. */
export function createSingleFlight<K, V>(): SingleFlight<K, V> {
  const inFlight = new Map<K, Promise<V>>()
  return {
    run(key, factory) {
      const existing = inFlight.get(key)
      if (existing) return existing
      const operation = (async () => factory())().finally(() => {
        if (inFlight.get(key) === operation) inFlight.delete(key)
      })
      inFlight.set(key, operation)
      return operation
    },
    get: (key) => inFlight.get(key),
    get size() { return inFlight.size },
  }
}

export interface KeyedMutex<K> {
  /** Runs `action` after every earlier action for `key` settles; different keys run concurrently. */
  run<T>(key: K, action: () => Promise<T>): Promise<T>
  readonly size: number
}

/**
 * Per-key FIFO mutual exclusion. Each caller chains a private gate that only ever resolves, so a
 * rejected (or synchronously throwing) action releases the next waiter and its error reaches only
 * its own caller. The entry for a key clears once its last queued action settles.
 */
export function createKeyedMutex<K>(): KeyedMutex<K> {
  const tails = new Map<K, Promise<void>>()
  return {
    async run<T>(key: K, action: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((done) => { release = done })
      tails.set(key, current)
      await previous
      try {
        return await action()
      } finally {
        release()
        if (tails.get(key) === current) tails.delete(key)
      }
    },
    get size() { return tails.size },
  }
}

export interface AdmissionQueueOptions {
  maxConcurrent: number
  /** Tasks admitted beyond `maxConcurrent` wait here; further tasks are rejected. */
  maxPending: number
  pendingLimitError: () => Error
  closedError: () => Error
}

export interface AdmissionQueue {
  readonly activeCount: number
  readonly pendingCount: number
  /** Runs the task within the concurrency bound. Starts synchronously when capacity is available. */
  run<T>(task: () => Promise<T>): Promise<T>
  /** Rejects queued tasks and every later `run` call. Already-started tasks finish normally. */
  close(): void
}

/** Bounded-concurrency admission with a bounded waiting queue and shutdown support. */
export function createAdmissionQueue(options: AdmissionQueueOptions): AdmissionQueue {
  if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) throw new RangeError('maxConcurrent must be a positive integer')
  if (!Number.isInteger(options.maxPending) || options.maxPending < 0) throw new RangeError('maxPending must be a non-negative integer')
  let active = 0
  let closed = false
  const pending: Array<{ start: () => void; reject: (error: Error) => void }> = []

  const drain = (): void => {
    while (!closed && active < options.maxConcurrent) {
      const next = pending.shift()
      if (!next) return
      next.start()
    }
  }

  return {
    get activeCount() { return active },
    get pendingCount() { return pending.length },
    run<T>(task: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(options.closedError())
      return new Promise<T>((resolveTask, rejectTask) => {
        const start = (): void => {
          if (closed) { rejectTask(options.closedError()); return }
          active += 1
          let operation: Promise<T>
          try { operation = task() } catch (error) {
            active -= 1
            drain()
            rejectTask(error instanceof Error ? error : new Error(String(error)))
            return
          }
          operation.then(
            (value) => { active -= 1; drain(); resolveTask(value) },
            (error: unknown) => { active -= 1; drain(); rejectTask(error) },
          )
        }
        if (active < options.maxConcurrent) start()
        else if (pending.length >= options.maxPending) rejectTask(options.pendingLimitError())
        else pending.push({ start, reject: rejectTask })
      })
    },
    close() {
      if (closed) return
      closed = true
      for (const waiting of pending.splice(0)) waiting.reject(options.closedError())
    },
  }
}
