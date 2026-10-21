import { describe, expect, it, vi } from 'vitest'
import { ScheduledRunExecutor } from '../../electron/main/schedules/executor'
import { ScheduleBlockedError } from '../../electron/main/schedules/service'
import type { AutomationScheduleRecord, HarnessId, ProjectRecord, SessionRecord, RuntimeInfo } from '../../src/types/api'

function task(harness: HarnessId, prompt: string): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: `task-${harness}`,
    harness,
    revision: 1,
    title: 'MCP policy probe',
    prompt,
    target: { kind: 'project', projectId: `project-${harness}` },
    timing: { kind: 'once', at: '2026-08-15T22:00:00.000Z' },
    execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    status: 'active',
    createdBy: 'user',
    createdAt: '2026-08-15T21:00:00.000Z',
    updatedAt: '2026-08-15T21:00:00.000Z',
    runs: [],
  }
}

describe('ScheduledRunExecutor MCP auth policy', () => {
  it.each([
    ['prime', '/mcp login notion'],
    ['omp', '/mcp reauth docs'],
    ['pi', '/mcp-auth files'],
  ] as const)('rejects a persisted %s auth task before project lookup or runtime start', async (harness, prompt) => {
    const projects = { list: vi.fn(), authorizeCwd: vi.fn() }
    const sessions = { harness, list: vi.fn(), requireSessionPath: vi.fn() }
    const agents = { startUnattended: vi.fn() }
    const providers = { requireAvailableModel: vi.fn() }
    const executor = new ScheduledRunExecutor(projects as never, sessions as never, agents as never, providers as never, () => new Set())

    const result = executor.run(task(harness, prompt))
    await expect(result).rejects.toBeInstanceOf(ScheduleBlockedError)
    await expect(result).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(projects.list).not.toHaveBeenCalled()
    expect(agents.startUnattended).not.toHaveBeenCalled()
  })
})

function fixture() {
  const project: ProjectRecord = {
    id: 'project-prime', harness: 'prime' as const, name: 'Project', path: '/project', folders: ['/project', '/extra'],
    primaryFolder: '/project', pinned: false, createdAt: '', lastOpenedAt: '', sessionCount: 1,
  }
  const session: SessionRecord = {
    id: 'session-one', harness: 'prime' as const, filePath: '/sessions/one.jsonl', projectPath: '/project', title: 'Thread',
    createdAt: '', updatedAt: '', status: 'idle' as const, depth: 0, archived: false,
  }
  const runtime: RuntimeInfo = { runtimeId: 'scheduled', harness: 'prime' as const, cwd: '/project', isStreaming: false }
  const projects = { list: vi.fn(async () => [project]), authorizeCwd: vi.fn(async (cwd: unknown) => String(cwd)) }
  const sessions = { harness: 'prime' as const, list: vi.fn(async () => [session]), requireSessionPath: vi.fn(async (value: unknown) => String(value)) }
  const agents = {
    startUnattended: vi.fn(async () => runtime), command: vi.fn(async () => ({})),
    runPromptToCompletion: vi.fn(async () => ({ ...runtime, sessionId: 'session-one', sessionFile: session.filePath })),
    getForSession: vi.fn<() => typeof runtime | undefined>(() => undefined),
    list: vi.fn(() => [runtime]), stop: vi.fn(async () => true),
  }
  const providers = { requireAvailableModel: vi.fn() }
  const executor = new ScheduledRunExecutor(projects as never, sessions as never, agents as never, providers as never, () => new Set())
  const scheduled = { ...task('prime', 'Review changes'), target: { kind: 'session' as const, projectId: project.id, sessionId: session.id } }
  return { executor, projects, sessions, agents, runtime, session, scheduled }
}

describe('ScheduledRunExecutor target ownership and cleanup', () => {
  it.each(['listen EADDRINUSE: address already in use', 'Prime RPC exited (1): Please run prime-agent login'])('keeps an unrelated failure retryable: %s', async (message) => {
    const { executor, agents, scheduled } = fixture()
    agents.runPromptToCompletion.mockRejectedValueOnce(new Error(message))
    const failure = executor.run(scheduled)
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.not.toBeInstanceOf(ScheduleBlockedError)
    expect(agents.stop).toHaveBeenCalledWith('scheduled')
  })

  it('recognizes the actual external session lease conflict without stopping an unowned runtime', async () => {
    const { executor, agents, scheduled } = fixture()
    agents.startUnattended.mockRejectedValueOnce(new Error('Prime RPC exited (1): Session is already active in GooeyPi: Or wait: the file unlocks when that session exits.'))
    await expect(executor.run(scheduled)).rejects.toBeInstanceOf(ScheduleBlockedError)
    expect(agents.stop).not.toHaveBeenCalled()
  })

  it('rejects missing or inferred project authorization before starting a runtime', async () => {
    const { executor, projects, agents, scheduled } = fixture()
    projects.list.mockResolvedValueOnce([])
    await expect(executor.run(scheduled)).rejects.toThrow('no longer available')
    projects.list.mockResolvedValueOnce([{ ...(await projects.list())[0], inferred: true }])
    await expect(executor.run(scheduled)).rejects.toThrow('inferred project')
    expect(agents.startUnattended).not.toHaveBeenCalled()
  })

  it('preserves the archived-thread restriction and rejects cross-project sessions', async () => {
    const { executor, sessions, session, agents, scheduled } = fixture()
    sessions.list.mockResolvedValueOnce([{ ...session, archived: true }])
    await expect(executor.run(scheduled)).rejects.toThrow('Restore the archived thread')
    sessions.list.mockResolvedValueOnce([{ ...session, projectPath: '/unrelated' }])
    await expect(executor.run(scheduled)).rejects.toThrow('no longer belongs')
    expect(agents.startUnattended).not.toHaveBeenCalled()
  })

  it('waits for queued follow-ups before replacing a resident runtime', async () => {
    vi.useFakeTimers()
    const { executor, agents, runtime, scheduled } = fixture()
    const existing = { ...runtime, runtimeId: 'existing' }
    agents.getForSession.mockReturnValue(existing)
    agents.list.mockReturnValueOnce([{ ...existing, sessionActions: { queuedCount: 1, steering: [], followUps: ['queued work'] } }]).mockReturnValue([existing])
    try {
      const running = executor.run(scheduled)
      await vi.advanceTimersByTimeAsync(0)
      expect(agents.stop).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      await running
      expect(agents.stop).toHaveBeenNthCalledWith(1, 'existing')
      expect(agents.stop).toHaveBeenNthCalledWith(2, 'scheduled')
    } finally { vi.useRealTimers() }
  })

  it('authorizes an explicitly granted secondary project folder', async () => {
    const { executor, sessions, session, projects, scheduled } = fixture()
    sessions.list.mockResolvedValueOnce([{ ...session, projectPath: '/extra' }])
    await expect(executor.run(scheduled)).resolves.toMatchObject({ sessionId: 'session-one' })
    expect(projects.authorizeCwd).toHaveBeenCalledWith('/extra')
  })
})
