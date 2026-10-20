// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHarnessRefresh } from '../../src/hooks/useHarnessRefresh'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, AppSettings, HarnessId } from '../../src/types/api'

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

async function renderRefresh(result: { meta: AppMeta; settings: AppSettings }, activeHarness: HarnessId = 'prime') {
  const refreshHarnesses = vi.fn(async () => result)
  // Settings' transaction runs the operation it is given; the generic signature does not survive vi.fn.
  const reconcileExternalSettings = vi.fn((operation: () => Promise<unknown>) => operation())
  const refreshProviders = vi.fn(async () => undefined)
  let refresh: (() => Promise<void>) | undefined
  function Probe() {
    refresh = useHarnessRefresh({ activeHarness, refreshHarnesses, reconcileExternalSettings: reconcileExternalSettings as never, refreshProviders })
    return null
  }
  await act(async () => { root.render(<Probe />) })
  return { refresh: () => act(async () => { await refresh?.() }), refreshHarnesses, reconcileExternalSettings, refreshProviders }
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
})
