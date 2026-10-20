import { afterEach, describe, expect, it, vi } from 'vitest'
import { comparePaths, createAdmissionQueue, createKeyedMutex, createSingleFlight, delay, mapLimit } from '../../electron/main/lib/async'

const tick = () => new Promise<void>((resolveTick) => setTimeout(resolveTick, 0))

describe('comparePaths', () => {
  it('orders byte-wise and reports equality', () => {
    expect(comparePaths('/a', '/b')).toBe(-1)
    expect(comparePaths('/b', '/a')).toBe(1)
    expect(comparePaths('/a', '/a')).toBe(0)
  })
})

describe('delay', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves only after the requested time', async () => {
    vi.useFakeTimers()
    let settled = false
    const waiting = delay(100).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(99)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await waiting
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not keep the process alive while waiting', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const waiting = delay(1)
    const timer = setTimeoutSpy.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    await waiting
  })

  it('resolves with a signal that never aborts and detaches its abort listener', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const waiting = delay(50, controller.signal)
    await vi.advanceTimersByTimeAsync(50)
    await expect(waiting).resolves.toBeUndefined()
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort(new Error('too late'))
  })

  it('rejects with the abort reason and clears the timer when aborted mid-wait', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const waiting = delay(10_000, controller.signal)
    expect(vi.getTimerCount()).toBe(1)
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects immediately without scheduling a timer when the signal is already aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    controller.abort()
    await expect(delay(10_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('mapLimit', () => {
  it('bounds concurrency and filters null results', async () => {
    let active = 0
    let maxActive = 0
    const values = Array.from({ length: 20 }, (_, index) => index)
    const result = await mapLimit(values, 3, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await tick()
      active -= 1
      return value % 2 === 0 ? value : null
    })

    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBeGreaterThan(1)
    expect([...result].sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('handles empty input and limits larger than the input', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([])
    expect(await mapLimit([1, 2], 16, async (value) => value)).toEqual([1, 2])
  })
})

describe('createSingleFlight', () => {
  it('shares one in-flight operation per key and clears it after settling', async () => {
    const flights = createSingleFlight<string, number>()
    let calls = 0
    let release!: (value: number) => void
    const factory = () => new Promise<number>((resolveFactory) => { calls += 1; release = resolveFactory })

    const first = flights.run('key', factory)
    const second = flights.run('key', factory)
    expect(first).toBe(second)
    expect(flights.size).toBe(1)
    release(7)
    await expect(first).resolves.toBe(7)
    expect(flights.size).toBe(0)
    expect(calls).toBe(1)

    const third = flights.run('key', async () => 8)
    expect(third).not.toBe(first)
    await expect(third).resolves.toBe(8)
  })

  it('keeps keys independent and clears rejected entries', async () => {
    const flights = createSingleFlight<number, string>()
    const good = flights.run(1, async () => 'good')
    const bad = flights.run(2, async () => { throw new Error('bad') })
    expect(flights.size).toBe(2)
    await expect(good).resolves.toBe('good')
    await expect(bad).rejects.toThrow('bad')
    expect(flights.size).toBe(0)
  })
})

describe('createKeyedMutex', () => {
  function deferred() {
    let resolveDeferred!: () => void
    const promise = new Promise<void>((resolvePromise) => { resolveDeferred = resolvePromise })
    return { promise, resolve: resolveDeferred }
  }

  it('runs actions for one key one at a time in call order', async () => {
    const mutex = createKeyedMutex<string>()
    const events: string[] = []
    const gates = [deferred(), deferred(), deferred()]
    const results = gates.map((gate, index) => mutex.run('session', async () => {
      events.push(`start ${index}`)
      await gate.promise
      events.push(`end ${index}`)
      return index
    }))

    await tick()
    expect(events).toEqual(['start 0'])
    expect(mutex.size).toBe(1)
    gates[2].resolve()
    gates[1].resolve()
    await tick()
    expect(events).toEqual(['start 0'])
    gates[0].resolve()
    await expect(Promise.all(results)).resolves.toEqual([0, 1, 2])
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2'])
    expect(mutex.size).toBe(0)
  })

  it('runs actions for different keys concurrently', async () => {
    const mutex = createKeyedMutex<string>()
    const started: string[] = []
    const gate = deferred()
    const first = mutex.run('a', async () => { started.push('a'); await gate.promise; return 'a' })
    const second = mutex.run('b', async () => { started.push('b'); await gate.promise; return 'b' })

    await tick()
    expect(started).toEqual(['a', 'b'])
    expect(mutex.size).toBe(2)
    gate.resolve()
    await expect(Promise.all([first, second])).resolves.toEqual(['a', 'b'])
    expect(mutex.size).toBe(0)
  })

  it('passes a rejection to its own caller and still runs the next action for the key', async () => {
    const mutex = createKeyedMutex<string>()
    const gate = deferred()
    const failing = mutex.run('key', async () => { await gate.promise; throw new Error('delivery failed') })
    let nextRan = false
    const next = mutex.run('key', async () => { nextRan = true; return 'next' })

    await tick()
    expect(nextRan).toBe(false)
    gate.resolve()
    await expect(failing).rejects.toThrow('delivery failed')
    await expect(next).resolves.toBe('next')
    expect(nextRan).toBe(true)
    expect(mutex.size).toBe(0)
  })

  it('releases the key when an action throws synchronously', async () => {
    const mutex = createKeyedMutex<number>()
    const syncThrow = (): Promise<string> => { throw new Error('sync failure') }
    await expect(mutex.run(1, syncThrow)).rejects.toThrow('sync failure')
    expect(mutex.size).toBe(0)
    await expect(mutex.run(1, async () => 'after')).resolves.toBe('after')
    expect(mutex.size).toBe(0)
  })
})

describe('createAdmissionQueue', () => {
  const options = () => ({
    maxConcurrent: 2,
    maxPending: 1,
    pendingLimitError: () => new Error('queue full'),
    closedError: () => new Error('closed'),
  })

  it('runs tasks within the concurrency bound and drains the queue in order', async () => {
    const queue = createAdmissionQueue(options())
    const releases: Array<() => void> = []
    const started: number[] = []
    const task = (id: number) => queue.run(() => new Promise<number>((resolveTask) => {
      started.push(id)
      releases.push(() => resolveTask(id))
    }))

    const first = task(1)
    const second = task(2)
    const third = task(3)
    expect(started).toEqual([1, 2])
    expect(queue.activeCount).toBe(2)
    expect(queue.pendingCount).toBe(1)

    releases[0]()
    await expect(first).resolves.toBe(1)
    expect(started).toEqual([1, 2, 3])
    releases[1]()
    releases[2]()
    await expect(second).resolves.toBe(2)
    await expect(third).resolves.toBe(3)
    expect(queue.activeCount).toBe(0)
  })

  it('rejects beyond the pending bound and propagates task failures while releasing capacity', async () => {
    const queue = createAdmissionQueue(options())
    const releases: Array<() => void> = []
    const hold = () => queue.run(() => new Promise<void>((resolveTask) => { releases.push(() => resolveTask()) }))
    const active = [hold(), hold()]
    const queued = hold()
    await expect(hold()).rejects.toThrow('queue full')

    for (const release of releases.splice(0)) release()
    await Promise.all(active)
    for (const release of releases.splice(0)) release()
    await queued
    expect(queue.activeCount).toBe(0)

    await expect(queue.run(async () => { throw new Error('task failed') })).rejects.toThrow('task failed')
    await expect(queue.run(() => { throw new Error('sync failure') })).rejects.toThrow('sync failure')
    expect(queue.activeCount).toBe(0)
    await expect(queue.run(async () => 'still admitting')).resolves.toBe('still admitting')
  })

  it('close rejects queued tasks and all later admissions but lets running tasks finish', async () => {
    const queue = createAdmissionQueue(options())
    let releaseRunning!: () => void
    const running = queue.run(() => new Promise<string>((resolveTask) => { releaseRunning = () => resolveTask('done') }))
    const alsoRunning = queue.run(async () => 'ok')
    const queued = queue.run(async () => 'never')
    queue.close()

    await expect(queued).rejects.toThrow('closed')
    await expect(queue.run(async () => 'later')).rejects.toThrow('closed')
    releaseRunning()
    await expect(running).resolves.toBe('done')
    await expect(alsoRunning).resolves.toBe('ok')
  })
})
