// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAutomations } from '../../src/hooks/useAutomations'
import type { AutomationScheduleRecord, HarnessId, PrimeWorkApi } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

it('preserves caller-owned schedules without a bridge and owns focus/error setters', async () => {
  const initial: AutomationScheduleRecord[] = []
  let state!: ReturnType<typeof useAutomations>
  const reportError = vi.fn()
  function Probe() { state = useAutomations({ bridge: null, harness: 'omp', initialSchedules: initial, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { state.setScheduleFocusId('chosen'); state.setScheduleError('known'); await state.refreshSchedules() })
  expect(state.schedules).toBe(initial)
  expect(state.scheduleFocusId).toBe('chosen')
  expect(state.scheduleError).toBe('known')
})

it('subscribes without duplicating bootstrap and keeps only the latest refresh across harness switches', async () => {
  const first = deferred<AutomationScheduleRecord[]>()
  const next = deferred<AutomationScheduleRecord[]>()
  const list = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => next.promise)
  const unsubscribe = vi.fn()
  let notify!: () => void
  const onChanged = vi.fn((callback: () => void) => { notify = callback; return unsubscribe })
  const bridge = { schedules: { list, onChanged } } as unknown as PrimeWorkApi
  let harness: HarnessId = 'omp'
  let state!: ReturnType<typeof useAutomations>
  const reportError = vi.fn()
  function Probe() { state = useAutomations({ bridge, harness, reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  expect(list).not.toHaveBeenCalled()
  await act(async () => { notify() })
  expect(list).toHaveBeenLastCalledWith('omp')
  harness = 'pi'
  await act(async () => { root.render(<Probe />); state.setScheduleError('old error') })
  expect(unsubscribe).toHaveBeenCalledTimes(1)
  await act(async () => { notify() })
  expect(list).toHaveBeenLastCalledWith('pi')
  const records: AutomationScheduleRecord[] = []
  await act(async () => { next.resolve(records); await next.promise })
  await act(async () => { first.reject(new Error('old harness')); await first.promise.catch(() => undefined) })
  expect(state.schedules).toBe(records)
  expect(state.scheduleError).toBe('')
  expect(reportError).not.toHaveBeenCalled()
})

it('reports a current refresh error and clears it after a later successful result', async () => {
  const failure = new Error('schedule unavailable')
  const list = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce([])
  const bridge = { schedules: { list, onChanged: () => () => undefined } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let state!: ReturnType<typeof useAutomations>
  function Probe() { state = useAutomations({ bridge, harness: 'omp', reportError }); return null }
  await act(async () => { root.render(<Probe />) })
  await act(async () => { await state.refreshSchedules() })
  expect(state.scheduleError).toBe('schedule unavailable')
  expect(reportError).toHaveBeenCalledExactlyOnceWith(failure)
  await act(async () => { await state.refreshSchedules() })
  expect(state.scheduleError).toBe('')
})
