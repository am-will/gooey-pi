// @vitest-environment jsdom

import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentEvents } from '../../src/hooks/useAgentEvents'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import type { PrimeEventEnvelope, PrimeWorkApi, ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project',
  pinned: false, createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 1,
}
const existing: SessionRecord = {
  id: 'existing', harness: 'prime', filePath: '/sessions/existing.jsonl', projectPath: '/project', title: 'Existing work',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0, unread: false,
}
const started: SessionRecord = { ...existing, id: 'started', filePath: '/sessions/started.jsonl', title: 'Untitled session', status: 'running' }
const startedRuntime: RuntimeInfo = { runtimeId: 'started-runtime', harness: 'prime', cwd: '/project', sessionFile: started.filePath, isStreaming: false }

let container: HTMLDivElement
let root: Root
let workspace: ReturnType<typeof useWorkspaceRuntime>
let sessions: SessionRecord[]
let setSessions: React.Dispatch<React.SetStateAction<SessionRecord[]>>

function WorkspaceProbe({ sessions }: { sessions: SessionRecord[] }) {
  workspace = useWorkspaceRuntime({ bridge: null, initialProject: project, sessions, initialMessages: [], reportError: () => undefined })
  return null
}

// App passes stable callbacks; an inline one would rerun the transcript read effect on every render.
const ignore = () => undefined
const refreshGit = async () => undefined
const noMessages: never[] = []

/** The renderer pieces a new chat's first prompt runs through: the workspace, its live events, and its catalog. */
function AppProbe({ bridge }: { bridge: PrimeWorkApi }) {
  const [items, setItems] = useState<SessionRecord[]>([existing])
  sessions = items
  setSessions = setItems
  workspace = useWorkspaceRuntime({ bridge, initialProject: project, sessions: items, initialMessages: noMessages, reportError: ignore })
  useAgentEvents({
    bridge,
    runtimeIdRef: workspace.runtimeIdRef,
    runtimeSessionsRef: workspace.runtimeSessionsRef,
    dropPendingSteers: workspace.dropPendingSteers,
        detachRuntime: workspace.detachRuntime,
    workspaceRef: workspace.workspaceRef,
    setSessions: setItems,
    setRuntime: workspace.setRuntime,
    queueAgentEvent: workspace.queueAgentEvent,
    reconcileTranscriptForEvent: workspace.reconcileTranscriptForEvent,
    showExtensionUi: ignore,
    clearExtensionUi: ignore,
    refreshGit,
    refreshGitOnTerminalEvent: false,
    activeSessionVisible: true,
  })
  return null
}

function renderApp() {
  const start = deferred<RuntimeInfo>()
  // The harness writes the started session's file once its runtime runs.
  let catalog = [existing]
  let emitEvent: ((envelope: PrimeEventEnvelope) => void) | undefined
  const agent = {
    list: vi.fn(async (): Promise<RuntimeInfo[]> => []),
    start: vi.fn(() => start.promise),
    command: vi.fn(async (_runtimeId: string, _command: Record<string, unknown>) => ({})),
    stop: vi.fn(async () => true),
    onEvent: (callback: (envelope: PrimeEventEnvelope) => void) => { emitEvent = callback; return () => undefined },
  }
  const read = vi.fn(async () => [])
  const bridge = {
    agent,
    sessions: { list: vi.fn(async () => catalog), read, followUp: vi.fn(async () => false) },
  } as unknown as PrimeWorkApi
  const actions = createWorkspaceActions(() => ({
    bridge,
    initialized: true,
    projects: [project],
    sessions,
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'prime' } },
    layout: { compactLayout: false },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: { active: false, run: async (task: () => Promise<void>) => { await task(); return true } } },
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions,
    setGitSnapshot: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast: vi.fn(),
    setSubmitting: vi.fn(),
    clearSessionAttention: vi.fn(),
    reportError: vi.fn(),
  } as unknown as WorkspaceActionsDeps))
  act(() => root.render(createElement(AppProbe, { bridge })))
  let sending: Promise<void> | undefined
  return {
    actions,
    agent,
    read,
    /** Sends the new chat's first prompt and waits until it is starting a runtime. */
    async send(prompt: string) {
      await act(async () => {
        sending = actions.sendPrompt(prompt)
        await vi.waitFor(() => expect(agent.start).toHaveBeenCalledOnce())
      })
    },
    /** Starts the runtime, whose session file is then on disk, and lets the first turn's bookkeeping settle. */
    async startRuntime() {
      catalog = [existing, started]
      await act(async () => {
        start.resolve(startedRuntime)
        await sending
        await new Promise((resolveWait) => setTimeout(resolveWait, 0))
      })
    },
    emit(event: Record<string, unknown>) { emitEvent?.({ runtimeId: startedRuntime.runtimeId, event }) },
  }
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('workspace view identity', () => {
  it('keys the view by the session a workspace opened, or by its new chat', () => {
    act(() => root.render(createElement(WorkspaceProbe, { sessions: [existing] })))
    expect(workspace.viewKey).toBe('new:0')

    act(() => { workspace.activateWorkspace(project, existing) })
    expect(workspace.viewKey).toBe('existing')

    act(() => { workspace.activateWorkspace(project) })
    expect(workspace.viewKey).toBe('new:2')
  })
})

