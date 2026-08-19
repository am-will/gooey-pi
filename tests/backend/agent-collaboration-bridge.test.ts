import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentCollaborationBridge } from '../../electron/main/collaboration/agent-bridge'
import { configureGooeyPiAgentMessageSigning, parseGooeyPiAgentMessage } from '../../electron/main/collaboration/message-envelope'
import type { AgentRpcManager } from '../../electron/main/agent-rpc'
import type { HarnessId, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../src/types/api'

const bridges: AgentCollaborationBridge[] = []
configureGooeyPiAgentMessageSigning(Buffer.alloc(32, 7))

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})

const source: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000001', harness: 'prime', filePath: '/sessions/source.jsonl', projectPath: '/project', title: 'Planner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'running', depth: 0,
}
const target: SessionRecord = {
  id: '019f0000-0000-7000-8000-000000000002', harness: 'prime', filePath: '/sessions/target.jsonl', projectPath: '/project', title: 'API owner',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', status: 'idle', depth: 0,
}
const foreign: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000003', filePath: '/sessions/foreign.jsonl', projectPath: '/other', title: 'Other project',
}
const child: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000004', filePath: '/sessions/child.jsonl', title: 'Child agent', depth: 1,
}
const archived: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000005', filePath: '/sessions/archived.jsonl', title: 'Archived peer', archived: true,
}
const created: SessionRecord = {
  ...target, id: '019f0000-0000-7000-8000-000000000006', filePath: '/sessions/created.jsonl', title: 'Model reviewer', status: 'running',
}

function service(records: SessionRecord[], transcripts: Record<string, TranscriptMessage[]> = {}) {
  return {
    list: vi.fn(async (_projectPath?: unknown, includeArchived?: unknown) => includeArchived ? records : records.filter((record) => !record.archived)),
    read: vi.fn(async (filePath: unknown) => transcripts[String(filePath)] ?? []),
  }
}

function manager(runtime?: RuntimeInfo, onCreate?: () => void) {
  let current = runtime
  return {
    getForSession: vi.fn((filePath: string) => current?.sessionFile === filePath ? current : undefined),
    start: vi.fn(async ({ cwd, sessionPath, model, fast }: { cwd: string; sessionPath?: string; model?: string; fast?: boolean }) => {
      if (sessionPath) current = { runtimeId: 'runtime-awakened', harness: target.harness, sessionId: target.id, sessionFile: sessionPath, cwd, isStreaming: false }
      else {
        onCreate?.()
        const fastModeSupported = model === 'openai-codex/gpt-5.6-sol'
        current = {
          runtimeId: 'runtime-created', harness: created.harness, sessionId: created.id, sessionFile: created.filePath, cwd, isStreaming: false,
          availableThinkingLevels: ['low', 'high'], fastModeSupported,
          ...(fast ? { fastModeAvailable: fastModeSupported, serviceTier: fastModeSupported ? 'priority' : 'default' } : {}),
        }
      }
      return current
    }),
    command: vi.fn(async () => ({ ok: true })),
    list: vi.fn(() => current ? [current] : []),
    stop: vi.fn(async () => true),
  }
}

const defaultTargetTranscript: TranscriptMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Implement the API.' }] },
  { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'The endpoint is ready.' }] },
]

interface ScheduledFakeTimer {
  callback: () => void
  requestedAt: number
  delayMs: number
  dueAt: number
  unref: () => void
}

class FakeCollaborationWaitClock {
  private readonly pending: ScheduledFakeTimer[] = []
  private readonly waiters: Array<(timer: ScheduledFakeTimer) => void> = []

  constructor(private currentTime = 10_000) {}

  readonly now = (): number => this.currentTime

