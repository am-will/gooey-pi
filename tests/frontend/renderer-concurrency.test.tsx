// @vitest-environment jsdom

import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_EVENT_FLUSH_CHUNK, AGENT_EVENT_QUEUE_LIMIT } from '../../src/app/agent-events'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { useAppSettings } from '../../src/hooks/useAppSettings'
import { useBootstrap } from '../../src/hooks/useBootstrap'
import { useExtensionUi } from '../../src/hooks/useExtensionUi'
import { usePluginSkills } from '../../src/hooks/usePluginSkills'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { AppSettings, PluginCatalog, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord, SkillRecord, TranscriptMessage } from '../../src/types/api'

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

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const session: SessionRecord = {
  id: 'session', harness: 'prime', projectPath: '/project', filePath: '/sessions/current.jsonl', title: 'Current',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
}
const message = (text: string): TranscriptMessage => ({
  id: text, role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text }],
})
const runtime: RuntimeInfo = { runtimeId: 'runtime', harness: 'prime', cwd: '/project', sessionFile: session.filePath, isStreaming: false }

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
})

function setDocumentVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

function Probe({ children }: { children?: ReactNode }) { return <>{children}</> }

describe('settings queue reconciliation', () => {
  it('runs external settings reconciliation after queued local mutations', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const update = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const bridge = {
      settings: { get: async () => DEFAULT_SETTINGS, update },
    } as unknown as PrimeWorkApi
    const external = vi.fn(async () => ({ settings: { ...DEFAULT_SETTINGS, sidebarOpen: false, terminalOpen: true, activeHarness: 'pi' as const } }))
    const reportError = vi.fn()
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })

    let firstMutation!: Promise<void>
    let secondMutation!: Promise<void>
    let reconciliation!: ReturnType<typeof state.reconcileExternalSettings>
    await act(async () => {
      firstMutation = state.updateSettings({ sidebarOpen: false })
      secondMutation = state.updateSettings({ terminalOpen: true })
      reconciliation = state.reconcileExternalSettings(external)
      await Promise.resolve()
    })
    expect(external).not.toHaveBeenCalled()

    const afterFirst = { ...DEFAULT_SETTINGS, sidebarOpen: false }
    await act(async () => { first.resolve(afterFirst); await firstMutation; await Promise.resolve() })
    expect(external).not.toHaveBeenCalled()
    const afterSecond = { ...afterFirst, terminalOpen: true }
    await act(async () => { second.resolve(afterSecond); await secondMutation; await reconciliation })
    expect(external).toHaveBeenCalledTimes(1)
    expect(state.settings).toMatchObject({ sidebarOpen: false, terminalOpen: true, activeHarness: 'pi' })
  })

  it('does not initialize until persisted settings finish loading', async () => {
    const persisted = deferred<AppSettings>()
    const bridge = {
      settings: { get: () => persisted.promise },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })
    expect(state.initialized).toBe(false)
    await act(async () => { persisted.resolve({ ...DEFAULT_SETTINGS, activeHarness: 'pi' }); await persisted.promise; await Promise.resolve() })
    expect(state.initialized).toBe(true)
    expect(state.settings.activeHarness).toBe('pi')
  })

  it('restores every standalone panel from the latest saved settings after a queued failure', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const update = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const bridge = {
      settings: { get: async () => DEFAULT_SETTINGS, update },
    } as unknown as PrimeWorkApi
    const errors: unknown[] = []
    const reportError = (error: unknown) => { errors.push(error) }
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })

    let firstMutation!: Promise<void>
    let secondMutation!: Promise<void>
    await act(async () => {
      firstMutation = state.updateSettings({ sidebarOpen: false })
      secondMutation = state.updateSettings({ terminalOpen: true })
    })
    expect([state.sidebarOpen, state.inspectorOpen, state.terminalOpen]).toEqual([false, true, true])

    const saved = { ...DEFAULT_SETTINGS, sidebarOpen: false, inspectorOpen: false, terminalOpen: false }
    await act(async () => { first.resolve(saved); await firstMutation })
    await act(async () => { second.reject(new Error('save failed')); await secondMutation })

    expect([state.sidebarOpen, state.inspectorOpen, state.terminalOpen]).toEqual([false, false, false])
    expect(state.settings).toEqual(saved)
    expect(errors).toHaveLength(1)
  })

  it('does not replace unrelated transient panel state during authoritative reconciliation', async () => {
    const save = deferred<AppSettings>()
    const bridge = {
      settings: { get: async () => DEFAULT_SETTINGS, update: () => save.promise },
    } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useAppSettings>
    function SettingsProbe() {
      state = useAppSettings({ bridge, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<SettingsProbe />); await Promise.resolve() })

    let mutation!: Promise<void>
    await act(async () => {
      mutation = state.updateSettings({ sidebarOpen: false })
      state.setInspectorOpen(false)
    })
    const saved = { ...DEFAULT_SETTINGS, sidebarOpen: false, inspectorOpen: true }
    await act(async () => { save.resolve(saved); await mutation })

    expect(state.settings).toEqual(saved)
    expect([state.sidebarOpen, state.inspectorOpen]).toEqual([false, false])
  })
})

