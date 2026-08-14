// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AgentSettings } from '../../src/pages/settings/AgentSettings'
import type { AppMeta, AppSettings, HarnessId, HarnessUpdateState, PrimeWorkApi } from '../../src/types/api'

const meta: AppMeta = {
  version: '0.1.6',
  platform: 'darwin',
  homeDir: '/Users/tester',
  harnesses: {
    prime: { path: null, version: null },
    omp: { path: null, version: null },
    pi: { path: '/usr/local/bin/pi', version: '0.82.1' },
  },
}

function updateStates(pi: HarnessUpdateState): Record<HarnessId, HarnessUpdateState> {
  return { prime: { phase: 'unsupported' }, omp: { phase: 'unsupported' }, pi }
}

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
  delete (window as { prime?: PrimeWorkApi }).prime
  vi.restoreAllMocks()
})

function installBridge(pi: HarnessUpdateState) {
  const harnessUpdates = {
    getState: vi.fn(async () => updateStates(pi)),
    check: vi.fn(async () => updateStates(pi)),
    update: vi.fn(async () => ({ phase: 'up-to-date', installedVersion: '0.84.1', latestVersion: '0.84.1' } satisfies HarnessUpdateState)),
    onChanged: vi.fn(() => () => undefined),
  }
  ;(window as { prime?: PrimeWorkApi }).prime = { harnessUpdates } as unknown as PrimeWorkApi
  return harnessUpdates
}

async function render(settings: AppSettings, onUpdate = vi.fn(), onRefreshHarnesses = vi.fn(async () => undefined)) {
  await act(async () => {
    root.render(<AgentSettings settings={settings} meta={meta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />)
  })
  return { onUpdate, onRefreshHarnesses }
}

function findButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(label))
}

describe('Harness update settings', () => {
  it('offers the update on the runtime card and runs it through the bridge', async () => {
    const bridge = installBridge({ phase: 'available', installedVersion: '0.82.1', latestVersion: '0.84.1' })
    const { onRefreshHarnesses } = await render(DEFAULT_SETTINGS)

    expect(container.textContent).toContain('v0.82.1')
    const updateButton = findButton('Update to v0.84.1')
    expect(updateButton).toBeDefined()
    await act(async () => { updateButton!.click() })
    expect(bridge.update).toHaveBeenCalledWith('pi')
    expect(onRefreshHarnesses).toHaveBeenCalled()
  })

  it('hides update state entirely while the setting is off and re-checks when toggled on', async () => {
    const bridge = installBridge({ phase: 'available', installedVersion: '0.82.1', latestVersion: '0.84.1' })
    const { onUpdate } = await render({ ...DEFAULT_SETTINGS, harnessUpdateChecks: false })

    expect(findButton('Update to v0.84.1')).toBeUndefined()
    const toggle = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label, .settings-row, .settings-toggle')?.textContent?.includes('Check for harness updates'))
    expect(toggle).toBeDefined()
    await act(async () => { toggle!.click() })
    expect(onUpdate).toHaveBeenCalledWith({ harnessUpdateChecks: true })
    expect(bridge.check).toHaveBeenCalledWith(true)
  })

  it('shows the bounded per-harness error state instead of an update button', async () => {
    installBridge({ phase: 'error', installedVersion: '0.82.1', message: 'The package registry answered 503' })
    await render(DEFAULT_SETTINGS)

    expect(findButton('Update to')).toBeUndefined()
    expect(container.textContent).toContain('The package registry answered 503')
  })
})