  readonly setTimeout = (callback: () => void, delayMs: number): { unref(): void } => {
    const timer: ScheduledFakeTimer = {
      callback,
      requestedAt: this.currentTime,
      delayMs,
      dueAt: this.currentTime + delayMs,
      unref: vi.fn(),
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(timer)
    else this.pending.push(timer)
    return { unref: timer.unref }
  }

  takeNextTimer(): Promise<ScheduledFakeTimer> {
    const timer = this.pending.shift()
    if (timer) return Promise.resolve(timer)
    return new Promise((resolveTimer) => this.waiters.push(resolveTimer))
  }

  fireAt(timer: ScheduledFakeTimer, timestamp: number): void {
    this.currentTime = timestamp
    timer.callback()
  }
}

async function fixture(
  live = true,
  targetTranscript: TranscriptMessage[] = defaultTargetTranscript,
  waitClock?: FakeCollaborationWaitClock,
) {
  const records = [source, target, foreign, child, archived]
  const primeSessions = service(records, {
    [target.filePath]: targetTranscript,
  })
  const targetRuntime: RuntimeInfo | undefined = live ? {
    runtimeId: 'runtime-target', harness: 'prime', sessionId: target.id, sessionFile: target.filePath, cwd: '/project', isStreaming: false,
  } : undefined
  const primeManager = manager(targetRuntime, () => records.push(created))
  const emptySessions = service([])
  const emptyManager = manager()
  const bridge = new AgentCollaborationBridge({
    extensionPath: '/app/extensions/omp-work-collaboration.ts',
    sessions: { prime: primeSessions, omp: emptySessions, pi: emptySessions },
    agents: { prime: primeManager as unknown as AgentRpcManager, omp: emptyManager as unknown as AgentRpcManager, pi: emptyManager as unknown as AgentRpcManager },
    catalogs: {
      prime: {
        catalog: vi.fn(async (_force = false, disabled: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()) => ({
          primeVersion: 'test', refreshedAt: '2026-01-01T00:00:00.000Z',
          providers: [
            { id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'oauth' as const, configured: true, modelCount: 1, availableModelCount: 1, enabled: !disabled.has('openai-codex') },
            { id: 'hidden', name: 'Hidden', authMethod: 'api_key' as const, configured: true, modelCount: 1, availableModelCount: 1, enabled: !disabled.has('hidden') },
          ],
          models: [{
            key: 'openai-codex/gpt-5.6-sol', provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol',
            reasoning: true, input: ['text'] as const, contextWindow: 128_000, maxTokens: 16_000,
            availableThinkingLevels: ['low', 'high', 'max'] as const, fastModeSupported: true, available: true, enabled: !disabledModels.has('openai-codex/gpt-5.6-sol'),
          }, {
            key: 'hidden/secret', provider: 'hidden', id: 'secret', name: 'Secret', reasoning: true, input: ['text'] as const,
            contextWindow: 128_000, maxTokens: 16_000, availableThinkingLevels: ['high'] as const, fastModeSupported: false, available: true, enabled: !disabledModels.has('hidden/secret'),
          }, {
            key: 'openai-codex/desktop-hidden', provider: 'openai-codex', id: 'desktop-hidden', name: 'Desktop Hidden', reasoning: false, input: ['text'] as const,
            contextWindow: 128_000, maxTokens: 16_000, availableThinkingLevels: ['off'] as const, fastModeSupported: false, available: true, enabled: !disabledModels.has('openai-codex/desktop-hidden'),
          }],
        })),
      },
      omp: { catalog: vi.fn(async () => ({ primeVersion: 'test', refreshedAt: '', providers: [], models: [] })) },
      pi: { catalog: vi.fn(async () => ({ primeVersion: 'test', refreshedAt: '', providers: [], models: [] })) },
    } as unknown as ConstructorParameters<typeof AgentCollaborationBridge>[0]['catalogs'],
    disabledProviders: { prime: () => new Set(['hidden']), omp: () => new Set(), pi: () => new Set() },
    disabledModels: { prime: () => new Set(['openai-codex/desktop-hidden']), omp: () => new Set(), pi: () => new Set() },
    ...(waitClock ? { waitClock } : {}),
  })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: source.filePath, harness: 'prime' })
  const call = async (method: string, params: Record<string, unknown> = {}, token = environment.GOOEYPI_COLLABORATION_TOKEN) => {
    const response = await fetch(environment.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: Record<string, unknown> | Array<Record<string, unknown>>; error?: string } }
  }
  return { bridge, call, environment, primeManager, primeSessions }
}