describe('transcript read ownership', () => {
  it('keeps live compaction visible when it supersedes a terminal transcript read', async () => {
    const staleRead = deferred<TranscriptMessage[]>()
    const read = vi.fn()
      .mockResolvedValueOnce([message('loaded')])
      .mockImplementationOnce(() => staleRead.promise)
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, sessions: [session],
        initialMessages: [], reportError: vi.fn(),
      })
      return <Probe />
    }
    await act(async () => { root.render(<WorkspaceProbe />); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { state.attachRuntime(runtime, 0) })
    await act(async () => {
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'agent_end' })
      await Promise.resolve()
    })
    expect(read).toHaveBeenCalledTimes(2)

    await act(async () => {
      const event = { type: 'compaction_start', reason: 'threshold' }
      state.queueAgentEvent(event)
      state.reconcileTranscriptForEvent(runtime.runtimeId, event)
      await Promise.resolve()
    })
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'running' })

    await act(async () => { staleRead.resolve([message('stale')]); await staleRead.promise; await Promise.resolve() })
    expect(state.messages.at(-1)?.parts[0]).toMatchObject({ type: 'compaction', status: 'running' })
    expect(state.messages.some((item) => item.id === 'stale')).toBe(false)
  })

  it('performs one initial read and rejects an older same-runtime reconciliation after prompt admission', async () => {
    const staleRead = deferred<TranscriptMessage[]>()
    const read = vi.fn()
      .mockResolvedValueOnce([message('loaded:')])
      .mockImplementationOnce(() => staleRead.promise)
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, sessions: [session],
        initialMessages: [], reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<WorkspaceProbe />); await Promise.resolve(); await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)
    expect(state.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'loaded:' })

    await act(async () => { state.attachRuntime(runtime, 0) })
    await act(async () => {
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'transport_error' })
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'agent_end' })
      await Promise.resolve()
    })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => {
      state.queueAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } })
      expect(state.prepareForPrompt(0)).toBe(true)
    })
    await act(async () => { staleRead.resolve([message('stale-authoritative')]); await staleRead.promise; await Promise.resolve() })

    expect(state.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'loaded:live' })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('clears prompt admission on transport_error and runtime_exit so reconciliation recovers', async () => {
    const read = vi.fn().mockResolvedValue([message('loaded:')])
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, sessions: [session],
        initialMessages: [], reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<WorkspaceProbe />); await Promise.resolve(); await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)

    await act(async () => { state.attachRuntime(runtime, 0) })
    await act(async () => { expect(state.prepareForPrompt(0)).toBe(true) })

    // The admitted prompt never starts: the transport fails and the runtime exits.
    await act(async () => {
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'transport_error' })
      state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'runtime_exit' })
      await Promise.resolve()
    })

    expect(read).toHaveBeenCalledTimes(2)
  })

  it('starts an admitted load even when the session catalog record has diverged', async () => {
    const read = vi.fn().mockResolvedValue([message('loaded:')])
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    const renamedRecord: SessionRecord = { ...session, id: 'two', filePath: '/sessions/two-renamed.jsonl', title: 'Two' }
    const activatedSession: SessionRecord = { ...session, id: 'two', filePath: '/sessions/two.jsonl', title: 'Two' }
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, sessions: [session, renamedRecord],
        initialMessages: [], reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<WorkspaceProbe />); await Promise.resolve(); await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(1)

    // Activate a session whose catalog record carries a different filePath, so
    // the transcript effect's guard can never match this workspace.
    await act(async () => { state.activateWorkspace(project, activatedSession); await Promise.resolve(); await Promise.resolve() })

    expect(read).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenLastCalledWith('/sessions/two.jsonl')
    expect(state.loadingSession).toBe(false)
  })
})

