// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHarnessRefresh } from '../../src/hooks/useHarnessRefresh'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, AppSettings, HarnessId, PrimeWorkApi } from '../../src/types/api'

const meta = (primePath: string | null): AppMeta => ({
  version: '1', platform: 'linux', homeDir: '/home/you',
  harnesses: { prime: { path: primePath, version: primePath ? '0.10.0' : null }, omp: { path: null, version: null }, pi: { path: null, version: null } },
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function signalBridge() {
  let signal: (() => void) | undefined
  const unsubscribe = vi.fn()
  const onHarnessesChanged = vi.fn((callback: () => void) => { signal = callback; return unsubscribe })
  const bridge = { app: { onHarnessesChanged } } as unknown as PrimeWorkApi
  return { bridge, unsubscribe, onHarnessesChanged, signal: () => act(async () => { signal?.() }) }
}

async function renderRefresh(
  result: { meta: AppMeta; settings: AppSettings },
  activeHarness: HarnessId = 'prime',
  { bridge = null, refreshHarnesses = vi.fn(async () => result) }: { bridge?: PrimeWorkApi | null; refreshHarnesses?: () => Promise<{ meta: AppMeta; settings: AppSettings }> } = {},
) {
  const reportError = vi.fn()
  // Settings' transaction runs the operation it is given; the generic signature does not survive vi.fn.
  const reconcileExternalSettings = vi.fn((operation: () => Promise<unknown>) => operation())
  const refreshProviders = vi.fn(async () => undefined)
  let refresh: (() => Promise<void>) | undefined
  function Probe() {
    refresh = useHarnessRefresh({ bridge, activeHarness, refreshHarnesses, reconcileExternalSettings: reconcileExternalSettings as never, refreshProviders, reportError })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  return { refresh: () => act(async () => { await refresh?.() }), refreshHarnesses, reconcileExternalSettings, refreshProviders, reportError }
}

describe('harness refresh', () => {
  it('re-detects harnesses inside the settings transaction and reloads the active catalog', async () => {
    const view = await renderRefresh({ meta: meta('/bin/prime-agent'), settings: { ...DEFAULT_SETTINGS, activeHarness: 'prime' } })

    await view.refresh()

    expect(view.reconcileExternalSettings).toHaveBeenCalledExactlyOnceWith(view.refreshHarnesses)
    expect(view.refreshHarnesses).toHaveBeenCalledOnce()
    expect(view.refreshProviders).toHaveBeenCalledExactlyOnceWith(true)
  })

  it.each([
    ['the active harness is no longer installed', meta(null), 'prime'],
    ['the main process selected another harness', meta('/bin/prime-agent'), 'pi'],
  ] as const)('leaves the catalog alone when %s', async (_case, nextMeta, nextHarness) => {
    const view = await renderRefresh({ meta: nextMeta, settings: { ...DEFAULT_SETTINGS, activeHarness: nextHarness } })

    await view.refresh()

    expect(view.refreshHarnesses).toHaveBeenCalledOnce()
    expect(view.refreshProviders).not.toHaveBeenCalled()
  })

  it('reruns the same refresh when the main process re-detects the harnesses, until unmount', async () => {
    const main = signalBridge()
    const view = await renderRefresh({ meta: meta('/bin/prime-agent'), settings: { ...DEFAULT_SETTINGS, activeHarness: 'prime' } }, 'prime', { bridge: main.bridge })
    expect(view.refreshHarnesses).not.toHaveBeenCalled()

    await main.signal()

    expect(view.reconcileExternalSettings).toHaveBeenCalledExactlyOnceWith(view.refreshHarnesses)
    expect(view.refreshProviders).toHaveBeenCalledExactlyOnceWith(true)
    await act(async () => root.unmount())
    expect(main.unsubscribe).toHaveBeenCalledOnce()
    root = createRoot(container)
  })

  it('reports a refresh the main process asked for that fails', async () => {
    const main = signalBridge()
    const failure = new Error('discovery failed')
    const view = await renderRefresh({ meta: meta(null), settings: DEFAULT_SETTINGS }, 'prime', { bridge: main.bridge, refreshHarnesses: vi.fn(async () => { throw failure }) })

    await main.signal()

    expect(view.reportError).toHaveBeenCalledExactlyOnceWith(failure)
  })
})
