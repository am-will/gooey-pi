// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AgentSettings } from '../../src/pages/settings/AgentSettings'
import type { AppMeta, AppSettings, HarnessChangelog, HarnessId, HarnessUpdateState, PrimeWorkApi } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) => (
    <div role="dialog" aria-label={title}>{children}<button type="button" onClick={onClose}>close-modal</button></div>
  ),
}))
vi.mock('../../src/components/MarkdownText', () => ({
  MarkdownText: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
}))

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

function installBridge(pi: HarnessUpdateState, options: { changelog?: HarnessChangelog | null; omp?: HarnessUpdateState } = {}) {
  const harnessUpdates = {
    getState: vi.fn(async () => ({ ...updateStates(pi), ...(options.omp ? { omp: options.omp } : {}) })),
    check: vi.fn(async () => ({ ...updateStates(pi), ...(options.omp ? { omp: options.omp } : {}) })),
    update: vi.fn(async () => ({ phase: 'up-to-date', installedVersion: '0.84.1', latestVersion: '0.84.1' } satisfies HarnessUpdateState)),
    changelog: vi.fn(async () => options.changelog ?? null),
    onChanged: vi.fn(() => () => undefined),
  }
  const app = { openExternal: vi.fn(async () => true) }
  ;(window as { prime?: PrimeWorkApi }).prime = { harnessUpdates, app } as unknown as PrimeWorkApi
  return { harnessUpdates, app }
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
    const { harnessUpdates } = installBridge(
      { phase: 'available', installedVersion: '0.82.1', latestVersion: '0.84.1' },
      { changelog: { markdown: '## [0.84.1]\n\n- New thing', toVersion: '0.84.1' } },
    )
    const { onRefreshHarnesses } = await render(DEFAULT_SETTINGS)

    expect(container.textContent).toContain('v0.82.1')
    const updateButton = findButton('Update to v0.84.1')
    expect(updateButton).toBeDefined()
    await act(async () => { updateButton!.click() })
    expect(harnessUpdates.update).toHaveBeenCalledWith('pi')
    expect(onRefreshHarnesses).toHaveBeenCalled()
    // A successful update opens What's new for the span that was just installed.
    expect(harnessUpdates.changelog).toHaveBeenCalledWith('pi', '0.82.1')
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('What’s new in Pi 0.84.1')
    expect(container.textContent).toContain('New thing')
  })

  it('hides update state entirely while the setting is off and re-checks when toggled on', async () => {
    const { harnessUpdates } = installBridge({ phase: 'available', installedVersion: '0.82.1', latestVersion: '0.84.1' })
    const { onUpdate } = await render({ ...DEFAULT_SETTINGS, harnessUpdateChecks: false })

    expect(findButton('Update to v0.84.1')).toBeUndefined()
    const toggle = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
      .find((input) => input.closest('label, .settings-row, .settings-toggle')?.textContent?.includes('Check for harness updates'))
    expect(toggle).toBeDefined()
    await act(async () => { toggle!.click() })
    expect(onUpdate).toHaveBeenCalledWith({ harnessUpdateChecks: true })
    expect(harnessUpdates.check).toHaveBeenCalledWith(true)
  })

  it('shows unseen release notes on demand and records them as seen on close', async () => {
    const { harnessUpdates } = installBridge(
      { phase: 'up-to-date', installedVersion: '0.82.1', latestVersion: '0.82.1' },
      { changelog: { markdown: '## [0.82.1]\n\n- Fresh install notes', toVersion: '0.82.1' } },
    )
    const { onUpdate } = await render(DEFAULT_SETTINGS)

    const whatsNewButton = findButton('What’s new')
    expect(whatsNewButton).toBeDefined()
    await act(async () => { whatsNewButton!.click() })
    // Nothing seen yet, so the request carries no since-version.
    expect(harnessUpdates.changelog).toHaveBeenCalledWith('pi', undefined)
    expect(container.textContent).toContain('Fresh install notes')

    await act(async () => { findButton('close-modal')!.click() })
    expect(onUpdate).toHaveBeenCalledWith({ lastSeenHarnessNotes: { ...DEFAULT_SETTINGS.lastSeenHarnessNotes, pi: '0.82.1' } })
  })

  it('hides the What’s new button once the installed version has been seen', async () => {
    installBridge({ phase: 'up-to-date', installedVersion: '0.82.1', latestVersion: '0.82.1' })
    await render({ ...DEFAULT_SETTINGS, lastSeenHarnessNotes: { prime: '', omp: '', pi: '0.82.1' } })
    expect(findButton('What’s new')).toBeUndefined()
  })

  it('offers omp updates with an external release-notes link', async () => {
    const { harnessUpdates, app } = installBridge(
      { phase: 'up-to-date', installedVersion: '0.84.1' },
      { omp: { phase: 'available', installedVersion: '17.0.2', latestVersion: '17.3.3' } },
    )
    await render(DEFAULT_SETTINGS)

    const releaseNotes = findButton('Release notes')
    expect(releaseNotes).toBeDefined()
    await act(async () => { releaseNotes!.click() })
    expect(app.openExternal).toHaveBeenCalledWith('https://github.com/can1357/oh-my-pi/releases')

    await act(async () => { findButton('Update to v17.3.3')!.click() })
    expect(harnessUpdates.update).toHaveBeenCalledWith('omp')
  })

  it('shows a checking indicator while the check is in flight', async () => {
    const { harnessUpdates } = installBridge({ phase: 'checking', installedVersion: '0.82.1' })
    await render(DEFAULT_SETTINGS)

    // Opening the section starts a (cached) check rather than showing stale state.
    expect(harnessUpdates.check).toHaveBeenCalledWith(false)
    expect(container.textContent).toContain('Checking for updates…')
    expect(findButton('Update to')).toBeUndefined()
  })

  it('shows the bounded per-harness error state instead of an update button', async () => {
    installBridge({ phase: 'error', installedVersion: '0.82.1', message: 'The package registry answered 503' })
    await render(DEFAULT_SETTINGS)

    expect(findButton('Update to')).toBeUndefined()
    expect(container.textContent).toContain('The package registry answered 503')
  })
})