describe('agent event frame queue', () => {
  function mountWorkspace(read: ReturnType<typeof vi.fn>) {
    const bridge = { sessions: { read } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    let state!: ReturnType<typeof useWorkspaceRuntime>
    function WorkspaceProbe() {
      state = useWorkspaceRuntime({
        bridge, initialProject: project, initialSession: session, sessions: [session],
        initialMessages: [], reportError,
      })
      return <Probe />
    }
    return { render: () => root.render(<WorkspaceProbe />), state: () => state }
  }

  const delta = (text: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
  const messageText = (state: ReturnType<typeof useWorkspaceRuntime>) => (state.messages[0]?.parts[0] as { text?: string } | undefined)?.text ?? ''

  it('cancels the pending animation frame before a synchronous flush', async () => {
    const pendingFrame = 417
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => pendingFrame)
    const cancelSpy = vi.spyOn(globalThis, 'cancelAnimationFrame')
    try {
      const read = vi.fn().mockResolvedValue([message('loaded:')])
      const workspace = mountWorkspace(read)
      await act(async () => { workspace.render(); await Promise.resolve(); await Promise.resolve() })
      const state = workspace.state()
      await act(async () => { state.attachRuntime(runtime, 0) })
      await act(async () => { state.queueAgentEvent(delta('live')) })
      expect(rafSpy).toHaveBeenCalledTimes(1)

      await act(async () => { state.reconcileTranscriptForEvent(runtime.runtimeId, { type: 'agent_end' }); await Promise.resolve() })

      expect(cancelSpy).toHaveBeenCalledWith(pendingFrame)
      expect(messageText(workspace.state())).toBe('loaded:')
    } finally {
      cancelSpy.mockRestore()
      rafSpy.mockRestore()
    }
  })

  it('falls back to an authoritative read on the next visibilitychange after the queue bound is exceeded', async () => {
    const read = vi.fn()
      .mockResolvedValueOnce([message('loaded:')])
      .mockResolvedValueOnce([message('fresh')])
    const workspace = mountWorkspace(read)
    await act(async () => { workspace.render(); await Promise.resolve(); await Promise.resolve() })
    const state = workspace.state()
    await act(async () => { state.attachRuntime(runtime, 0) })
    setDocumentVisibility('hidden')
    await act(async () => {
      for (let index = 0; index <= AGENT_EVENT_QUEUE_LIMIT; index += 1) state.queueAgentEvent(delta('x'))
    })
    expect(read).toHaveBeenCalledTimes(1)
    setDocumentVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); await Promise.resolve() })
    expect(read).toHaveBeenCalledTimes(2)
    expect(messageText(workspace.state())).toBe('fresh')
  })

  it('drains a large hidden-window queue in chunks on visibilitychange', async () => {
    // jsdom fires requestAnimationFrame on a timer even for hidden documents,
    // unlike real Chromium, which suspends it — the exact behavior this test
    // simulates. Stub rAF to never fire so the queue can only drain through
    // the visibilitychange chunked path, deterministically.
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
    try {
      const read = vi.fn().mockResolvedValue([message('loaded:')])
      const workspace = mountWorkspace(read)
      await act(async () => { workspace.render(); await Promise.resolve(); await Promise.resolve() })
      const state = workspace.state()
      await act(async () => { state.attachRuntime(runtime, 0) })
      setDocumentVisibility('hidden')
      await act(async () => {
        for (let index = 0; index < AGENT_EVENT_FLUSH_CHUNK + 1; index += 1) state.queueAgentEvent(delta('x'))
      })
      setDocumentVisibility('visible')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      expect(messageText(workspace.state())).toBe(`loaded:${'x'.repeat(AGENT_EVENT_FLUSH_CHUNK)}`)
      await act(async () => { await new Promise((resolveWait) => setTimeout(resolveWait, 0)) })
      expect(messageText(workspace.state())).toBe(`loaded:${'x'.repeat(AGENT_EVENT_FLUSH_CHUNK + 1)}`)
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      rafSpy.mockRestore()
    }
  })
})