describe('AgentCollaborationBridge', () => {
  it('revokes a runtime claim and clears its cached and pending session bindings', async () => {
    const { bridge, call, environment } = await fixture()
    const token = environment.GOOEYPI_COLLABORATION_TOKEN!
    const active = bridge.environmentFor({ cwd: '/project', sessionPath: source.filePath, harness: 'prime' })
    await expect(call('list')).resolves.toMatchObject({ status: 200 })
    bridge.bindSession(token, undefined, 'runtime-pending')

    const state = bridge as unknown as {
      sourcesByToken: Map<string, unknown>
      pendingRuntimeTokens: Map<string, string>
    }
    expect(state.sourcesByToken.has(token)).toBe(true)
    expect(state.pendingRuntimeTokens.get('runtime-pending')).toBe(token)

    expect(bridge.revoke(token)).toBe(true)
    expect(bridge.revoke(token)).toBe(false)
    expect(state.sourcesByToken.has(token)).toBe(false)
    expect(state.pendingRuntimeTokens.has('runtime-pending')).toBe(false)
    bridge.bindSession(token, undefined, 'runtime-late')
    expect(state.pendingRuntimeTokens.has('runtime-late')).toBe(false)
    await expect(call('list')).resolves.toMatchObject({ status: 401 })
    await expect(call('list', {}, active.GOOEYPI_COLLABORATION_TOKEN)).resolves.toMatchObject({ status: 200 })
  })

  it('lists and reads only same-project peers through bounded snapshots', async () => {
    const { call, environment } = await fixture()
    expect(environment.GOOEYPI_COLLABORATION_EXTENSION_PATH).toBe('/app/extensions/omp-work-collaboration.ts')
    const listed = await call('list')
    expect(listed.status).toBe(200)
    expect(listed.body.result).toEqual([expect.objectContaining({ id: target.id, title: 'API owner', live: true })])

    const read = await call('read', { target_session_id: target.id })
    expect(read.status).toBe(200)
    expect(read.body.result).toMatchObject({
      session: { id: target.id, harness: 'prime' },
      live: true,
      estimated_tokens: expect.any(Number),
      token_limit: 30_000,
      truncated: false,
    })
    expect(JSON.stringify(read.body.result)).toContain('The endpoint is ready.')

    const denied = await call('read', { target_session_id: foreign.id })
    expect(denied.status).toBe(409)
    expect(denied.body.error).toContain('not found in this working directory')
    const childDenied = await call('read', { target_session_id: child.id })
    expect(childDenied.status).toBe(409)
    expect(childDenied.body.error).toContain('not found in this working directory')
    const archivedDenied = await call('read', { target_session_id: archived.id })
    expect(archivedDenied.status).toBe(409)
    expect(archivedDenied.body.error).toContain('not found in this working directory')
  })

  it('reuses scoped catalog, read, wake, and delivery behavior for user-owned surfaces', async () => {
    const transcript: TranscriptMessage[] = Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text: `Message ${index}` }],
    }))
    const { bridge, primeManager } = await fixture(true, transcript)
    const scope = { harness: 'prime' as const, projectPaths: ['/project'] }

    const listed = await bridge.listAccessibleSessions(scope)
    expect(listed.map(({ id }) => id)).toEqual([target.id, source.id])
    expect(listed).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: foreign.id }),
      expect.objectContaining({ id: child.id }),
      expect.objectContaining({ id: archived.id }),
    ]))

    const read = await bridge.readAccessibleSession(scope, target.id)
    expect(read).toMatchObject({
      projectPath: '/project', session: { id: target.id }, token_limit: 2_000, truncated: true, live: true,
    })
    expect(read.messages).toHaveLength(10)
    expect(read.messages[0]?.id).toBe('message-2')
    await expect(bridge.readAccessibleSession(scope, foreign.id)).rejects.toThrow('not found in an explicitly granted project')

    await expect(bridge.sendUserMessage(scope, target.id, '/mcp login notion')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(primeManager.command).not.toHaveBeenCalled()
    primeManager.getForSession.mockReturnValue({
      runtimeId: 'runtime-target', harness: 'prime', sessionId: target.id, sessionFile: target.filePath, cwd: '/project', isStreaming: true,
    })
    const sent = await bridge.sendUserMessage(scope, target.id, 'Please use the compact response shape.')
    expect(sent).toEqual({ delivered: true, target_session_id: target.id, awakened: false, queued: true })
    expect(primeManager.command).toHaveBeenCalledWith('runtime-target', {
      type: 'follow_up', message: 'Please use the compact response shape.',
    })
  })

  it('safely wakes an authorized saved session for a user-owned send', async () => {
    const { bridge, primeManager } = await fixture(false)
    const sent = await bridge.sendUserMessage({ harness: 'prime', projectPaths: ['/project'] }, target.id, 'Please continue.')
    expect(sent).toEqual({ delivered: true, target_session_id: target.id, awakened: true, queued: false })
    expect(primeManager.start).toHaveBeenCalledWith({ cwd: '/project', sessionPath: target.filePath })
    expect(primeManager.command).toHaveBeenCalledWith('runtime-awakened', { type: 'prompt', message: 'Please continue.' })
  })

  it('reads conversational I/O and thinking without exposing execution traces', async () => {
    const toolOnly: TranscriptMessage[] = Array.from({ length: 45 }, (_, index) => ({
      id: `tool-${index}`,
      role: 'tool',
      parts: [{ type: 'toolResult', name: 'shell', text: `SECRET_TOOL_RESULT_${index}` }],
    }))
    const { call } = await fixture(true, [
      { id: 'input', role: 'user', parts: [{ type: 'text', text: 'VISIBLE_USER_INPUT' }, { type: 'image' }] },
      ...toolOnly,
      { id: 'internal', role: 'system', parts: [{ type: 'text', text: 'SECRET_SYSTEM_TEXT' }] },
      { id: 'goal', role: 'goal', parts: [{ type: 'text', text: 'SECRET_GOAL_TEXT' }] },
      { id: 'output', role: 'assistant', parts: [
        { type: 'thinking', text: 'VISIBLE_THINKING' },
        { type: 'toolCall', name: 'dangerous_tool', args: { secret: 'SECRET_TOOL_ARGUMENT' } },
        { type: 'toolResult', name: 'dangerous_tool', text: 'SECRET_INLINE_TOOL_RESULT' },
        { type: 'compaction', status: 'done', summary: 'SECRET_COMPACTION_SUMMARY' },
        { type: 'text', text: 'VISIBLE_ASSISTANT_OUTPUT' },
      ] },
    ])

    const read = await call('read', { target_session_id: target.id })
    expect(read.status).toBe(200)
    expect(read.body.result).toMatchObject({ token_limit: 30_000, truncated: false })
    const serialized = JSON.stringify(read.body.result)
    expect(serialized).toContain('VISIBLE_USER_INPUT')
    expect(serialized).toContain('[image omitted]')
    expect(serialized).toContain('[thinking]\\nVISIBLE_THINKING')
    expect(serialized).toContain('VISIBLE_ASSISTANT_OUTPUT')
    expect(serialized).not.toContain('SECRET_TOOL_RESULT')
    expect(serialized).not.toContain('SECRET_SYSTEM_TEXT')
    expect(serialized).not.toContain('SECRET_GOAL_TEXT')
    expect(serialized).not.toContain('SECRET_TOOL_ARGUMENT')
    expect(serialized).not.toContain('SECRET_INLINE_TOOL_RESULT')
    expect(serialized).not.toContain('SECRET_COMPACTION_SUMMARY')
  })

  it('caps session reads at 30,000 estimated tokens and marks truncation', async () => {
    const { call } = await fixture(true, [
      { id: 'older', role: 'user', parts: [{ type: 'text', text: `START_${'a'.repeat(79_988)}_END` }] },
      { id: 'newer', role: 'assistant', parts: [{ type: 'text', text: 'b'.repeat(80_000) }] },
    ])

    const read = await call('read', { target_session_id: target.id })
    expect(read.status).toBe(200)
    expect(read.body.result).toMatchObject({ estimated_tokens: 30_000, token_limit: 30_000, truncated: true })
    const messages = (read.body.result as { messages: Array<{ text: string }> }).messages
    expect(messages.map(({ text }) => text).join('').length).toBe(120_000)
    expect(messages[0]?.text).toContain('[...message truncated...]')
    expect(messages[0]?.text).toContain('START_')
    expect(messages[0]?.text).toContain('_END')
  })

  it('delivers attributed messages to a live target and returns a wait cursor', async () => {
    const { call, primeManager } = await fixture()
    const sent = await call('send', { target_session_id: target.id, message: 'Please claim src/api.ts.' })
    expect(sent.status).toBe(200)
    expect(sent.body.result).toMatchObject({ delivered: true, target_session_id: target.id, queued: false })
    expect(sent.body.result).toHaveProperty('cursor_before')
    expect(primeManager.command).toHaveBeenCalledWith('runtime-target', expect.objectContaining({ type: 'prompt' }))
    const delivered = (primeManager.command.mock.calls[0] as unknown as [string, { message: string }])[1]
    expect(delivered.message).toContain(`"from_session_id":"${source.id}"`)
    expect(delivered.message).toContain('"reply_with":"session_send"')
    expect(delivered.message).not.toContain('"from_title"')
    expect(delivered.message).not.toContain('"from_harness"')
    expect(delivered.message).not.toContain(source.title)
    expect(delivered.message).not.toContain(target.title)
    expect(delivered.message).not.toContain('Implement the API.')
    expect(delivered.message).not.toContain('The endpoint is ready.')
    const metadata = JSON.parse(delivered.message.split('\n')[1]!) as Record<string, unknown>
    expect(Object.keys(metadata).sort()).toEqual([
      'from_session_id', 'nonce', 'reply_with', 'sent_at', 'signature', 'version',
    ])
    expect(metadata.version).toBe(2)
    expect(parseGooeyPiAgentMessage(delivered.message)).toEqual({
      fromSessionId: source.id,
      text: 'Please claim src/api.ts.',
    })

    const waited = await call('wait', { target_session_id: target.id, timeout_ms: 100 })
    expect(waited.status).toBe(200)
    expect(waited.body.result).toMatchObject({ timed_out: false, live: true })
  })

  it('lists GUI-visible models and creates a readable peer with the selected model and reasoning', async () => {
    const { bridge, call, primeManager } = await fixture()
    const createdEnvironment = bridge.environmentFor({ cwd: '/project', harness: 'prime' })
    bridge.bindSession(createdEnvironment.GOOEYPI_COLLABORATION_TOKEN, undefined, 'runtime-created')
    const models = await call('models', { query: 'GPT five six sol' })
    expect(models.status).toBe(200)
    expect(models.body.result).toMatchObject({
      models: [{ key: 'openai-codex/gpt-5.6-sol', reasoning_levels: ['low', 'high', 'max'] }],
      matched: 1,
    })
    expect(JSON.stringify(models.body.result)).not.toContain('Secret')
    const visible = await call('models')
    expect(JSON.stringify(visible.body.result)).not.toContain('Desktop Hidden')

    const response = await call('create', {
      prompt: 'Review the model integration.', title: 'Model reviewer', model: 'GPT five six sol', reasoning: 'very high', fast: true,
    })
    expect(response.status).toBe(200)
    expect(response.body.result).toMatchObject({
      created: true,
      session: { id: created.id, harness: 'prime', title: 'Model reviewer', live: true },
      runtime_id: 'runtime-created',
      model: { key: 'openai-codex/gpt-5.6-sol' },
      reasoning: 'max',
      fast_mode: { requested: true, enabled: true, available: true },
    })
    expect(primeManager.start).toHaveBeenCalledWith({
      cwd: '/project', model: 'openai-codex/gpt-5.6-sol', thinking: 'max', fast: true,
    })
    expect(primeManager.command).toHaveBeenNthCalledWith(1, 'runtime-created', {
      type: 'prompt', message: 'Review the model integration.', streamingBehavior: 'followUp',
    })
    expect(primeManager.command).toHaveBeenCalledWith('runtime-created', { type: 'set_session_name', name: 'Model reviewer' })
    expect(primeManager.command).toHaveBeenCalledWith('runtime-created', { type: 'get_state' })
    const createdList = await call('list', {}, createdEnvironment.GOOEYPI_COLLABORATION_TOKEN)
    expect(createdList.status).toBe(200)
    expect(createdList.body.result).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id })]))
    expect(createdList.body.result).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: created.id })]))
  })

  it('rejects an MCP auth creation prompt before starting a peer runtime', async () => {
    const { call, primeManager } = await fixture()

    const response = await call('create', { prompt: '/mcp login notion' })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('Network MCP authentication is managed outside GooeyPi')
    expect(primeManager.start).not.toHaveBeenCalled()
  })

  it('rejects an MCP auth delivery before waking or queuing a peer runtime', async () => {
    const { call, primeManager } = await fixture(false)

    const response = await call('send', { target_session_id: target.id, message: '/mcp login notion' })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('Network MCP authentication is managed outside GooeyPi')
    expect(primeManager.start).not.toHaveBeenCalled()
    expect(primeManager.command).not.toHaveBeenCalled()
  })

  it('starts normally and reports unavailable when fast mode is requested without model support', async () => {
    const { call, primeManager } = await fixture()
    const response = await call('create', { prompt: 'Review the fallback.', fast: true })
    expect(response.status).toBe(200)
    expect(response.body.result).toMatchObject({
      created: true,
      fast_mode: { requested: true, enabled: false, available: false },
    })
    expect(primeManager.start).toHaveBeenCalledWith({ cwd: '/project', fast: true })
  })

  it('serializes concurrent deliveries to the same target', async () => {
    const { call, primeManager } = await fixture()
    let releaseFirst!: () => void
    primeManager.command
      .mockImplementationOnce(() => new Promise((resolveCommand) => { releaseFirst = () => resolveCommand({ ok: true }) }))
      .mockResolvedValue({ ok: true })
    const first = call('send', { target_session_id: target.id, message: 'First' })
    await vi.waitFor(() => expect(primeManager.command).toHaveBeenCalledTimes(1))
    const second = call('send', { target_session_id: target.id, message: 'Second' })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    expect(primeManager.command).toHaveBeenCalledTimes(1)
    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 }),
    ])
    expect(primeManager.command).toHaveBeenCalledTimes(2)
  })

  it('allows only one active wait per target and bounds idle transcript polling', async () => {
    const { call, primeSessions } = await fixture()
    const read = await call('read', { target_session_id: target.id })
    const cursor = (read.body.result as Record<string, unknown>).cursor
    const readsBefore = primeSessions.read.mock.calls.length
    const first = call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 150 })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
    const duplicate = await call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 150 })
    expect(duplicate.status).toBe(409)
    expect(duplicate.body.error).toContain('already active')
    const completed = await first
    expect(completed.body.result).toMatchObject({ timed_out: true })
    expect(primeSessions.read.mock.calls.length - readsBefore).toBeLessThanOrEqual(2)
  })

  it('re-arms an early timeout wake without polling the transcript early', async () => {
    const clock = new FakeCollaborationWaitClock()
    const { call, primeSessions } = await fixture(true, defaultTargetTranscript, clock)
    const read = await call('read', { target_session_id: target.id })
    const cursor = (read.body.result as Record<string, unknown>).cursor
    const readsBefore = primeSessions.read.mock.calls.length
    const waiting = call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 150 })

    const firstTimer = await clock.takeNextTimer()
    expect(firstTimer).toMatchObject({ requestedAt: 10_000, delayMs: 150, dueAt: 10_150 })
    expect(firstTimer.unref).toHaveBeenCalledOnce()
    expect(primeSessions.read.mock.calls.length - readsBefore).toBe(1)

    clock.fireAt(firstTimer, firstTimer.dueAt - 25)
    const replacementTimer = await clock.takeNextTimer()
    expect(replacementTimer).toMatchObject({ requestedAt: 10_125, delayMs: 25, dueAt: 10_150 })
    expect(replacementTimer.unref).toHaveBeenCalledOnce()
    expect(primeSessions.read.mock.calls.length - readsBefore).toBe(1)

    clock.fireAt(replacementTimer, replacementTimer.dueAt)
    const completed = await waiting
    expect(completed.body.result).toMatchObject({ timed_out: true })
    expect(clock.now()).toBe(10_150)
    expect(primeSessions.read.mock.calls.length - readsBefore).toBe(2)
  })

  it('reports a transcript change found by the final deadline snapshot', async () => {
    const changedTranscript: TranscriptMessage[] = [
      ...defaultTargetTranscript,
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'The deadline update is ready.' }] },
    ]
    const clock = new FakeCollaborationWaitClock()
    const { call, primeSessions } = await fixture(true, defaultTargetTranscript, clock)
    let reads = 0
    primeSessions.read.mockImplementation(async () => {
      reads += 1
      return reads >= 3 ? changedTranscript : defaultTargetTranscript
    })
    const read = await call('read', { target_session_id: target.id })
    const cursor = (read.body.result as Record<string, unknown>).cursor

    const waiting = call('wait', { target_session_id: target.id, after_cursor: cursor, timeout_ms: 50 })
    const deadlineTimer = await clock.takeNextTimer()
    expect(deadlineTimer).toMatchObject({ requestedAt: 10_000, delayMs: 50, dueAt: 10_050 })
    expect(deadlineTimer.unref).toHaveBeenCalledOnce()
    clock.fireAt(deadlineTimer, deadlineTimer.dueAt)
    const completed = await waiting

    expect(completed.body.result).toMatchObject({ timed_out: false })
    expect((completed.body.result as Record<string, unknown>).messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'a2', text: 'The deadline update is ready.' }),
    ]))
    expect(clock.now()).toBe(10_050)
    expect(reads).toBe(3)
  })

  it('wakes an offline target while rejecting missing source scope and invalid tokens', async () => {
    const { bridge, call, environment } = await fixture(false)
    const offline = await call('send', { target_session_id: target.id, message: 'Hello' })
    expect(offline.status).toBe(200)
    expect(offline.body.result).toMatchObject({ delivered: true, awakened: true })
    expect((await call('list', {}, 'wrong')).status).toBe(401)

    const unbound = bridge.environmentFor({ cwd: '/project', harness: 'prime' as HarnessId })
    const response = await fetch(unbound.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${unbound.GOOEYPI_COLLABORATION_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('not available yet')
    expect(environment.GOOEYPI_COLLABORATION_TOKEN).not.toBe(unbound.GOOEYPI_COLLABORATION_TOKEN)
  })

  it('rejects a subagent source even when its runtime token is otherwise valid', async () => {
    const { bridge, environment } = await fixture()
    const childEnvironment = bridge.environmentFor({ cwd: '/project', sessionPath: child.filePath, harness: 'prime' })
    const response = await fetch(environment.GOOEYPI_COLLABORATION_URL!, {
      method: 'POST', headers: { authorization: `Bearer ${childEnvironment.GOOEYPI_COLLABORATION_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('top-level sessions')
  })
})
