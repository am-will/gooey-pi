// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, PrimeWorkApi, ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project = (id: string, name: string, lastOpenedAt: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id,
  harness: 'prime',
  name,
  path: `/${id}`,
  folders: [`/${id}`],
  primaryFolder: `/${id}`,
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt,
  sessionCount: 0,
  ...overrides,
})

const projects = [
  project('zeta', 'Zeta', '2026-01-01T00:00:00.000Z'),
  project('alpha', 'Alpha', '2026-02-01T00:00:00.000Z'),
  project('inferred', 'Inferred', '2026-03-01T00:00:00.000Z', { inferred: true, readOnly: true }),
]

const meta: AppMeta = {
  version: 'test',
  platform: 'linux',
  homeDir: '/home/test',
  harnesses: {
    prime: { path: '/usr/bin/prime', version: 'test' },
    omp: { path: null, version: null },
    pi: { path: null, version: null },
  },
}

let settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' as const }
let bridge: PrimeWorkApi
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' }
  bridge = {
    app: {
      getMeta: vi.fn(async () => meta),
      refreshHarnesses: vi.fn(async () => ({ meta, settings })),
      openExternal: vi.fn(async () => true),
      revealPath: vi.fn(async () => true),
      popupMenu: vi.fn(async () => true),
      setTitleBarTheme: vi.fn(async () => true),
      onOpenSettings: vi.fn(() => () => undefined),
    },
    updates: {
      getState: vi.fn(async () => ({ phase: 'idle' as const })),
      check: vi.fn(async () => ({ phase: 'idle' as const })),
      downloadAndInstall: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
    },
    projects: {
      list: vi.fn(async () => projects),
      listFiles: vi.fn(async () => ({ entries: [], skipped: 0 })),
      listWorktrees: vi.fn(async () => []),
      openWorktree: vi.fn(async () => projects[0]),
      createWorktree: vi.fn(async () => projects[0]),
      add: vi.fn(async () => null),
      grantInferred: vi.fn(async () => projects[2]),
      remove: vi.fn(async () => true),
      touch: vi.fn(async () => true),
      setPinned: vi.fn(async () => true),
    },
    sessions: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => []),
      followUp: vi.fn(async () => true),
      rename: vi.fn(async () => true),
      archive: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
    },
    agent: {
      start: vi.fn(async () => undefined),
      command: vi.fn(async () => ({})),
      stop: vi.fn(async () => true),
      list: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
    },
    providers: {
      catalog: vi.fn(async () => ({ models: [], providers: [] })),
      saveApiKey: vi.fn(async () => true),
      logout: vi.fn(async () => true),
      setEnabled: vi.fn(async () => true),
      setDisabled: vi.fn(async () => true),
      setModelEnabled: vi.fn(async () => true),
      startOAuth: vi.fn(async () => undefined),
      respondOAuth: vi.fn(async () => true),
      cancelOAuth: vi.fn(async () => true),
      onAuthEvent: vi.fn(() => () => undefined),
    },
    plugins: {
      list: vi.fn(async () => ({ skills: [], warnings: [] })),
      install: vi.fn(async () => ({ ok: true, output: '' })),
      installExtension: vi.fn(async () => ({ ok: true, output: '' })),
      setMcpSupport: vi.fn(async () => true),
      connectMcp: vi.fn(async () => ({ ok: true })),
      setMcpEnabled: vi.fn(async () => true),
      mutateCapability: vi.fn(async () => true),
    },
    browser: {
      state: vi.fn(async () => ({ tabs: [] })),
      attachTab: vi.fn(async () => true),
      selectTab: vi.fn(async () => true),
      closeTab: vi.fn(async () => true),
      navigateTab: vi.fn(async () => true),
      setPreviewContext: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onPointer: vi.fn(() => () => undefined),
      onActivity: vi.fn(() => () => undefined),
    },
    heartbeats: {
      list: vi.fn(async () => []),
      manage: vi.fn(async () => true),
    },
    schedules: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      pause: vi.fn(async () => true),
      resume: vi.fn(async () => true),
      delete: vi.fn(async () => true),
      runNow: vi.fn(async () => true),
      preview: vi.fn(async (timing) => ({ timing, occurrences: [] })),
      onChanged: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (patch) => {
        settings = { ...settings, ...patch }
        return settings
      }),
      resetBrowserData: vi.fn(async () => true),
    },
    git: {
      status: vi.fn(async () => ({ isRepo: false, files: [] })),
      diff: vi.fn(async () => ''),
      restore: vi.fn(async () => true),
    },
  } as unknown as PrimeWorkApi
  Object.defineProperty(window, 'prime', { configurable: true, value: bridge })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Object.defineProperty(window, 'prime', { configurable: true, value: undefined })
  vi.restoreAllMocks()
})

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 4_000) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)) })
  }
  throw new Error('Timed out waiting for the app')
}

async function press(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('project ordering controls in App', () => {
  it('switches sidebar sorting persistently and pins projects while excluding inferred records', async () => {
    await act(async () => root.render(<App />))
    await waitFor(() => container.querySelector('.sidebar__section-heading'))

    expect([...container.querySelectorAll('.project-row__main')].map((button) => button.textContent)).toEqual(['Alpha', 'Zeta', 'Inferred'])
    await press(container.querySelector('[aria-label="Sort projects"]')!)
    await press([...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent?.includes('Alphabetical'))!)
    expect(bridge.settings.update).toHaveBeenCalledWith({ projectSortMode: 'alphabetical' })

    await press(container.querySelector('[aria-label="Sort projects"]')!)
    expect([...container.querySelectorAll('.project-row__main')].map((button) => button.textContent)).toEqual(['Alpha', 'Inferred', 'Zeta'])
    await act(async () => {
      container.querySelector('.project-row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
    })
    const pin = [...container.querySelectorAll('[aria-label^="Project options"] button')].find((button) => button.textContent?.includes('Pin project'))
    expect(pin).toBeDefined()
    await press(pin!)
    expect(bridge.projects.setPinned).toHaveBeenCalledWith('alpha', true, 'prime')
    expect([...container.querySelectorAll('[aria-label^="Project options"] button')].some((button) => button.textContent?.includes('Pin project'))).toBe(false)
  })
})