describe('agent event git refresh timer', () => {
  it('coalesces terminal-event git refreshes and clears the timer on cleanup', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let handler!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
      const unsubscribe = vi.fn()
      const bridge = {
        agent: { onEvent: (callback: typeof handler) => { handler = callback; return unsubscribe } },
      } as unknown as PrimeWorkApi
      const refreshGit = vi.fn(async () => undefined)
      function AgentEventsProbe() {
        useAgentEvents({
          bridge,
          runtimeIdRef: { current: 'runtime' },
          runtimeSessionsRef: { current: new Map([['runtime', session.filePath]]) },
          runtimeOwnerRef: { current: null },
          workspaceRef: { current: { generation: 0, sessionFile: session.filePath, cwd: '/project' } },
          setSessions: vi.fn(),
          setRuntime: vi.fn(),
          queueAgentEvent: vi.fn(),
          reconcileTranscriptForEvent: vi.fn(),
          showExtensionUi: vi.fn(),
          clearExtensionUi: vi.fn(),
          refreshGit,
          refreshGitOnTerminalEvent: true,
          activeSessionVisible: true,
        })
        return <Probe />
      }
      await act(async () => { root.render(<AgentEventsProbe />) })
      act(() => {
        handler({ runtimeId: 'runtime', event: { type: 'agent_end' } })
        handler({ runtimeId: 'runtime', event: { type: 'error' } })
      })
      act(() => { vi.advanceTimersByTime(200) })
      expect(refreshGit).toHaveBeenCalledTimes(1)

      act(() => { handler({ runtimeId: 'runtime', event: { type: 'agent_end' } }) })
      await act(async () => root.unmount())
      act(() => { vi.advanceTimersByTime(200) })
      expect(refreshGit).toHaveBeenCalledTimes(1)
      expect(unsubscribe).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('bootstrap critical path', () => {
  it('keeps agent_end completion when a delayed idle catalog refresh resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const delayedCatalog = deferred<SessionRecord[]>()
      const listSessions = vi.fn()
        .mockResolvedValueOnce([session])
        .mockImplementationOnce(() => delayedCatalog.promise)
      let catalogChanged!: (change: { filePath?: string; harness?: 'prime' }) => void
      let agentEvent!: (payload: { runtimeId: string; event: Record<string, unknown> }) => void
      const bridge = {
        projects: { list: async () => [project] },
        sessions: {
          list: listSessions,
          onChanged: (callback: typeof catalogChanged) => { catalogChanged = callback; return () => undefined },
        },
        agent: {
          list: async () => [runtime],
          onEvent: (callback: typeof agentEvent) => { agentEvent = callback; return () => undefined },
        },
        app: { getMeta: async () => ({ version: '1', platform: 'darwin', arch: 'arm64', primeAvailable: true }) },
        schedules: { list: async () => [] },
      } as unknown as PrimeWorkApi
      const runtimeIdRef = { current: runtime.runtimeId as string | null }
      const runtimeSessionsRef = { current: new Map([[runtime.runtimeId, session.filePath]]) }
      const runtimeOwnerRef = { current: null }
      const workspaceRef = { current: { generation: 0, project, session, cwd: project.path, sessionFile: session.filePath } }
      const setProjects = vi.fn()
      const setSchedules = vi.fn()
      const setScheduleError = vi.fn()
      const activateWorkspace = () => 0
      const attachRuntime = vi.fn()
      const reportError = vi.fn()
      const queueAgentEvent = vi.fn()
      const reconcileTranscriptForEvent = vi.fn()
      const showExtensionUi = vi.fn()
      const clearExtensionUi = vi.fn()
      const refreshGit = async () => undefined
      let renderedSessions: SessionRecord[] = []

      function RaceProbe() {
        const [sessions, setSessions] = useState([session])
        const [, setRuntime] = useState<RuntimeInfo | null>(runtime)
        renderedSessions = sessions
        useBootstrap({
          bridge,
          setProjects,
          setSessions,
          setSchedules,
          setScheduleError,
          runtimeSessionsRef,
          workspaceRef,
          activateWorkspace,
          attachRuntime,
          reportError,
        })
        useAgentEvents({
          bridge,
          runtimeIdRef,
          runtimeSessionsRef,
          runtimeOwnerRef,
          workspaceRef,
          setSessions,
          setRuntime,
          queueAgentEvent,
          reconcileTranscriptForEvent,
          showExtensionUi,
          clearExtensionUi,
          refreshGit,
          refreshGitOnTerminalEvent: false,
          activeSessionVisible: true,
        })
        return <Probe />
      }

      await act(async () => {
        root.render(<RaceProbe />)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(listSessions).toHaveBeenCalledTimes(1)

      act(() => agentEvent({ runtimeId: runtime.runtimeId, event: { type: 'agent_end' } }))
      expect(renderedSessions[0]).toMatchObject({ status: 'complete', unread: false, eventRevision: 1, statusEventRevision: 1 })

      act(() => {
        catalogChanged({ filePath: session.filePath, harness: 'prime' })
        vi.advanceTimersByTime(80)
      })
      expect(listSessions).toHaveBeenCalledTimes(2)
      await act(async () => {
        delayedCatalog.resolve([{ ...session, status: 'idle' }])
        await delayedCatalog.promise
        await Promise.resolve()
      })

      expect(renderedSessions[0]).toMatchObject({ status: 'complete', unread: false, eventRevision: 1, statusEventRevision: 1, syncRevision: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects projects and sessions before runtime discovery resolves', async () => {
    const runtimes = deferred<RuntimeInfo[]>()
    const bridge = {
      projects: { list: async () => [project] },
      sessions: { list: async () => [session], onChanged: () => () => undefined },
      agent: { list: () => runtimes.promise },
      app: { getMeta: async () => ({ version: '1', platform: 'darwin', arch: 'arm64', primeAvailable: true }) },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const workspaceRef = { current: { generation: 0 } as { generation: number; project?: ProjectRecord; session?: SessionRecord; cwd?: string; sessionFile?: string } }
    const activated: Array<{ project?: ProjectRecord; session?: SessionRecord }> = []
    const attached: RuntimeInfo[] = []
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const reportError = vi.fn()
    const activateWorkspace = (nextProject?: ProjectRecord, nextSession?: SessionRecord) => {
      workspaceRef.current = { generation: 1, project: nextProject, session: nextSession, cwd: '/project', sessionFile: nextSession?.filePath }
      activated.push({ project: nextProject, session: nextSession })
      return 1
    }
    const attachRuntime = (next?: RuntimeInfo) => { if (next) attached.push(next) }
    let initialized = false
    function BootstrapProbe() {
      const result = useBootstrap({
        bridge, setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef,
        activateWorkspace, attachRuntime, reportError,
      })
      initialized = result.initialized
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })

    expect(initialized).toBe(true)
    expect(activated).toEqual([{ project, session }])
    expect(attached).toEqual([])
    await act(async () => { runtimes.resolve([runtime]); await runtimes.promise; await Promise.resolve() })
    expect(attached).toEqual([runtime])
  })

  it('merges runtime discovery into sessions learned from live events', async () => {
    const runtimes = deferred<RuntimeInfo[]>()
    const bridge = {
      projects: { list: async () => [project] },
      sessions: { list: async () => [session], onChanged: () => () => undefined },
      agent: { list: () => runtimes.promise },
      app: { getMeta: async () => ({ version: '1', platform: 'darwin', arch: 'arm64', primeAvailable: true }) },
      schedules: { list: async () => [] },
    } as unknown as PrimeWorkApi
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const workspaceRef = { current: { generation: 0 } }
    const setProjects = vi.fn()
    const setSessions = vi.fn()
    const setSchedules = vi.fn()
    const setScheduleError = vi.fn()
    const attachRuntime = vi.fn()
    const reportError = vi.fn()
    const activateWorkspace = () => 1
    function BootstrapProbe() {
      useBootstrap({
        bridge, setProjects, setSessions, setSchedules, setScheduleError,
        runtimeSessionsRef, workspaceRef,
        activateWorkspace, attachRuntime, reportError,
      })
      return <Probe />
    }
    await act(async () => { root.render(<BootstrapProbe />); await Promise.resolve(); await Promise.resolve() })
    // A live event arrives while agent.list() is still in flight.
    runtimeSessionsRef.current.set('live-runtime', '/sessions/live.jsonl')
    await act(async () => {
      runtimes.resolve([{ runtimeId: 'listed-runtime', harness: 'prime', cwd: '/project', sessionFile: '/sessions/listed.jsonl', isStreaming: false }])
      await runtimes.promise
      await Promise.resolve()
    })
    expect(runtimeSessionsRef.current.get('live-runtime')).toBe('/sessions/live.jsonl')
    expect(runtimeSessionsRef.current.get('listed-runtime')).toBe('/sessions/listed.jsonl')
  })
})


describe('extension UI runtime ownership', () => {
  it('retains a background request and surfaces it when that runtime activates', async () => {
    const bridge = { agent: { command: vi.fn().mockResolvedValue({}) } } as unknown as PrimeWorkApi
    const runtimeIdRef = { current: 'active' as string | null }
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useExtensionUi>
    function ExtensionProbe({ activeRuntimeId }: { activeRuntimeId: string }) {
      runtimeIdRef.current = activeRuntimeId
      state = useExtensionUi({ bridge, activeRuntimeId, runtimeSessionsRef, setSessions, setRuntime, reportError })
      return <Probe />
    }
    await act(async () => { root.render(<ExtensionProbe activeRuntimeId="active" />) })
    await act(async () => {
      state.showExtensionUi('background', {
        type: 'extension_ui_request', id: 'background-question', method: 'confirm', title: 'Continue?', message: 'Proceed',
      })
    })
    expect(state.extensionUi).toBeNull()

    await act(async () => { root.render(<ExtensionProbe activeRuntimeId="background" />) })
    expect(state.extensionUi?.runtimeId).toBe('background')
    expect(state.extensionUi?.request.id).toBe('background-question')
    expect(bridge.agent.command).not.toHaveBeenCalled()
  })

  it('groups ask_user question requests and responds to every pending question', async () => {
    const command = vi.fn().mockResolvedValue({})
    const bridge = { agent: { command } } as unknown as PrimeWorkApi
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useExtensionUi>
    function ExtensionProbe() {
      state = useExtensionUi({ bridge, activeRuntimeId: 'runtime', runtimeSessionsRef, setSessions, setRuntime, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<ExtensionProbe />) })
    await act(async () => {
      state.showExtensionUi('runtime', {
        type: 'extension_ui_request', id: 'question-1', method: 'select', title: 'First question',
        options: ['__prime_ask_user__group-1:0:2', 'A', 'B'],
      })
      state.showExtensionUi('runtime', {
        type: 'extension_ui_request', id: 'question-2', method: 'select', title: 'Second question',
        options: ['__prime_ask_user__group-1:1:2', 'C', 'D'],
      })
    })

    expect(state.extensionUi?.request.method).toBe('questionnaire')
    expect(state.extensionUi?.request.method === 'questionnaire' ? state.extensionUi.request.questions : []).toHaveLength(2)

    await act(async () => {
      await state.respondToExtensionUi({ values: {
        'question-1': JSON.stringify({ answer: 'B', answerSource: 'option' }),
        'question-2': JSON.stringify({ answer: 'D', answerSource: 'option', context: 'Because it is safer.' }),
      } })
    })

    expect(command).toHaveBeenNthCalledWith(1, 'runtime', { type: 'extension_ui_response', id: 'question-1', value: JSON.stringify({ answer: 'B', answerSource: 'option' }) })
    expect(command).toHaveBeenNthCalledWith(2, 'runtime', { type: 'extension_ui_response', id: 'question-2', value: JSON.stringify({ answer: 'D', answerSource: 'option', context: 'Because it is safer.' }) })
    expect(setRuntime).toHaveBeenCalledTimes(1)
    const resumeRuntime = setRuntime.mock.calls[0][0] as (current: RuntimeInfo | null) => RuntimeInfo | null
    expect(resumeRuntime(runtime)).toMatchObject({ runtimeId: 'runtime', isStreaming: true })
  })

  it('stops the agent when an ask_user questionnaire is dismissed', async () => {
    const command = vi.fn().mockResolvedValue({})
    const stop = vi.fn().mockResolvedValue(true)
    const bridge = { agent: { command, stop } } as unknown as PrimeWorkApi
    const runtimeSessionsRef = { current: new Map<string, string>() }
    const setSessions = vi.fn()
    const setRuntime = vi.fn()
    const reportError = vi.fn()
    let state!: ReturnType<typeof useExtensionUi>
    function ExtensionProbe() {
      state = useExtensionUi({ bridge, activeRuntimeId: 'runtime', runtimeSessionsRef, setSessions, setRuntime, reportError })
      return <Probe />
    }

    await act(async () => { root.render(<ExtensionProbe />) })
    await act(async () => {
      state.showExtensionUi('runtime', {
        type: 'extension_ui_request', id: 'question-1', method: 'select', title: 'First question',
        options: ['__prime_ask_user__group-1:0:1', 'A', 'B'],
      })
    })
    await act(async () => { await state.respondToExtensionUi({ cancelled: true }) })

    expect(stop).toHaveBeenCalledWith('runtime')
    expect(command).not.toHaveBeenCalled()
    expect(state.extensionUi).toBeNull()
  })

  it('auto-continues an unanswered ask_user questionnaire after thirty seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const command = vi.fn().mockResolvedValue({})
      const stop = vi.fn().mockResolvedValue(true)
      const bridge = { agent: { command, stop } } as unknown as PrimeWorkApi
      const runtimeSessionsRef = { current: new Map<string, string>() }
      const setSessions = vi.fn()
      const setRuntime = vi.fn()
      const reportError = vi.fn()
      let state!: ReturnType<typeof useExtensionUi>
      function ExtensionProbe() {
        state = useExtensionUi({ bridge, activeRuntimeId: 'runtime', runtimeSessionsRef, setSessions, setRuntime, reportError })
        return <Probe />
      }

      await act(async () => { root.render(<ExtensionProbe />) })
      await act(async () => {
        state.showExtensionUi('runtime', {
          type: 'extension_ui_request', id: 'question-1', method: 'select', title: 'First question',
          options: ['__prime_ask_user__group-1:0:1', 'A', 'B'],
        })
      })
      expect(state.extensionUi?.request.method === 'questionnaire' ? state.extensionUi.request.timeout : undefined).toBe(30_000)

      await act(async () => { vi.advanceTimersByTime(29_999) })
      expect(state.extensionUi).not.toBeNull()
      await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve() })

      expect(state.extensionUi).toBeNull()
      expect(stop).not.toHaveBeenCalled()
      expect(command).toHaveBeenCalledWith('runtime', {
        type: 'extension_ui_response', id: 'question-1', cancelled: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })
})


describe('plugin request ownership', () => {
  it('rejects stale global, project, refresh, generation, and path completions', async () => {
    const requests = Array.from({ length: 4 }, () => deferred<PluginCatalog>())
    const list = vi.fn()
    for (const request of requests) list.mockImplementationOnce(() => request.promise)
    const bridge = { plugins: { list } } as unknown as PrimeWorkApi
    const reportError = vi.fn()
    const skill = (id: string): SkillRecord => ({ id, name: id, description: id, kind: 'skill', location: 'project', enabled: true })
    let state!: ReturnType<typeof usePluginSkills>
    function PluginProbe({ scope, generation }: { scope?: string; generation: number }) {
      state = usePluginSkills({ bridge, harness: 'prime', scope, generation, initialSkills: [], reportError })
      return <Probe />
    }
    await act(async () => { root.render(<PluginProbe generation={0} />) })
    expect(list).toHaveBeenNthCalledWith(1, undefined, 'prime')
    await act(async () => { root.render(<PluginProbe scope="/project" generation={1} />) })
    expect(list).toHaveBeenNthCalledWith(2, '/project', 'prime')

    await act(async () => { requests[0].resolve({ skills: [skill('stale-global')], warnings: [] }); await requests[0].promise })
    expect(state.skills).toEqual([])
    await act(async () => { requests[1].resolve({ skills: [skill('project-one')], warnings: [] }); await requests[1].promise })
    expect(state.skills.map(({ id }) => id)).toEqual(['project-one'])

    let refresh!: Promise<void>
    await act(async () => { refresh = state.refresh(); await Promise.resolve() })
    await act(async () => { root.render(<PluginProbe scope="/project" generation={2} />) })
    await act(async () => { requests[2].resolve({ skills: [skill('stale-refresh')], warnings: [] }); await refresh })
    expect(state.skills).toEqual([])
    await act(async () => { requests[3].resolve({ skills: [skill('project-two')], warnings: [] }); await requests[3].promise })
    expect(state.skills.map(({ id }) => id)).toEqual(['project-two'])
    expect(reportError).not.toHaveBeenCalled()
  })
})
