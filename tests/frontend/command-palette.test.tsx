// @vitest-environment jsdom
/// <reference types="vite/client" />

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessId } from '../../src/types/api'
import { HARNESS_SHORT_NAMES } from '../../src/lib/harness'
import App from '../../src/App'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const harnessState = vi.hoisted(() => ({ activeHarness: 'prime' as HarnessId }))

vi.mock('../../src/hooks/useAppSettings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/hooks/useAppSettings')>()
  return {
    ...actual,
    useAppSettings(options: Parameters<typeof actual.useAppSettings>[0]) {
      const state = actual.useAppSettings(options)
      return { ...state, settings: { ...state.settings, activeHarness: harnessState.activeHarness } }
    },
  }
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: (id: number) => window.clearTimeout(id),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function waitFor<T>(read: () => T | null | undefined, timeout = 4_000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 30)) })
  }
  throw new Error(`Timed out waiting for the command palette test condition after ${timeout}ms`)
}

async function openPalette(): Promise<HTMLElement> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  })
  return waitFor(() => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]'))
}

async function search(input: HTMLInputElement, query: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function commandOptions(dialog: HTMLElement): HTMLButtonElement[] {
  return [...dialog.querySelectorAll<HTMLButtonElement>('#command-results [role="option"]')]
}

const expectedOrder = [
  'New session',
  'Open Projects',
  'Open Activity',
  'Open Scheduled',
  'Open Capabilities',
  'Toggle browser',
  'Toggle terminal',
  'Toggle sidebar',
  'Open Settings',
]

describe.each<HarnessId>(['prime', 'omp', 'pi'])('command palette for %s', (harness) => {
  it('keeps Scheduled searchable and activatable by keyboard and pointer', async () => {
    harnessState.activeHarness = harness
    await act(async () => { root.render(<App />) })

    let dialog = await openPalette()
    let input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!
    let options = commandOptions(dialog)
    await waitFor(() => document.activeElement === input ? input : null)
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(expectedOrder)
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    await search(input, 'scheduled')
    options = commandOptions(dialog)
    expect(options.map((option) => option.querySelector('strong')?.textContent)).toEqual(['Open Scheduled'])
    expect(options[0].getAttribute('aria-selected')).toBe('true')

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    expect(document.body.querySelector('[role="dialog"][aria-label="Command palette"]')).toBeNull()
    await waitFor(() => [...document.body.querySelectorAll('h1')].find((heading) => heading.textContent === 'Scheduled'))
    expect(document.body.textContent).toContain(`Unattended ${HARNESS_SHORT_NAMES[harness]} work`)

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.sidebar__primary button[title="Projects"]')!.click()
    })
    await waitFor(() => [...document.body.querySelectorAll('h1')].find((heading) => heading.textContent === 'Projects'))

    dialog = await openPalette()
    input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!
    await waitFor(() => document.activeElement === input ? input : null)
    const scheduled = commandOptions(dialog).find((option) => option.textContent?.includes('Open Scheduled'))!
    await act(async () => {
      scheduled.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(scheduled.getAttribute('aria-selected')).toBe('true')
    await act(async () => { scheduled.click() })
    expect(document.body.querySelector('[role="dialog"][aria-label="Command palette"]')).toBeNull()
    await waitFor(() => [...document.body.querySelectorAll('h1')].find((heading) => heading.textContent === 'Scheduled'))
    expect(document.body.textContent).toContain(`Unattended ${HARNESS_SHORT_NAMES[harness]} work`)
  })
})