describe('new chat selection', () => {
  it('selects the session a viewed new chat started, keeping its live view, and reads its turns as seen', async () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })
    const generation = workspace.workspaceGeneration

    await app.send('Build the sidebar')
    await app.startRuntime()

    expect(workspace.activeSessionId).toBe('started')
    expect(workspace.workspaceRef.current).toMatchObject({ generation, session: { id: 'started' }, sessionFile: started.filePath })
    // The same mounted view keeps the optimistic turn instead of reloading it.
    expect(workspace.workspaceGeneration).toBe(generation)
    expect(workspace.viewKey).toBe(`new:${generation}`)
    expect(workspace.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(app.read).not.toHaveBeenCalled()

    await act(async () => { app.emit({ type: 'agent_end' }) })
    expect(sessions.find((session) => session.id === 'started')).toMatchObject({ status: 'complete', unread: false })
  })

  it('keeps an adopted chat live transcript while a stale listing briefly drops its session', async () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })

    await app.send('Build the sidebar')
    await app.startRuntime()
    expect(workspace.activeSessionId).toBe('started')
    const live = workspace.messages

    // A listing requested before the harness wrote the file resolves last.
    act(() => { setSessions([existing]) })
    expect(workspace.messages).toBe(live)

    act(() => { setSessions([existing, started]) })
    expect(workspace.messages).toBe(live)
    expect(app.read).not.toHaveBeenCalled()
  })

  it('reads a viewed new chat turn as seen when it ends before the catalog listing renders', () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })
    act(() => { workspace.attachRuntime(startedRuntime, workspace.workspaceGeneration) })

    act(() => {
      setSessions([existing, started])
      app.emit({ type: 'agent_end' })
    })

    expect(workspace.activeSessionId).toBe('started')
    expect(sessions.find((session) => session.id === 'started')).toMatchObject({ status: 'complete', unread: false })
  })

  it('leaves the selection alone when the user switched away before the first prompt was delivered', async () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })

    await app.send('Build the sidebar')
    await act(async () => { await app.actions.selectSession(existing) })
    await app.startRuntime()

    expect(app.agent.command).toHaveBeenCalledWith(startedRuntime.runtimeId, expect.objectContaining({ type: 'prompt', message: 'Build the sidebar' }))
    expect(sessions.map((session) => session.id)).toEqual(['existing', 'started'])
    expect(workspace.activeSessionId).toBe('existing')
    expect(workspace.workspaceRef.current.session?.id).toBe('existing')

    // The background session finishing still asks for the user's attention.
    await act(async () => { app.emit({ type: 'agent_end' }) })
    expect(sessions.find((session) => session.id === 'started')).toMatchObject({ status: 'complete', unread: true })
  })

  it('leaves a second new chat empty when the user opened it before the first prompt was delivered', async () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })

    await app.send('Build the sidebar')
    act(() => { workspace.activateWorkspace(project) })
    const second = workspace.workspaceGeneration
    await app.startRuntime()

    expect(workspace.workspaceGeneration).toBe(second)
    expect(workspace.activeSessionId).toBeUndefined()
    expect(workspace.workspaceRef.current.session).toBeUndefined()

    await act(async () => { app.emit({ type: 'agent_end' }) })
    expect(sessions.find((session) => session.id === 'started')).toMatchObject({ status: 'complete', unread: true })
  })

  it('asks for attention when the user leaves a new chat after it adopted its session', async () => {
    const app = renderApp()
    act(() => { workspace.activateWorkspace(project) })

    await app.send('Build the sidebar')
    await app.startRuntime()
    expect(workspace.activeSessionId).toBe('started')
    await act(async () => { await app.actions.selectSession(existing) })
    expect(workspace.activeSessionId).toBe('existing')

    await act(async () => { app.emit({ type: 'agent_end' }) })
    expect(sessions.find((session) => session.id === 'started')).toMatchObject({ status: 'complete', unread: true })
  })
})
