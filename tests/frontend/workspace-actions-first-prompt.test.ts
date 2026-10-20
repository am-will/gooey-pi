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
  const runtimeIdRef = { current: null as string | null }
  const runtimeOwnerRef = { current: null as { runtimeId: string; generation: number } | null }
  // Mirrors useWorkspaceRuntime: attachment is ignored for a replaced workspace.
  const attachRuntime = (next: RuntimeInfo | undefined, generation: number) => {
    if (workspaceRef.current.generation !== generation) return
    currentRuntime = next ?? null
    runtimeIdRef.current = next?.runtimeId ?? null
    runtimeOwnerRef.current = next ? { runtimeId: next.runtimeId, generation } : null
  }
  const workspace = {
    get runtime() { return currentRuntime },
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    runtimeSessionsRef: { current: new Map<string, string>() },
    prepareForPrompt: () => true,
    attachRuntime,
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
    sessionsList,
    setRuntime,
    setToast,
    settings,
    removeQueuedPrompt: workspace.removeQueuedPrompt,
    markQueuedPromptFlushFailed: workspace.markQueuedPromptFlushFailed,
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
      attachRuntime(undefined, workspaceRef.current.generation)
    },
    /** The agent_end event: the attached runtime goes idle. */
    finishTurn() {
      if (currentRuntime) currentRuntime = { ...currentRuntime, isStreaming: false }
    },
  }
}

/** Runs a new chat's first turn while its workspace stays selected, so the started runtime attaches. */
async function startNewChat(state: ReturnType<typeof fixture>) {
  const sending = state.actions.sendPrompt('Build the sidebar')
  await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
  state.start.resolve(startedRuntime)
  await sending
  expect(state.runtime()?.runtimeId).toBe('started-runtime')
  await vi.waitFor(() => expect(state.sessions().find((item) => item.id === 'started')?.title).toBe('Build the sidebar'))
  state.finishTurn()
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

  it('still starts a new chat for its admitted project when the user switches away before the start', async () => {
    const state = fixture()
    const runtimes = deferred<RuntimeInfo[]>()
    state.agentList.mockImplementation(() => runtimes.promise)

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentList).toHaveBeenCalledOnce())
    state.switchWorkspace()
    runtimes.resolve([])
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.start.resolve(startedRuntime)
    await sending

    expect(state.agentStart).toHaveBeenCalledWith({ cwd: project.primaryFolder, sessionPath: undefined, model: 'auto', thinking: 'medium', fast: false, harness: 'prime' })
    expect(state.command).toHaveBeenCalledWith('started-runtime', expect.objectContaining({ type: 'prompt', message: 'Build the sidebar' }))
    expect(state.messages()).toEqual([])
  })

  it('refuses an existing session prompt that was not sent before the user switched away', async () => {
    const state = fixture({ selectedSession: existingSession })
    const runtimes = deferred<RuntimeInfo[]>()
    state.agentList.mockImplementation(() => runtimes.promise)

    const sending = state.actions.sendPrompt('Continue the plan')
    await vi.waitFor(() => expect(state.agentList).toHaveBeenCalledOnce())
    state.switchWorkspace()
    runtimes.resolve([])

    await expect(sending).rejects.toThrow('The workspace changed before it was sent.')
    expect(state.agentStart).not.toHaveBeenCalled()
    expect(state.command).not.toHaveBeenCalled()
    expect(state.setToast).toHaveBeenCalledWith('Your message for “Existing work” was not delivered. Request failed: The workspace changed before it was sent.')
  })

  it('leaves a queued message in its session when the user switches away before it flushes', async () => {
    const state = fixture({ selectedSession: existingSession })
    const runtimes = deferred<RuntimeInfo[]>()
    state.agentList.mockImplementation(() => runtimes.promise)

    const flushing = state.actions.sendPrompt('Queued follow-up', [], 'queue', 'queued-1')
    await vi.waitFor(() => expect(state.agentList).toHaveBeenCalledOnce())
    state.switchWorkspace()
    runtimes.resolve([])
    await flushing

    expect(state.agentStart).not.toHaveBeenCalled()
    expect(state.removeQueuedPrompt).not.toHaveBeenCalled()
    expect(state.markQueuedPromptFlushFailed).not.toHaveBeenCalled()
    expect(state.setToast).not.toHaveBeenCalled()
  })

  it('refuses a follow-up in a started new chat instead of starting a fresh session after the user switches away', async () => {
    const state = fixture()
    await startNewChat(state)
    const runtimes = deferred<RuntimeInfo[]>()
    state.agentList.mockImplementation(() => runtimes.promise)

    const sending = state.actions.sendPrompt('Add tests too')
    await vi.waitFor(() => expect(state.agentList).toHaveBeenCalledTimes(2))
    state.switchWorkspace()
    runtimes.resolve([startedRuntime])

    await expect(sending).rejects.toThrow('The workspace changed before it was sent.')
    expect(state.agentStart).toHaveBeenCalledOnce()
    expect(state.command).not.toHaveBeenCalledWith('started-runtime', expect.objectContaining({ message: 'Add tests too' }))
    // The toast names the started session, not a title derived from the follow-up.
    expect(state.setToast).toHaveBeenCalledWith('Your message for “Build the sidebar” was not delivered. Request failed: The workspace changed before it was sent.')
  })

  it('leaves a queued message in a started new chat when the user switches away before it flushes', async () => {
    const state = fixture()
    await startNewChat(state)
    const runtimes = deferred<RuntimeInfo[]>()
    state.agentList.mockImplementation(() => runtimes.promise)

    const flushing = state.actions.sendPrompt('Queued follow-up', [], 'queue', 'queued-1')
    await vi.waitFor(() => expect(state.agentList).toHaveBeenCalledTimes(2))
    state.switchWorkspace()
    runtimes.resolve([startedRuntime])
    await flushing

    expect(state.agentStart).toHaveBeenCalledOnce()
    expect(state.command).not.toHaveBeenCalledWith('started-runtime', expect.objectContaining({ message: 'Queued follow-up' }))
    expect(state.removeQueuedPrompt).not.toHaveBeenCalled()
    expect(state.markQueuedPromptFlushFailed).not.toHaveBeenCalled()
    expect(state.setToast).not.toHaveBeenCalled()
  })

  it('still sends the prompt to the started runtime when indexing its session fails', async () => {
    const state = fixture()
    state.sessionsList.mockRejectedValue(new Error('catalog unavailable'))

    const sending = state.actions.sendPrompt('Build the sidebar')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.start.resolve(startedRuntime)
    await sending

    expect(state.stop).not.toHaveBeenCalled()
    expect(state.command).toHaveBeenCalledWith('started-runtime', { type: 'prompt', message: 'Build the sidebar', streamingBehavior: 'followUp' })
    expect(state.runtime()).toEqual({ ...startedRuntime, isStreaming: true })
    expect(state.sessions().map((item) => item.id)).toEqual(['existing', 'other'])
  })

  it('stops a started runtime that serves a different session and reports it', async () => {
    const state = fixture({ selectedSession: existingSession })

    const sending = state.actions.sendPrompt('Continue the plan')
    await vi.waitFor(() => expect(state.agentStart).toHaveBeenCalledOnce())
    state.start.resolve(startedRuntime)

    await expect(sending).rejects.toThrow('Prime Agent returned a runtime for a different workspace or session.')
    expect(state.stop).toHaveBeenCalledWith('started-runtime')
    expect(state.command).not.toHaveBeenCalled()
    expect(state.runtimeSessions.has('started-runtime')).toBe(false)
    expect(state.messages().map((message) => message.role)).toEqual(['system'])
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
