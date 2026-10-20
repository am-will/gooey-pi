// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { primeCapabilityRecordAvailability } from '../../src/lib/prime-compat'
import type { AppMeta, PrimeImplementation, PrimeModelCatalog, PrimeWorkApi, ProjectRecord, SkillRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 0,
}

// A catalog row that claims fast mode, as the TypeScript catalog still in the
// renderer does right after Prime is reclassified as Rust.
const catalog: PrimeModelCatalog = {
  primeVersion: '0.10.0',
  refreshedAt: '2026-10-20T00:00:00.000Z',
  models: [{
    key: 'openai/gpt-5.6', provider: 'openai', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, input: ['text'],
    contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: true, available: true,
  }],
  providers: [{ id: 'openai', name: 'OpenAI', authMethod: 'api_key', configured: true, authSource: 'stored', modelCount: 1, availableModelCount: 1, enabled: true }],
}

const meta = (implementation: PrimeImplementation | undefined): AppMeta => ({
  version: 'test', platform: 'linux', homeDir: '/home/test',
  harnesses: { prime: { path: '/usr/bin/prime-agent', version: '0.10.0', implementation }, omp: { path: null, version: null }, pi: { path: null, version: null } },
})

/** Browser control as the main process lists it: its availability follows the detected build. */
function browserControl(implementation: PrimeImplementation | undefined): SkillRecord {
  const record = { id: 'prime-work-browser', name: 'Browser control', description: 'Drive the browser panel.', kind: 'extension', location: 'system', enabled: true } as const
  return { ...record, availability: primeCapabilityRecordAvailability(record, implementation) }
}

const unsubscribe = () => () => undefined
let container: HTMLDivElement
let root: Root

/** A bridge whose Prime classification is read from `detected` on every call, like the main process's discovery. */
function bridgeFor(detected: () => PrimeImplementation | undefined) {
  const settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' as const }
  const harnessesChanged = new Set<() => void>()
  const bridge = {
    app: {
      getMeta: vi.fn(async () => meta(detected())), refreshHarnesses: vi.fn(async () => ({ meta: meta(detected()), settings })),
      setTitleBarTheme: vi.fn(async () => true), onOpenSettings: vi.fn(unsubscribe),
      onHarnessesChanged: vi.fn((callback: () => void) => { harnessesChanged.add(callback); return () => { harnessesChanged.delete(callback) } }),
    },
    updates: { getState: vi.fn(async () => ({ phase: 'idle' as const })), onChanged: vi.fn(unsubscribe) },
    projects: { list: vi.fn(async () => [project]), listCheckouts: vi.fn(async () => null), touch: vi.fn(async () => true) },
    sessions: { list: vi.fn(async () => []), onChanged: vi.fn(unsubscribe) },
    agent: { list: vi.fn(async () => []), onEvent: vi.fn(unsubscribe) },
    pets: { list: vi.fn(async () => []) },
    providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn(unsubscribe) },
    plugins: { list: vi.fn(async () => ({ skills: [browserControl(detected())], warnings: [] })) },
    browser: { state: vi.fn(async () => ({ tabs: [] })), onChanged: vi.fn(unsubscribe), onPointer: vi.fn(unsubscribe), onActivity: vi.fn(unsubscribe) },
    heartbeats: { list: vi.fn(async () => []) },
    schedules: { list: vi.fn(async () => []), onChanged: vi.fn(unsubscribe) },
    settings: { get: vi.fn(async () => settings), update: vi.fn(async (patch) => ({ ...settings, ...patch })) },
    git: { status: vi.fn(async () => ({ isRepo: false, files: [] })) },
  }
  return {
    bridge,
    /** What the main process sends after a start recovery re-detected the harnesses. */
    signalHarnessesChanged: () => act(async () => { for (const callback of harnessesChanged) callback() }),
  }
}

beforeEach(() => {
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

async function waitFor<T>(read: () => T | null | undefined, condition: string): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 4_000) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)) })
  }
  throw new Error(`Timed out waiting until ${condition}`)
}

async function renderApp(detected: () => PrimeImplementation | undefined) {
  const main = bridgeFor(detected)
  Object.defineProperty(window, 'prime', { configurable: true, value: main.bridge as unknown as PrimeWorkApi })
  await act(async () => root.render(<App />))
  return main
}

async function renderComposer(implementation: PrimeImplementation | undefined): Promise<HTMLElement> {
  await renderApp(() => implementation)
  return waitFor(() => {
    const composer = container.querySelector<HTMLElement>('.composer')
    return composer?.textContent?.includes('GPT-5.6') ? composer : null
  }, 'the composer shows the catalog model')
}

async function navigate(label: string) {
  const button = await waitFor(() => container.querySelector<HTMLButtonElement>(`.sidebar__primary button[title="${label}"]`), `the ${label} button renders`)
  await act(async () => { button.click() })
}

describe('composer fast toggle before a runtime exists', () => {
  it('is not offered on Rust Prime even when a catalog row claims fast mode', async () => {
    const composer = await renderComposer('rust')

    expect(composer.querySelector('.fast-mode-toggle')).toBeNull()
  })

  it.each([['typescript'], [undefined]] as const)('stays available on %s Prime', async (implementation) => {
    const composer = await renderComposer(implementation)

    expect(composer.querySelector<HTMLButtonElement>('.fast-mode-toggle')?.disabled).toBe(false)
  })
})

describe('a start recovery that reclassifies Prime as Rust', () => {
  it('reloads the Capabilities records, whose availability follows the detected build', async () => {
    let implementation: PrimeImplementation = 'typescript'
    const main = await renderApp(() => implementation)
    await navigate('Capabilities')
    await waitFor(() => container.querySelector('[aria-label="Disable Browser control"]'), 'Browser control is offered')
    const listed = main.bridge.plugins.list.mock.calls.length

    implementation = 'rust'
    await main.signalHarnessesChanged()

    await waitFor(() => container.querySelector('[aria-label="Unavailable Browser control"]'), 'Browser control is labelled unavailable')
    expect(main.bridge.app.refreshHarnesses).toHaveBeenCalledOnce()
    expect(main.bridge.plugins.list).toHaveBeenCalledTimes(listed + 1)
    expect(main.bridge.plugins.list).toHaveBeenLastCalledWith('/project', 'prime')
  })
})
