// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeHeartbeats } from '../../src/hooks/useNativeHeartbeats'
import type { HarnessId, NativeHeartbeatRecord, PrimeWorkApi } from '../../src/types/api'

const heartbeat: NativeHeartbeatRecord = { id: 'heartbeat', source: 'heartbeat', status: 'active', prompt: 'check', schedule: 'every 1h', sessionId: 's', sessionFile: '/sessions/s.jsonl', activeSessionId: 's' }
type Delivery = Parameters<PrimeWorkApi['agent']['onEvent']>[0]
function bridgeFixture() {
  const listeners = new Set<Delivery>()
  const list = vi.fn(async () => [heartbeat])
  const onEvent = vi.fn((listener: Delivery) => { listeners.add(listener); return () => { listeners.delete(listener) } })
  const bridge = { heartbeats: { list }, agent: { onEvent } } as unknown as PrimeWorkApi
  const emit = (type: string) => { for (const listener of [...listeners]) listener({ runtimeId: 'runtime', event: { type } }) }
  return { bridge, list, onEvent, listeners, emit }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
let latest: ReturnType<typeof useNativeHeartbeats>
let root: Root | undefined
let container: HTMLDivElement
let documentVisibility: DocumentVisibilityState
function Probe({ bridge, harness = 'prime', visible = true, reportError = () => {} }: { bridge: PrimeWorkApi | null; harness?: HarnessId; visible?: boolean; reportError?: (error: unknown) => void }) {
  latest = useNativeHeartbeats({ bridge, harness, visible, reportError })
  return null
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  documentVisibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => documentVisibility)
})
afterEach(() => { act(() => root?.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('native heartbeat lifecycle', () => {
  it('does not lose a refresh queued between read completion and runner settlement', async () => {
    const fixture = bridgeFixture()
    fixture.list.mockImplementationOnce(() => {
      const response = Promise.resolve([heartbeat])
      void response.then(() => queueMicrotask(() => { void latest.refreshHeartbeats() }))
      return response
    })
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge })))
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })

  it('does not start a queued automatic read after its view is hidden', async () => {
    const fixture = bridgeFixture()
    const pending = deferred<NativeHeartbeatRecord[]>()
    fixture.list.mockImplementationOnce(() => pending.promise)
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge })))
    act(() => fixture.emit('heartbeats_changed'))
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, visible: false })))
    await act(async () => pending.resolve([heartbeat]))
    expect(fixture.list).toHaveBeenCalledOnce()
    await act(async () => latest.refreshHeartbeats())
    expect(fixture.list).toHaveBeenCalledTimes(2)
    expect(latest.heartbeats).toEqual([heartbeat])
  })

  it.each(['omp', 'pi'] as const)('never reads Prime heartbeats for %s, including manual refresh', async (harness) => {
    const fixture = bridgeFixture()
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, harness })))
    await act(async () => latest.refreshHeartbeats())
    expect(latest.heartbeats).toEqual([])
    expect(fixture.list).not.toHaveBeenCalled()
    expect(fixture.onEvent).not.toHaveBeenCalled()
  })

  it('polls and subscribes only while the view and document are visible; manual refresh remains available', async () => {
    vi.useFakeTimers()
    const fixture = bridgeFixture()
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge })))
    expect(fixture.list).toHaveBeenCalledTimes(1)
    expect(fixture.listeners.size).toBe(1)
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fixture.list).toHaveBeenCalledTimes(2)
    act(() => { documentVisibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
    expect(fixture.listeners.size).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(fixture.list).toHaveBeenCalledTimes(2)
    await act(async () => { documentVisibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')) })
    expect(fixture.list).toHaveBeenCalledTimes(3)
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, visible: false })))
    expect(fixture.listeners.size).toBe(0)
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(fixture.list).toHaveBeenCalledTimes(3)
    await act(async () => latest.refreshHeartbeats())
    expect(fixture.list).toHaveBeenCalledTimes(4)
    expect(latest.heartbeats).toEqual([heartbeat])
  })

  it('serializes overlapping refreshes into one trailing fresh read and rejects superseded results', async () => {
    const fixture = bridgeFixture()
    const old = deferred<NativeHeartbeatRecord[]>()
    const fresh = deferred<NativeHeartbeatRecord[]>()
    fixture.list.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge })))
    let manual!: Promise<void>
    act(() => { manual = latest.refreshHeartbeats(); fixture.emit('heartbeats_changed') })
    expect(fixture.list).toHaveBeenCalledTimes(1)
    await act(async () => old.resolve([{ ...heartbeat, id: 'stale' }]))
    expect(fixture.list).toHaveBeenCalledTimes(2)
    expect(latest.heartbeats).toEqual([])
    await act(async () => { fresh.resolve([{ ...heartbeat, id: 'fresh' }]); await manual })
    expect(latest.heartbeats.map((item) => item.id)).toEqual(['fresh'])
    expect(fixture.list).toHaveBeenCalledTimes(2)
  })

  it('ignores responses and errors from a replaced bridge and clears records outside Prime', async () => {
    const old = bridgeFixture()
    const next = bridgeFixture()
    const pending = deferred<NativeHeartbeatRecord[]>()
    old.list.mockImplementationOnce(() => pending.promise)
    const reportError = vi.fn()
    await act(async () => root!.render(createElement(Probe, { bridge: old.bridge, reportError })))
    await act(async () => root!.render(createElement(Probe, { bridge: next.bridge, reportError })))
    await act(async () => pending.reject(new Error('old bridge failed')))
    expect(reportError).not.toHaveBeenCalled()
    expect(latest.heartbeats).toEqual([heartbeat])
    await act(async () => root!.render(createElement(Probe, { bridge: next.bridge, harness: 'omp', reportError })))
    expect(latest.heartbeats).toEqual([])
    expect(next.listeners.size).toBe(0)
  })

  it('uses the latest error callback without restarting its subscription and survives a failed read', async () => {
    const fixture = bridgeFixture()
    const pending = deferred<NativeHeartbeatRecord[]>()
    fixture.list.mockImplementationOnce(() => pending.promise)
    const first = vi.fn()
    const next = vi.fn()
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, reportError: first })))
    const refresh = latest.refreshHeartbeats
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, reportError: next })))
    expect(latest.refreshHeartbeats).toBe(refresh)
    expect(fixture.onEvent).toHaveBeenCalledOnce()
    await act(async () => pending.reject(new Error('current bridge failed')))
    expect(first).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()
    await act(async () => latest.refreshHeartbeats())
    expect(latest.heartbeats).toEqual([heartbeat])
  })

  it('removes subscriptions and timers on unmount and ignores its pending failure', async () => {
    vi.useFakeTimers()
    const fixture = bridgeFixture()
    const pending = deferred<NativeHeartbeatRecord[]>()
    fixture.list.mockImplementationOnce(() => pending.promise)
    const reportError = vi.fn()
    await act(async () => root!.render(createElement(Probe, { bridge: fixture.bridge, reportError })))
    act(() => { root!.unmount(); root = undefined })
    await act(async () => { pending.reject(new Error('unmounted')); await vi.advanceTimersByTimeAsync(60_000) })
    expect(reportError).not.toHaveBeenCalled()
    expect(fixture.listeners.size).toBe(0)
    expect(fixture.list).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
