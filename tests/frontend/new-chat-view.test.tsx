// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppMeta, PrimeModelCatalog, PrimeModelDescriptor, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 0,
}
const started: SessionRecord = {
  id: 'started', harness: 'prime', filePath: '/sessions/started.jsonl', projectPath: '/project', title: 'Build the sidebar',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'running', depth: 0, unread: false,
}
const startedRuntime: RuntimeInfo = { runtimeId: 'started-runtime', harness: 'prime', cwd: '/project', sessionFile: started.filePath, isStreaming: false }
const model: PrimeModelDescriptor = {
  key: 'provider/model', provider: 'provider', id: 'model', name: 'Model', reasoning: false, input: ['text'],
  contextWindow: 1_000, maxTokens: 1_000, availableThinkingLevels: ['medium'], fastModeSupported: false, available: true,
}
const modelCatalog: PrimeModelCatalog = {
  primeVersion: 'test', refreshedAt: '2026-01-01T00:00:00.000Z', models: [model],
  providers: [{ id: 'provider', name: 'Provider', authMethod: 'api_key', configured: true, modelCount: 1, availableModelCount: 1, enabled: true }],
}
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

let container: HTMLDivElement
let root: Root

/** A desktop bridge whose harness writes the started session once its runtime runs. */
function installBridge(projects: ProjectRecord[]) {
  const settings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' as const }
  let catalog: SessionRecord[] = []
  let resolveStart!: (runtime: RuntimeInfo) => void
  const start = vi.fn(() => new Promise<RuntimeInfo>((resolve) => { resolveStart = resolve }))
  const bridge = {
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
      listFiles: vi.fn(async () => ({ entries: [], skipped: 0, truncated: false })),
      listCheckouts: vi.fn(async () => ({ strategy: 'worktree' as const, activePath: '/project', checkouts: [] })),
      touch: vi.fn(async () => true),
    },
    sessions: {
      list: vi.fn(async () => catalog),
      read: vi.fn(async () => []),
      followUp: vi.fn(async () => false),
      rename: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
    },
    agent: {
      start,
      command: vi.fn(async () => ({})),
      stop: vi.fn(async () => true),
      list: vi.fn(async () => []),
      onEvent: vi.fn(() => () => undefined),
    },
    pets: { list: vi.fn(async () => []), sprite: vi.fn(async () => null) },
    providers: {
      catalog: vi.fn(async () => modelCatalog),
      onAuthEvent: vi.fn(() => () => undefined),
    },
    plugins: { list: vi.fn(async () => ({ skills: [], warnings: [] })) },
    browser: {
      state: vi.fn(async () => ({ tabs: [] })),
      setPreviewContext: vi.fn(async () => true),
      onChanged: vi.fn(() => () => undefined),
      onPointer: vi.fn(() => () => undefined),
      onActivity: vi.fn(() => () => undefined),
    },
    heartbeats: { list: vi.fn(async () => []) },
    schedules: { list: vi.fn(async () => []), onChanged: vi.fn(() => () => undefined) },
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (patch) => Object.assign(settings, patch)),
    },
    git: { status: vi.fn(async () => ({ isRepo: false, files: [] })) },
  }
  Object.defineProperty(window, 'prime', { configurable: true, value: bridge as unknown as PrimeWorkApi })
  return {
    bridge,
    /** Starts the runtime, whose session file the catalog then lists. */
    startRuntime() {
      catalog = [started]
      resolveStart(startedRuntime)
    },
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) })
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })
  window.sessionStorage.clear()
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
  const startedAt = Date.now()
  while (Date.now() - startedAt < 4_000) {
    const value = read()
    if (value) return value
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)) })
  }
  throw new Error('Timed out waiting for the app')
}

/** Opens App on its new chat and sends the first prompt, returning the mounted transcript and composer input. */
async function sendFirstPrompt(prompt: string) {
  // Resolve the lazy transcript chunk up front so its Suspense boundary settles on mount.
  await import('../../src/components/Transcript')
  await act(async () => root.render(<App />))
  await waitFor(() => container.querySelector(`[aria-label="Model: ${model.name}"]`))
  const textarea = await waitFor(() => container.querySelector<HTMLTextAreaElement>('.conversation-pane textarea'))
  const transcript = await waitFor(() => container.querySelector('.conversation-pane .transcript'))
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, prompt)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click() })
  return { textarea, transcript }
}

describe('new chat view in App', () => {
  it('keeps the transcript and composer mounted when the new chat adopts its session', async () => {
    const harness = installBridge([project])
    const { textarea, transcript } = await sendFirstPrompt('Build the sidebar')
    await waitFor(() => harness.bridge.agent.start.mock.calls.length > 0)

    await act(async () => { harness.startRuntime() })
    await waitFor(() => container.querySelector('.session-row-wrap.is-selected'))

    expect(container.querySelector('.conversation-pane .transcript')).toBe(transcript)
    expect(container.querySelector('.conversation-pane textarea')).toBe(textarea)
    expect(transcript.textContent).toContain('Build the sidebar')
  })
})
