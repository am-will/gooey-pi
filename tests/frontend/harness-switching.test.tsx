// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from '../../src/components/Sidebar'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { useBootstrap } from '../../src/hooks/useBootstrap'
import { useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AgentSettings } from '../../src/pages/settings/AgentSettings'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import { SettingsPage } from '../../src/pages/SettingsPage'
import type { AppMeta, AppSettings, HarnessId, PrimeModelCatalog, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const primeProject: ProjectRecord = {
  id: 'prime-project', harness: 'prime', name: 'Prime project', path: '/prime', folders: ['/prime'], primaryFolder: '/prime', pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const primeSession: SessionRecord = {
  id: 'prime-session', harness: 'prime', projectPath: '/prime', filePath: '/prime-sessions/current.jsonl', title: 'Prime session',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const ompProject: ProjectRecord = { ...primeProject, id: 'omp-project', harness: 'omp', name: 'OMP project', path: '/omp', folders: ['/omp'], primaryFolder: '/omp' }
const ompSession: SessionRecord = { ...primeSession, id: 'omp-session', harness: 'omp', projectPath: '/omp', filePath: '/omp-sessions/current.jsonl', title: 'OMP session' }
const piProject: ProjectRecord = { ...primeProject, id: 'pi-project', harness: 'pi', name: 'Pi project', path: '/pi', folders: ['/pi'], primaryFolder: '/pi' }
const piSession: SessionRecord = { ...primeSession, id: 'pi-session', harness: 'pi', projectPath: '/pi', filePath: '/pi-sessions/current.jsonl', title: 'Pi session' }
const primeRuntime: RuntimeInfo = { runtimeId: 'prime-runtime', harness: 'prime', cwd: '/prime', sessionFile: primeSession.filePath, isStreaming: false }
const ompRuntime: RuntimeInfo = { runtimeId: 'omp-runtime', harness: 'omp', cwd: '/omp', sessionFile: ompSession.filePath, isStreaming: false }
const piRuntime: RuntimeInfo = { runtimeId: 'pi-runtime', harness: 'pi', cwd: '/pi', sessionFile: piSession.filePath, isStreaming: false }

const meta: AppMeta = {
  version: '1', platform: 'darwin', homeDir: '/Users/you',
  harnesses: { prime: { path: '/usr/local/bin/prime-agent', version: '0.7.0' }, omp: { path: null, version: null }, pi: { path: null, version: null } },
}
const allDetectedMeta: AppMeta = {
  ...meta,
  harnesses: {
    prime: meta.harnesses.prime,
    omp: { path: '/usr/local/bin/omp', version: '17.2.11' },
    pi: { path: '/usr/local/bin/pi', version: '0.84.1' },
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function Probe({ children }: { children?: ReactNode }) { return <>{children}</> }

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('bootstrap harness switching', () => {
  function makeBridge() {
    const projectsList = vi.fn(async (harness?: HarnessId) => harness === 'omp' ? [ompProject] : harness === 'pi' ? [piProject] : [primeProject])
    const sessionsList = vi.fn(async (_projectPath?: string, _includeArchived?: boolean, harness?: HarnessId) => harness === 'omp' ? [ompSession] : harness === 'pi' ? [piSession] : [primeSession])
    const agentList = vi.fn(async () => [primeRuntime, ompRuntime, piRuntime])
    const bridge = {
      projects: { list: projectsList },
      sessions: { list: sessionsList, onChanged: () => () => undefined },
      agent: { list: agentList },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    return { bridge, projectsList, sessionsList, agentList }
  }

  it('waits for persisted settings before querying the selected harness', async () => {
    const { bridge, projectsList, sessionsList, agentList } = makeBridge()
    const workspace = makeWorkspace()
    const props = {
      setProjects: vi.fn(),
      setSessions: vi.fn(),
      setSchedules: vi.fn(),
      setScheduleError: vi.fn(),
      runtimeSessionsRef: { current: new Map<string, string>() },
      workspaceRef: workspace.workspaceRef,
      activateWorkspace: workspace.activateWorkspace,
      attachRuntime: workspace.attachRuntime,
      reportError: vi.fn(),
    }
    function BootstrapProbe({ ready }: { ready: boolean }) {
      useBootstrap({ bridge, ready, harness: 'pi', ...props })
      return <Probe />
    }

    await act(async () => { root.render(<BootstrapProbe ready={false} />); await Promise.resolve() })
    expect(projectsList).not.toHaveBeenCalled()
    expect(sessionsList).not.toHaveBeenCalled()
    expect(agentList).not.toHaveBeenCalled()

    await act(async () => { root.render(<BootstrapProbe ready />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenCalledWith('pi')
    expect(sessionsList).toHaveBeenCalledWith(undefined, true, 'pi')
    expect(agentList).toHaveBeenCalledTimes(1)
  })

  function makeWorkspace() {
    const workspaceRef = { current: { generation: 0 } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string } }
    const activated: Array<{ project?: ProjectRecord; session?: SessionRecord }> = []
    const attached: RuntimeInfo[] = []
    const activateWorkspace = (project?: ProjectRecord, session?: SessionRecord) => {
      const generation = workspaceRef.current.generation + 1
      workspaceRef.current = { generation, project, session, cwd: project?.primaryFolder, sessionFile: session?.filePath }
      activated.push({ project, session })
      return generation
    }
    const attachRuntime = (runtime?: RuntimeInfo) => { if (runtime) attached.push(runtime) }
    return { workspaceRef, activated, attached, activateWorkspace, attachRuntime }
  }

  it('re-fetches per harness, resets the workspace under a new generation, and attaches only that harness runtime', async () => {
    const { bridge, projectsList, sessionsList } = makeBridge()
    const workspace = makeWorkspace()
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const onHarnessSwitch = vi.fn()
    const reportError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    function BootstrapProbe({ harness }: { harness: HarnessId }) {
      useBootstrap({
        bridge, harness,
        setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
        activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
        onHarnessSwitch, reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe harness="prime" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('prime')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'prime')
    expect(workspace.activated).toEqual([{ project: primeProject, session: primeSession }])
    expect(onHarnessSwitch).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime])

    await act(async () => { root.render(<BootstrapProbe harness="omp" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('omp')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'omp')
    expect(onHarnessSwitch).toHaveBeenCalledTimes(1)
    // The switch clears the visible catalog before the new harness loads.
    expect(setProjects).toHaveBeenCalledWith([])
    expect(setSessions).toHaveBeenCalledWith([])
    // Generation-bumping reset first, then the new harness's startup workspace.
    expect(workspace.activated).toEqual([
      { project: primeProject, session: primeSession },
      { project: undefined, session: undefined },
      { project: ompProject, session: ompSession },
    ])
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime, ompRuntime])

    await act(async () => { root.render(<BootstrapProbe harness="pi" />); await Promise.resolve(); await Promise.resolve() })
    expect(projectsList).toHaveBeenLastCalledWith('pi')
    expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'pi')
    expect(onHarnessSwitch).toHaveBeenCalledTimes(2)
    expect(workspace.activated).toEqual([
      { project: primeProject, session: primeSession },
      { project: undefined, session: undefined },
      { project: ompProject, session: ompSession },
      { project: undefined, session: undefined },
      { project: piProject, session: piSession },
    ])
    await act(async () => { await Promise.resolve() })
    expect(workspace.attached).toEqual([primeRuntime, ompRuntime, piRuntime])
  })

  it('skips the startup activation when the user changes the workspace mid-fetch', async () => {
    const projects = deferred<ProjectRecord[]>()
    const bridge = {
      projects: { list: vi.fn((harness?: HarnessId) => harness === 'omp' ? projects.promise : Promise.resolve([primeProject])) },
      sessions: { list: async () => [ompSession], onChanged: () => () => undefined },
      agent: { list: async () => [] },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspace = makeWorkspace()
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const reportError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    function BootstrapProbe({ harness }: { harness: HarnessId }) {
      useBootstrap({
        bridge, harness,
        setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
        activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
        reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe harness="prime" />); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { root.render(<BootstrapProbe harness="omp" />) })
    const activationsBeforeResolve = workspace.activated.length
    // The user activates something else while the omp catalog is in flight.
    act(() => { workspace.activateWorkspace(ompProject) })
    await act(async () => { projects.resolve([ompProject]); await projects.promise; await Promise.resolve(); await Promise.resolve() })
    expect(workspace.activated.length).toBe(activationsBeforeResolve + 1)
  })

  it('only refreshes the session catalog for matching sessions:changed events', async () => {
    let onChangedCallback: ((event: { filePath?: string; harness?: HarnessId }) => void) | undefined
    const sessionsList = vi.fn(async (_p?: string, _a?: boolean, harness?: HarnessId) => harness === 'omp' ? [ompSession] : [primeSession])
    const bridge = {
      projects: { list: async () => [ompProject] },
      sessions: {
        list: sessionsList,
        onChanged: (callback: typeof onChangedCallback) => { onChangedCallback = callback; return () => undefined },
      },
      agent: { list: async () => [] },
      app: { getMeta: async () => meta },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspace = makeWorkspace()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const setProjects = vi.fn()
      const setSessions = vi.fn()
      const setSchedules = vi.fn()
      const setScheduleError = vi.fn()
      const reportError = vi.fn()
      const runtimeSessionsRef = { current: new Map<string, string>() }
      function BootstrapProbe() {
        useBootstrap({
          bridge, harness: 'omp',
          setProjects, setSessions, setSchedules, setScheduleError,
          runtimeSessionsRef, workspaceRef: workspace.workspaceRef,
          activateWorkspace: workspace.activateWorkspace, attachRuntime: workspace.attachRuntime,
          reportError,
        })
        return <Probe />
      }
      await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })
      const listCalls = sessionsList.mock.calls.length
      // Prime catalog change (and legacy events without a harness) are ignored.
      act(() => {
        onChangedCallback?.({ filePath: primeSession.filePath, harness: 'prime' })
        onChangedCallback?.({ filePath: primeSession.filePath })
      })
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve() })
      expect(sessionsList.mock.calls.length).toBe(listCalls)

      act(() => { onChangedCallback?.({ filePath: ompSession.filePath, harness: 'omp' }) })
      await act(async () => { vi.advanceTimersByTime(200); await Promise.resolve() })
      expect(sessionsList.mock.calls.length).toBe(listCalls + 1)
      expect(sessionsList).toHaveBeenLastCalledWith(undefined, true, 'omp')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('inactive harness event isolation', () => {
  it('keeps events from the other harness runtime away from visible state', async () => {
    let handler!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
    const bridge = {
      agent: { onEvent: (callback: typeof handler) => { handler = callback; return () => undefined } },
    } as unknown as PrimeWorkApi
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const queueAgentEvent = vi.fn()
    const reconcileTranscriptForEvent = vi.fn()
    // The workspace shows the OMP harness; a prime runtime keeps streaming in
    // the background with its session file still registered.
    const runtimeSessionsRef = { current: new Map([[primeRuntime.runtimeId, primeSession.filePath]]) }
    function AgentEventsProbe() {
      useAgentEvents({
        bridge,
        runtimeIdRef: { current: ompRuntime.runtimeId },
        runtimeSessionsRef,
        runtimeOwnerRef: { current: { runtimeId: ompRuntime.runtimeId, generation: 1 } },
        workspaceRef: { current: { generation: 1, sessionFile: ompSession.filePath, cwd: '/omp' } },
        setSessions,
        setRuntime,
        queueAgentEvent,
        reconcileTranscriptForEvent,
        showExtensionUi: vi.fn(),
        clearExtensionUi: vi.fn(),
        refreshGit: vi.fn(async () => undefined),
        refreshGitOnTerminalEvent: true,
        activeSessionVisible: true,
      })
      return <Probe />
    }
    await act(async () => { root.render(<AgentEventsProbe />) })
    act(() => {
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'agent_start' } })
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } } })
      handler({ runtimeId: primeRuntime.runtimeId, event: { type: 'agent_end' } })
    })
    // Lifecycle updates only touch records whose filePath matches; the visible
    // OMP catalog has none, so the session list is unchanged.
    for (const [updater] of setSessions.mock.calls) {
      expect((updater as (sessions: SessionRecord[]) => SessionRecord[])([ompSession])).toEqual([ompSession])
    }
    expect(setRuntime).not.toHaveBeenCalled()
    expect(queueAgentEvent).not.toHaveBeenCalled()
    expect(reconcileTranscriptForEvent).not.toHaveBeenCalled()

    // The visible harness's own runtime still updates state.
    act(() => { handler({ runtimeId: ompRuntime.runtimeId, event: { type: 'agent_start' } }) })
    expect(setRuntime).toHaveBeenCalled()
    expect(queueAgentEvent).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar brand switcher', () => {
  const noop = () => undefined
  function renderSidebar(onSelectHarness: (harness: HarnessId) => void, activeHarness: HarnessId = 'prime', appMeta = meta) {
    return act(async () => {
      root.render(
        <Sidebar
          projects={[primeProject]}
          sessions={[primeSession]}
          activeView="session"
          activeHarness={activeHarness}
          harnesses={appMeta.harnesses}
          onSelectHarness={onSelectHarness}
          onSelectProject={noop}
          onSelectSession={noop}
          onNavigate={noop}
          onNewSession={noop}
          onAddProject={noop}
          onRemoveProject={noop}
          onClose={noop}
          onOpenPalette={noop}
          onRenameSession={async () => undefined}
          onArchiveSession={async () => undefined}
        />,
      )
    })
  }

  it('lists only harnesses with a detected executable', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness)

    const trigger = container.querySelector<HTMLButtonElement>('.brand-switcher__trigger')
    expect(trigger).not.toBeNull()
    expect(trigger!.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger!.getAttribute('aria-expanded')).toBe('false')
    expect(trigger!.textContent).toContain('Prime')

    await click(trigger!)
    const menu = container.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const options = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Prime Work'])
    expect(options[0].getAttribute('aria-checked')).toBe('true')

    await click(options[0])
    expect(onSelectHarness).not.toHaveBeenCalled()
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('switches to Pi from the brand switcher', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness, 'prime', allDetectedMeta)

    await click(container.querySelector('.brand-switcher__trigger')!)
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    await click(options[0])
    expect(onSelectHarness).toHaveBeenCalledWith('pi')
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('closes on Escape without selecting and shows shared navigation for OMP', async () => {
    const onSelectHarness = vi.fn()
    await renderSidebar(onSelectHarness, 'omp', allDetectedMeta)

    expect([...container.querySelectorAll('nav.sidebar__primary button span')].map((item) => item.textContent)).toContain('Scheduled')
    expect(container.textContent).toContain('Capabilities')

    await click(container.querySelector('.brand-switcher__trigger')!)
    expect(container.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(onSelectHarness).not.toHaveBeenCalled()
  })
})

describe('provider catalog per harness', () => {
  const primeCatalog: PrimeModelCatalog = {
    primeVersion: '0.7.0', refreshedAt: '2026-08-06T00:00:00.000Z',
    models: [{ key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, input: ['text'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: true, available: true }],
    providers: [{ id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, modelCount: 1, availableModelCount: 1, enabled: true }],
  }
  const ompCatalog: PrimeModelCatalog = {
    primeVersion: '17.2.11', refreshedAt: '2026-08-06T00:00:00.000Z',
    models: [{ key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6', reasoning: true, input: ['text', 'image'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'medium', 'high'], fastModeSupported: false, available: true }],
    providers: [{ id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'external', configured: true, authLabel: 'Credentials managed by the omp CLI', modelCount: 1, availableModelCount: 1, enabled: true }],
  }

  it('waits for persisted settings before loading a provider catalog', async () => {
    const catalog = vi.fn(async () => primeCatalog)
    const bridge = {
      providers: { catalog, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    function CatalogProbe({ ready }: { ready: boolean }) {
      useProviderCatalog({ bridge, ready, harness: 'prime', runtime: null, syncRuntime: async () => undefined, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<CatalogProbe ready={false} />); await Promise.resolve() })
    expect(catalog).not.toHaveBeenCalled()
    await act(async () => { root.render(<CatalogProbe ready />); await Promise.resolve() })
    expect(catalog).toHaveBeenCalledWith(false, 'prime')
  })

  it('fetches per harness, caches catalogs, and resets the model selection on switch', async () => {
    const thirdFetch = deferred<PrimeModelCatalog>()
    const catalogMock = vi.fn()
      .mockResolvedValueOnce(primeCatalog)
      .mockResolvedValueOnce(ompCatalog)
      .mockImplementationOnce(() => thirdFetch.promise)
    const bridge = {
      providers: { catalog: catalogMock, onAuthEvent: vi.fn().mockReturnValue(() => undefined) },
    } as unknown as PrimeWorkApi
    let state!: ReturnType<typeof useProviderCatalog>
    const syncRuntime = async () => undefined
    const reportError = vi.fn()
    function CatalogProbe({ harness }: { harness: HarnessId }) {
      state = useProviderCatalog({ bridge, harness, runtime: null, syncRuntime, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<CatalogProbe harness="prime" />); await Promise.resolve() })
    expect(catalogMock).toHaveBeenNthCalledWith(1, false, 'prime')
    expect(state.catalog).toBe(primeCatalog)

    act(() => state.changeModel('openai-codex/gpt-5.6'))
    expect(state.model).toBe('openai-codex/gpt-5.6')

    await act(async () => { root.render(<CatalogProbe harness="omp" />); await Promise.resolve() })
    expect(catalogMock).toHaveBeenNthCalledWith(2, false, 'omp')
    expect(state.catalog).toBe(ompCatalog)
    expect(state.model).toBe('auto')
    expect(state.fast).toBe(false)

    // Switching back shows the cached prime catalog while the refresh hangs.
    await act(async () => { root.render(<CatalogProbe harness="prime" />) })
    expect(catalogMock).toHaveBeenNthCalledWith(3, false, 'prime')
    expect(state.catalog).toBe(primeCatalog)
  })
})

describe('harness settings surfaces', () => {
  it('follows a changed initial section while the settings page stays mounted', async () => {
    const noop = () => undefined
    const noopAsync = async () => undefined
    const renderSettings = (initialSection: 'general' | 'agent', initialSectionRequestId = 0) => (
      <SettingsPage
        settings={DEFAULT_SETTINGS}
        meta={meta}
        providerCatalog={null}
        agentConfig={null}
        voice={null}
        pets={null}
        initialSection={initialSection}
        initialSectionRequestId={initialSectionRequestId}
        onUpdate={noop}
        onResetBrowser={noop}
        onOpenDocs={noop}
        onRefreshProviders={noopAsync}
        onRefreshHarnesses={noopAsync}
        onSaveProviderApiKey={noopAsync}
        onLogoutProvider={noopAsync}
        onSetProviderEnabled={noopAsync}
        onSetAllProvidersEnabled={noopAsync}
        onSetAllProvidersDisabled={noopAsync}
        onSetModelEnabled={noopAsync}
        onStartProviderOAuth={noopAsync}
      />
    )

    await act(async () => { root.render(renderSettings('general')) })
    expect(container.querySelector('h1')?.textContent).toBe('General')
    await act(async () => { root.render(renderSettings('agent')); await Promise.resolve() })
    expect(container.querySelector('h1')?.textContent).toBe('Harness')
    expect(container.querySelector('.settings-nav .is-active')?.textContent).toContain('Harness')

    await click([...container.querySelectorAll<HTMLButtonElement>('.settings-nav button')].find((button) => button.textContent?.includes('General'))!)
    expect(container.querySelector('h1')?.textContent).toBe('General')
    await act(async () => { root.render(renderSettings('agent', 1)); await Promise.resolve() })
    expect(container.querySelector('h1')?.textContent).toBe('Harness')
  })

  it('keeps Harness settings universal while leaving only providers harness-specific', async () => {
    const onUpdate = vi.fn()
    const onRefreshHarnesses = vi.fn(async () => undefined)
    const primeSettings: AppSettings = { ...DEFAULT_SETTINGS, activeHarness: 'prime' }
    await act(async () => { root.render(<AgentSettings settings={primeSettings} meta={meta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    expect(container.textContent).toContain('Default harness')
    expect(container.textContent).toContain('OMP approval mode')
    expect(container.textContent).toContain('Prime Agent is ready')
    expect(container.textContent).toContain('OMP not detected')
    expect([...container.querySelectorAll<HTMLSelectElement>('select')[0].options].map((option) => option.textContent)).toEqual(['Prime Work'])

    const refresh = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Refresh harnesses'))!
    await click(refresh)
    expect(onRefreshHarnesses).toHaveBeenCalledTimes(1)

    await act(async () => { root.render(<AgentSettings settings={primeSettings} meta={allDetectedMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    const harnessSelect = container.querySelector<HTMLSelectElement>('select')!
    await select(harnessSelect!, 'omp')
    expect(onUpdate).toHaveBeenCalledWith({ activeHarness: 'omp' })

    const piSettings: AppSettings = { ...DEFAULT_SETTINGS, activeHarness: 'pi' }
    await act(async () => { root.render(<AgentSettings settings={piSettings} meta={allDetectedMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />) })
    expect(container.textContent).toContain('OMP approval mode')
    const selects = [...container.querySelectorAll<HTMLSelectElement>('select')]
    expect(selects).toHaveLength(2)
    const approvalSelect = selects[1]
    expect([...approvalSelect.options].map((option) => option.textContent)).toEqual([
      'Inherit omp config',
      'Always ask',
      'Prompt for exec only (write)',
      'YOLO (never prompt)',
    ])
    await select(approvalSelect, 'write')
    expect(onUpdate).toHaveBeenCalledWith({ ompApprovalMode: 'write' })
    expect([...selects[0].options].map((option) => option.textContent)).toEqual(['OMP Work', 'Prime Work', 'Pi Work'])
  })

  it('renders a harness discovery problem in its runtime card', async () => {
    const onUpdate = vi.fn()
    const onRefreshHarnesses = vi.fn(async () => undefined)
    const problemMeta: AppMeta = {
      ...meta,
      harnesses: {
        ...meta.harnesses,
        pi: { path: null, version: null, problem: { path: '/Users/you/.local/bin/pi', reason: 'exited with code 1: Node.js is too old' } },
      },
    }

    await act(async () => {
      root.render(<AgentSettings settings={{ ...DEFAULT_SETTINGS, activeHarness: 'prime' }} meta={problemMeta} onUpdate={onUpdate} onRefreshHarnesses={onRefreshHarnesses} />)
    })

    const piCard = [...container.querySelectorAll('.runtime-card')].find((card) => card.textContent?.includes('Pi not detected'))
    expect(piCard?.querySelector('small')?.getAttribute('title')).toBe('/Users/you/.local/bin/pi: exited with code 1: Node.js is too old')
    expect(container.textContent).toContain('/Users/you/.local/bin/pi: exited with code 1: Node.js is too old')
  })

  it('renders OMP provider toggles while keeping credentials CLI-owned', async () => {
    const catalog: PrimeModelCatalog = {
      primeVersion: '17.2.11', refreshedAt: '2026-08-06T00:00:00.000Z',
      models: [{ key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6', reasoning: true, input: ['text'], contextWindow: 400_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'high'], fastModeSupported: false, available: true }],
      providers: [
        { id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'external', configured: true, authLabel: 'Credentials managed by the omp CLI', modelCount: 1, availableModelCount: 1, enabled: true },
        { id: 'anthropic', name: 'Anthropic', authMethod: 'external', configured: true, modelCount: 0, availableModelCount: 0, enabled: true },
      ],
    }
    const noopAsync = async () => undefined
    await act(async () => {
      root.render(<ProviderSettings harness="omp" catalog={catalog} onRefresh={noopAsync} onSaveApiKey={noopAsync} onLogout={noopAsync} onSetEnabled={noopAsync} onSetAllEnabled={noopAsync} onSetAllDisabled={noopAsync} onSetModelEnabled={noopAsync} onStartOAuth={noopAsync} onOpenDocs={() => undefined} />)
    })

    expect(container.textContent).toContain('OMP catalogue')
    expect(container.textContent).toContain('Credentials managed by the omp CLI')
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    const buttonLabels = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
    expect(buttonLabels.some((text) => text.includes('Hide all'))).toBe(true)
    expect(buttonLabels.some((text) => text.includes('Credential setup'))).toBe(true)
    for (const label of ['Connect', 'Reconnect', 'Add key', 'Replace key', 'Disable all', 'Enable all']) {
      expect(buttonLabels.some((text) => text.includes(label))).toBe(false)
    }
  })

  it('renders Pi provider visibility toggles while keeping credentials CLI-owned', async () => {
    const catalog: PrimeModelCatalog = {
      primeVersion: '0.84.1', refreshedAt: '2026-08-06T00:00:00.000Z',
      models: [{ key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', reasoning: true, input: ['text'], contextWindow: 272_000, maxTokens: 128_000, availableThinkingLevels: ['low', 'high'], fastModeSupported: true, available: true }],
      providers: [
        { id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
        { id: 'anthropic', name: 'Anthropic', authMethod: 'external', configured: true, modelCount: 0, availableModelCount: 0, enabled: true },
      ],
    }
    const noopAsync = async () => undefined
    const onSetEnabled = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<ProviderSettings harness="pi" catalog={catalog} onRefresh={noopAsync} onSaveApiKey={noopAsync} onLogout={noopAsync} onSetEnabled={onSetEnabled} onSetAllEnabled={noopAsync} onSetAllDisabled={noopAsync} onSetModelEnabled={noopAsync} onStartOAuth={noopAsync} onOpenDocs={() => undefined} />)
    })

    expect(container.textContent).toContain('Pi catalogue')
    expect(container.textContent).toContain('Credentials managed by the pi CLI')
    const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    expect(toggles).toHaveLength(2)
    const buttonLabels = [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
    expect(buttonLabels.some((text) => text.includes('Hide all'))).toBe(true)
    expect(buttonLabels.some((text) => text.includes('Credential setup'))).toBe(true)
    for (const label of ['Connect', 'Reconnect', 'Add key', 'Replace key', 'Disable all', 'Enable all']) {
      expect(buttonLabels.some((text) => text.includes(label))).toBe(false)
    }

    // Toggling a provider only asks the desktop app to hide it; auth stays with the pi CLI.
    await click(toggles[0])
    expect(onSetEnabled).toHaveBeenCalledWith('openai-codex', false)
  })
})
