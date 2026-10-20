// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, PrimeImplementation, PrimeModelCatalog, PrimeWorkApi, ProjectRecord } from '../../src/types/api'

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

const unsubscribe = () => () => undefined
let container: HTMLDivElement
let root: Root

function bridgeFor(appMeta: AppMeta): PrimeWorkApi {
  const settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' as const }
  return {
    app: {
      getMeta: vi.fn(async () => appMeta), refreshHarnesses: vi.fn(async () => ({ meta: appMeta, settings })),
      setTitleBarTheme: vi.fn(async () => true), onOpenSettings: vi.fn(unsubscribe), onHarnessesChanged: vi.fn(unsubscribe),
    },
    updates: { getState: vi.fn(async () => ({ phase: 'idle' as const })), onChanged: vi.fn(unsubscribe) },
    projects: { list: vi.fn(async () => [project]), listCheckouts: vi.fn(async () => null), touch: vi.fn(async () => true) },
    sessions: { list: vi.fn(async () => []), onChanged: vi.fn(unsubscribe) },
    agent: { list: vi.fn(async () => []), onEvent: vi.fn(unsubscribe) },
    pets: { list: vi.fn(async () => []) },
    providers: { catalog: vi.fn(async () => catalog), onAuthEvent: vi.fn(unsubscribe) },
    plugins: { list: vi.fn(async () => ({ skills: [], warnings: [] })) },
    browser: { state: vi.fn(async () => ({ tabs: [] })), onChanged: vi.fn(unsubscribe), onPointer: vi.fn(unsubscribe), onActivity: vi.fn(unsubscribe) },
    heartbeats: { list: vi.fn(async () => []) },
    schedules: { list: vi.fn(async () => []), onChanged: vi.fn(unsubscribe) },
    settings: { get: vi.fn(async () => settings), update: vi.fn(async (patch) => ({ ...settings, ...patch })) },
    git: { status: vi.fn(async () => ({ isRepo: false, files: [] })) },
  } as unknown as PrimeWorkApi
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

async function renderComposer(implementation: PrimeImplementation | undefined): Promise<HTMLElement> {
  Object.defineProperty(window, 'prime', { configurable: true, value: bridgeFor(meta(implementation)) })
  await act(async () => root.render(<App />))
  const started = Date.now()
  while (Date.now() - started < 4_000) {
    const composer = container.querySelector<HTMLElement>('.composer')
    if (composer?.textContent?.includes('GPT-5.6')) return composer
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)) })
  }
  throw new Error('The composer never showed the catalog model')
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
