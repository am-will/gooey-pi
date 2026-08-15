import { describe, expect, it, vi } from 'vitest'
import { ScheduledRunExecutor } from '../../electron/main/schedules/executor'
import { ScheduleBlockedError } from '../../electron/main/schedules/service'
import type { AutomationScheduleRecord, PrimeModelDescriptor, RuntimeInfo, ScheduleExecution, ScheduleTarget } from '../../src/types/api'

const project = {
  id: 'project-one',
  inferred: false,
  primaryFolder: '/workspace/project',
  path: '/workspace/project',
  folders: ['/workspace/project', '/workspace/project-linked'],
}

const session = {
  id: 'session-one',
  archived: false,
  projectPath: '/workspace/project',
  filePath: '/sessions/session-one.jsonl',
}

const normalExecution: ScheduleExecution = { model: 'auto', thinking: 'auto', speed: 'normal' }

function task(target: ScheduleTarget = { kind: 'project', projectId: project.id }, execution = normalExecution): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: 'task-one',
    harness: 'prime',
    revision: 1,
    title: 'Safety review',
    prompt: 'Review the release',
    target,
    timing: { kind: 'once', at: '2030-01-01T00:00:00.000Z' },
    execution,
    status: 'active',
    createdBy: 'user',
    createdAt: '2029-01-01T00:00:00.000Z',
    updatedAt: '2029-01-01T00:00:00.000Z',
    runs: [],
  }
}

function runtime(runtimeId = 'runtime-one', overrides: Partial<RuntimeInfo> = {}): RuntimeInfo {
  return {
    runtimeId,
    harness: 'prime',
    cwd: project.primaryFolder,
    isStreaming: false,
    ...overrides,
  }
}

function model(overrides: Partial<PrimeModelDescriptor> = {}): PrimeModelDescriptor {
  return {
    key: 'provider/model',
    provider: 'provider',
    id: 'model',
    name: 'Test model',
    reasoning: true,
    input: ['text'],
    contextWindow: 100_000,
    maxTokens: 10_000,
    availableThinkingLevels: ['low', 'high'],
    fastModeSupported: true,
    available: true,
    ...overrides,
  }
}

function fixture() {
  const projects = {
    list: vi.fn(async () => [project]),
    authorizeCwd: vi.fn(async (cwd: string) => cwd),
  }
  const sessions = {
    list: vi.fn(async () => [session]),
    requireSessionPath: vi.fn(async () => session.filePath),
  }
  const agents = {
    startUnattended: vi.fn(async () => runtime()),
    command: vi.fn(async () => undefined),
    runPromptToCompletion: vi.fn(async () => ({ sessionId: 'completed-session', sessionFile: '/sessions/completed.jsonl' })),
    stop: vi.fn(async () => undefined),
    getForSession: vi.fn(() => undefined as RuntimeInfo | undefined),
    list: vi.fn(() => [] as RuntimeInfo[]),
  }
  const providers = { requireAvailableModel: vi.fn(async () => model()) }
  const disabledProviders = vi.fn(() => new Set(['disabled-provider']))
  const disabledModels = vi.fn(() => new Set(['disabled/model']))
  const executor = new ScheduledRunExecutor(projects as never, sessions as never, agents as never, providers as never, disabledProviders, disabledModels)
  return { executor, projects, sessions, agents, providers, disabledProviders, disabledModels }
}

