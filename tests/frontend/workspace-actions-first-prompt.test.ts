import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { HarnessId, PrimeWorkApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

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

const project = {
  id: 'first-prompt-project',
  harness: 'prime' as const,
  name: 'First prompt project',
  path: '/first-prompt',
  folders: ['/first-prompt'],
  primaryFolder: '/first-prompt',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 2,
}

const session = (id: string, title: string): SessionRecord => ({
  id,
  harness: 'prime',
  filePath: `/first-prompt/${id}.jsonl`,
  projectPath: project.primaryFolder,
  title,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const existingSession = session('existing', 'Existing work')
const otherSession = session('other', 'Somewhere else')
const startedSession = session('started', 'Untitled session')
const startedRuntime: RuntimeInfo = {
  runtimeId: 'started-runtime',
  harness: 'prime',
  cwd: project.primaryFolder,
  sessionFile: startedSession.filePath,
  isStreaming: false,
}

function fixture({ selectedSession }: { selectedSession?: SessionRecord } = {}) {
  let currentRuntime: RuntimeInfo | null = null
  let messages: TranscriptMessage[] = []
  let sessions: SessionRecord[] = [existingSession, otherSession]
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: selectedSession,
      cwd: project.primaryFolder,
      sessionFile: selectedSession?.filePath,
    },
  }
  const settings: { activeHarness: HarnessId } = { activeHarness: 'prime' }
  const start = deferred<RuntimeInfo>()
  const agentStart = vi.fn(() => start.promise)
  const agentList = vi.fn(async (): Promise<RuntimeInfo[]> => [])
  const command = vi.fn(async (_runtimeId: string, _command: Record<string, unknown>): Promise<Record<string, unknown>> => ({}))
  const stop = vi.fn(async () => true)
  const sessionsList = vi.fn(async () => [existingSession, otherSession, startedSession])
  const setRuntime = vi.fn((next: RuntimeInfo | null | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
    currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
  })
  const setToast = vi.fn()
  const reportError = vi.fn()
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef: { current: null as string | null },
    runtimeOwnerRef: { current: null as { runtimeId: string; generation: number } | null },
    runtimeSessionsRef: { current: new Map<string, string>() },
    prepareForPrompt: () => true,
    // Mirrors useWorkspaceRuntime: attachment is ignored for a replaced workspace.
    attachRuntime: (next: RuntimeInfo | undefined, generation: number) => {
      if (workspaceRef.current.generation === generation) currentRuntime = next ?? null
    },
    setRuntime,
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt: vi.fn(),
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
  }
  const bridge = {
    agent: { list: agentList, start: agentStart, command, stop },
    sessions: { list: sessionsList, followUp: vi.fn(async () => false) },
  } as unknown as PrimeWorkApi
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions,
    activeProject: project,
    workspace,
    settingsState: { settings },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: { active: false, run: async (task: () => Promise<void>) => { await task(); return true } } },
    initialized: true,
    layout: {},
    pluginSkills: {},
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions: (update: SessionRecord[] | ((current: SessionRecord[]) => SessionRecord[])) => {
      sessions = typeof update === 'function' ? update(sessions) : update
    },
    setGitSnapshot: vi.fn(),
    setView: vi.fn(),
    setPaletteOpen: vi.fn(),
    setToast,
    setSubmitting: vi.fn(),
    refreshSchedules: vi.fn(),
    refreshHeartbeats: vi.fn(),
    resetBrowserView: vi.fn(),
    closeTerminalForSession: vi.fn(),
    clearSessionAttention: vi.fn(),
    reportError,
  } as unknown as WorkspaceActionsDeps))

  return {
    actions,
    start,
    agentStart,
    agentList,
    command,
    stop,
    setRuntime,
    setToast,
    settings,
    runtimeSessions: workspace.runtimeSessionsRef.current,
    runtime: () => currentRuntime,
    messages: () => messages,
    sessions: () => sessions,
    switchWorkspace() {
      workspaceRef.current = {
        generation: workspaceRef.current.generation + 1,
        project,
        session: otherSession,
        cwd: project.primaryFolder,
        sessionFile: otherSession.filePath,
      }
    },
  }
}

describe('first prompt delivery across a workspace switch', () => {
  it('keeps delivering a new chat to the runtime it started after the user switches away', async () => {
    const state = fixture()

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.switchWorkspace()
    state.start.resolve(startedRuntime)
    await sending

    expect(state.stop).not.toHaveBeenCalled()
    expect(state.command).toHaveBeenCalledWith('started-runtime', { type: 'prompt', message: 'Build the sidebar', streamingBehavior: 'followUp' })
    expect(state.runtimeSessions.get('started-runtime')).toBe(startedSession.filePath)
    await vi.waitFor(() => expect(state.command).toHaveBeenCalledWith('started-runtime', { type: 'set_session_name', name: 'Build the sidebar' }))
    await vi.waitFor(() => expect(state.sessions().find((item) => item.id === 'started')?.title).toBe('Build the sidebar'))
    // The visible workspace now belongs to another session.
    expect(state.runtime()).toBeNull()
    expect(state.setRuntime).not.toHaveBeenCalled()
    expect(state.messages()).toEqual([])
  })

  it('reports a detached delivery failure by naming the session instead of writing a transcript row', async () => {
    const state = fixture()
    state.command.mockImplementation(async (_runtimeId, request) => {
      if (request.type === 'prompt') throw new Error('runtime went away')
      return {}
    })

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.switchWorkspace()
    state.start.resolve(startedRuntime)

    await expect(sending).rejects.toThrow('runtime went away')
    expect(state.setToast).toHaveBeenCalledWith('Your message for “Build the sidebar” was not delivered. Request failed: runtime went away')
    expect(state.messages()).toEqual([])
    expect(state.stop).not.toHaveBeenCalled()
  })

  it('does not merge the started session into another harness catalog', async () => {
    const state = fixture()

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.switchWorkspace()
    state.settings.activeHarness = 'omp'
    state.start.resolve(startedRuntime)
    await sending

    expect(state.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'prompt' }))
    expect(state.sessions().map((item) => item.id)).toEqual(['existing', 'other'])
  })

  it('attaches the started runtime and shows the prompt while its workspace stays selected', async () => {
    const state = fixture()

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.start.resolve(startedRuntime)
    await sending

    expect(state.runtime()).toEqual({ ...startedRuntime, isStreaming: true })
    expect(state.messages().map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.sessions().map((item) => item.id)).toEqual(['existing', 'other', 'started'])
  })
})
