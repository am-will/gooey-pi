import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { PrimeWorkApi, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const project = {
  id: 'compact-project',
  harness: 'prime' as const,
  name: 'Compact project',
  path: '/compact-project',
  folders: ['/compact-project'],
  primaryFolder: '/compact-project',
  pinned: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 1,
}

const session = (status: SessionRecord['status'] = 'idle'): SessionRecord => ({
  id: 'compact-session',
  harness: 'prime',
  filePath: '/compact-project/session.jsonl',
  projectPath: '/compact-project',
  title: 'Compact session',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status,
  depth: 0,
})

const runtime = (runtimeId = 'idle-runtime', isStreaming = false): RuntimeInfo => ({
  runtimeId,
  harness: 'prime',
  cwd: project.primaryFolder,
  sessionFile: session().filePath,
  isStreaming,
})

interface FixtureOptions {
  runtime?: RuntimeInfo | null
  sessionStatus?: SessionRecord['status']
  ownsStreaming?: boolean
  withSession?: boolean
}

function fixture({ runtime: configuredRuntime = null, sessionStatus = 'idle', ownsStreaming = false, withSession = true }: FixtureOptions = {}) {
  let currentRuntime = configuredRuntime
  let messages: TranscriptMessage[] = []
  const currentSession = withSession ? session(sessionStatus) : undefined
  const workspaceRef = {
    current: {
      generation: 1,
      project,
      session: currentSession,
      cwd: project.primaryFolder,
      sessionFile: currentSession?.filePath,
    },
  }
  const runtimeIdRef = { current: ownsStreaming && configuredRuntime ? configuredRuntime.runtimeId : null as string | null }
  const runtimeOwnerRef = {
    current: ownsStreaming && configuredRuntime
      ? { runtimeId: configuredRuntime.runtimeId, generation: 1 }
      : null as { runtimeId: string; generation: number } | null,
  }
  const command = vi.fn(async () => ({}))
  const start = vi.fn(async () => runtime('started-runtime'))
  const followUp = vi.fn(async () => true)
  const queuePrompt = vi.fn()
  const setToast = vi.fn()
  const reportError = vi.fn()
  const workspace = {
    runtime: currentRuntime,
    workspaceRef,
    runtimeIdRef,
    runtimeOwnerRef,
    prepareForPrompt: () => true,
    attachRuntime: (next: RuntimeInfo | undefined) => { currentRuntime = next ?? null },
    setRuntime: (next: RuntimeInfo | ((current: RuntimeInfo | null) => RuntimeInfo | null)) => {
      currentRuntime = typeof next === 'function' ? next(currentRuntime) : next
    },
    setMessages: (next: TranscriptMessage[] | ((current: TranscriptMessage[]) => TranscriptMessage[])) => {
      messages = typeof next === 'function' ? next(messages) : next
    },
    queuePrompt,
    removeQueuedPrompt: vi.fn(),
    markQueuedPromptFlushFailed: vi.fn(),
  }
  const agentList = vi.fn(async () => configuredRuntime ? [configuredRuntime] : [])
  const bridge = {
    agent: { list: agentList, command, start, stop: vi.fn(async () => false) },
    sessions: { followUp },
  } as unknown as PrimeWorkApi
  const workspaceSessions = currentSession ? [currentSession] : []
  const actions = createWorkspaceActions(() => ({
    bridge,
    projects: [project],
    sessions: workspaceSessions,
    activeProject: project,
    workspace,
    settingsState: { settings: { activeHarness: 'prime' } },
    provider: { model: 'auto', effort: 'medium', fast: false },
    submissionAdmissionRef: { current: { active: false, run: async (task: () => Promise<void>) => { await task(); return true } } },
    initialized: true,
    layout: {},
    pluginSkills: {},
    gitRequestRef: { current: 0 },
    demoTimerRef: { current: [] },
    setProjects: vi.fn(),
    setSessions: vi.fn(),
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

  return { actions, command, start, followUp, queuePrompt, setToast, reportError, messages: () => messages }
}

describe('/compact dispatch', () => {
  it('sends compact to an idle runtime without a prompt command or user message', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.command).toHaveBeenCalledOnce()
    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact' })
    expect(fixtureState.command).not.toHaveBeenCalledWith('idle-runtime', expect.objectContaining({ type: 'prompt' }))
    expect(fixtureState.messages().filter((message) => message.role === 'user')).toHaveLength(0)
  })

  it('passes custom instructions to compact', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact focus on auth')

    expect(fixtureState.command).toHaveBeenCalledWith('idle-runtime', { type: 'compact', customInstructions: 'focus on auth' })
  })

  it('queues compact for an owned streaming runtime', async () => {
    const fixtureState = fixture({ runtime: runtime('streaming-runtime', true), ownsStreaming: true })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'queue')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })

  it('does not start a runtime when there is nothing to compact', async () => {
    const fixtureState = fixture({ withSession: false })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Nothing to compact yet.')
  })

  it('does not follow up an externally running session', async () => {
    const fixtureState = fixture({ sessionStatus: 'running' })

    await fixtureState.actions.sendPrompt('/compact')

    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction is unavailable while this session is running outside GooeyPi.')
  })

  it('rejects image attachments', async () => {
    const fixtureState = fixture({ runtime: runtime() })

    await fixtureState.actions.sendPrompt('/compact', [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }])

    expect(fixtureState.reportError).toHaveBeenCalledWith('/compact does not accept attachments. Remove the attachment and try again.')
    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.start).not.toHaveBeenCalled()
  })

  it('queues compact for a non-owned streaming runtime instead of steering it', async () => {
    const fixtureState = fixture({ runtime: runtime('external-streaming-runtime', true) })

    await fixtureState.actions.sendPrompt('/compact', [], 'steer')

    expect(fixtureState.command).not.toHaveBeenCalled()
    expect(fixtureState.followUp).not.toHaveBeenCalled()
    expect(fixtureState.queuePrompt).toHaveBeenCalledWith('/compact', 'steer')
    expect(fixtureState.setToast).toHaveBeenCalledWith('Compaction will run when the current turn finishes.')
  })
})