describe('ScheduledRunExecutor', () => {
  it('authorizes current project and session targets and blocks stale authority', async () => {
    const { executor, projects, sessions } = fixture()
    await expect(executor.validateTarget({ kind: 'project', projectId: project.id })).resolves.toBeUndefined()
    expect(projects.authorizeCwd).toHaveBeenCalledWith(project.primaryFolder)

    await expect(executor.validateTarget({ kind: 'session', projectId: project.id, sessionId: session.id })).resolves.toBeUndefined()
    expect(sessions.list).toHaveBeenCalledWith(undefined, true)
    expect(sessions.requireSessionPath).toHaveBeenCalledWith(session.filePath)

    projects.list.mockResolvedValueOnce([])
    await expect(executor.validateTarget({ kind: 'project', projectId: 'removed' })).rejects.toThrow(/no longer available/)
    projects.list.mockResolvedValueOnce([{ ...project, inferred: true }])
    await expect(executor.validateTarget({ kind: 'project', projectId: project.id })).rejects.toThrow(/Grant this inferred project/)
    sessions.list.mockResolvedValueOnce([])
    await expect(executor.validateTarget({ kind: 'session', projectId: project.id, sessionId: 'removed' })).rejects.toThrow(/thread is no longer available/)
    sessions.list.mockResolvedValueOnce([{ ...session, archived: true }])
    await expect(executor.validateTarget({ kind: 'session', projectId: project.id, sessionId: session.id })).rejects.toThrow(/Restore the archived thread/)
    sessions.list.mockResolvedValueOnce([{ ...session, projectPath: '/outside' }])
    await expect(executor.validateTarget({ kind: 'session', projectId: project.id, sessionId: session.id })).rejects.toThrow(/no longer belongs/)
  })

  it('validates explicit model, reasoning, and fast-mode requirements against current visibility', async () => {
    const { executor, providers, disabledProviders, disabledModels } = fixture()
    await expect(executor.validateExecution(normalExecution)).resolves.toBeUndefined()
    expect(providers.requireAvailableModel).not.toHaveBeenCalled()

    const explicit: ScheduleExecution = { model: 'provider/model', thinking: 'high', speed: 'fast' }
    await expect(executor.validateExecution(explicit)).resolves.toBeUndefined()
    expect(providers.requireAvailableModel).toHaveBeenCalledWith('provider/model', disabledProviders(), disabledModels())

    providers.requireAvailableModel.mockResolvedValueOnce(model({ availableThinkingLevels: ['low'] }))
    await expect(executor.validateExecution(explicit)).rejects.toThrow(/does not support high reasoning/)
    providers.requireAvailableModel.mockResolvedValueOnce(model({ fastModeSupported: false }))
    await expect(executor.validateExecution(explicit)).rejects.toThrow(/does not support Fast mode/)
  })

  it('runs a project task unattended, applies a bounded title, and always stops its runtime', async () => {
    const { executor, agents } = fixture()
    const result = await executor.run(task())

    expect(agents.startUnattended).toHaveBeenCalledWith({ cwd: project.primaryFolder, sessionPath: undefined, model: undefined, thinking: undefined, fast: false })
    expect(agents.command).toHaveBeenCalledWith('runtime-one', { type: 'set_session_name', name: expect.stringMatching(/^Safety review · /) })
    expect(agents.runPromptToCompletion).toHaveBeenCalledWith('runtime-one', 'Review the release')
    expect(agents.stop).toHaveBeenCalledWith('runtime-one')
    expect(result).toEqual({ sessionId: 'completed-session', sessionFile: '/sessions/completed.jsonl' })

    agents.command.mockRejectedValueOnce(new Error('title command unsupported'))
    await expect(executor.run(task())).resolves.toEqual(result)
  })

  it('enforces the runtime result and maps active-session lease failures to a blocked task', async () => {
    const { executor, agents } = fixture()
    agents.startUnattended.mockResolvedValueOnce(runtime('fast-mismatch', { serviceTier: 'default' }))
    await expect(executor.run(task(undefined, { model: 'auto', thinking: 'auto', speed: 'fast' }))).rejects.toThrow(/Fast mode is unavailable/)
    expect(agents.stop).toHaveBeenCalledWith('fast-mismatch')

    agents.startUnattended.mockResolvedValueOnce(runtime('thinking-mismatch', { thinkingLevel: 'low' }))
    await expect(executor.run(task(undefined, { model: 'auto', thinking: 'high', speed: 'normal' }))).rejects.toThrow(/reasoning level high could not be applied/)
    expect(agents.stop).toHaveBeenCalledWith('thinking-mismatch')

    agents.runPromptToCompletion.mockRejectedValueOnce(new Error('session lease already active'))
    const leaseError = await executor.run(task({ kind: 'session', projectId: project.id, sessionId: session.id })).catch((error: unknown) => error)
    expect(leaseError).toBeInstanceOf(ScheduleBlockedError)
    expect(leaseError).toMatchObject({ message: 'The thread is active in another client. Close it there or use inherited thread settings.' })
  })

  it('stops an idle live runtime before resuming its session and serializes same-session runs', async () => {
    const { executor, agents } = fixture()
    const sessionTask = task({ kind: 'session', projectId: project.id, sessionId: session.id })
    agents.getForSession.mockReturnValueOnce(runtime('interactive-runtime'))
    agents.list.mockReturnValueOnce([runtime('interactive-runtime')])
    await executor.run(sessionTask)
    expect(agents.stop.mock.calls[0]).toEqual(['interactive-runtime'])
    expect(agents.startUnattended).toHaveBeenCalledWith(expect.objectContaining({ cwd: project.primaryFolder, sessionPath: session.filePath }))

    agents.getForSession.mockReturnValue(undefined)
    agents.startUnattended.mockReset()
    agents.startUnattended.mockResolvedValueOnce(runtime('serialized-one')).mockResolvedValueOnce(runtime('serialized-two'))
    let releaseFirst: (value: { sessionId: string; sessionFile: string }) => void = () => undefined
    agents.runPromptToCompletion.mockReset()
    agents.runPromptToCompletion
      .mockImplementationOnce(
        () =>
          new Promise((resolveRun) => {
            releaseFirst = resolveRun
          }),
      )
      .mockResolvedValueOnce({ sessionId: 'second', sessionFile: '/sessions/second.jsonl' })

    const first = executor.run(sessionTask)
    const second = executor.run(sessionTask)
    await vi.waitFor(() => expect(agents.startUnattended).toHaveBeenCalledTimes(1))
    releaseFirst({ sessionId: 'first', sessionFile: '/sessions/first.jsonl' })
    await expect(first).resolves.toMatchObject({ sessionId: 'first' })
    await expect(second).resolves.toMatchObject({ sessionId: 'second' })
    expect(agents.startUnattended).toHaveBeenCalledTimes(2)
  })
})
