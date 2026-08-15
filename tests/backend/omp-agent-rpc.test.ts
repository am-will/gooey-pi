import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import type { ProviderCatalog } from '../../electron/main/agent-rpc'
import {
  RPC_CHUNK_ASSEMBLY_INACTIVITY_MS,
  RpcRuntime,
  type RpcChunkAssemblyTimer,
  type RpcChunkAssemblyTiming,
} from '../../electron/main/agent-rpc/runtime'
import { RPC_READ_FRAME_LIMIT_BYTES } from '../../electron/main/jsonl-limits'
import type { PrimeModelDescriptor } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []
const runtimes: RpcRuntime[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakeOmpOptions {
  /** JavaScript statements the fake runs after acknowledging a prompt. */
  promptScript?: string
  /** When false the fake rejects negotiate_protocol like an unsupported version. */
  acceptNegotiate?: boolean
  sessionActions?: Record<string, unknown>
}

function fakeOmpAgent(options: FakeOmpOptions = {}): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-omp-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-omp.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const sessionActions = ${JSON.stringify(options.sessionActions)}
let negotiated = false
let streaming = false
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
send({ type: 'available_commands_update', commands: [{ name: 'help' }] })
send({ type: 'fake_argv', argv: process.argv.slice(2) })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    if (command.protocolVersion === 2 && ${options.acceptNegotiate === false ? 'false' : 'true'}) {
      negotiated = true
      send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: true, data: { protocolVersion: 2 } })
    } else {
      send({ id: command.id, type: 'response', command: 'negotiate_protocol', success: false, error: 'Unsupported protocol version' })
    }
    return
  }
  if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
    return
  }
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: {
      sessionId: 'omp-session', isStreaming: streaming, isCompacting: false, thinkingLevel: 'medium',
      fastModeEnabled: true, model: { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6' },
      contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 },
      ...(sessionActions ? { sessionActions } : {}),
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } } })
  } else if (command.type === 'branch' || command.type === 'get_branch_messages') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { received: command.type, entryId: command.entryId } })
  } else if (command.type === 'fork' || command.type === 'get_fork_messages') {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command ' + command.type })
  } else if (command.type === 'set_fast_mode') {
    send({ type: 'fake_received', command: 'set_fast_mode', enabled: command.enabled })
    send({ id: command.id, type: 'response', command: 'set_fast_mode', success: true })
  } else if (command.type === 'set_service_tier') {
    send({ id: command.id, type: 'response', command: 'set_service_tier', success: false, error: 'Unknown command set_service_tier' })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } })
    ${options.promptScript ?? ''}
  } else if (command.type === 'steer') {
    send({ id: command.id, type: 'response', command: 'steer', success: true, data: { accepted: true } })
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

const lunaModel: PrimeModelDescriptor = {
  key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6',
  reasoning: true, input: ['text', 'image'], contextWindow: 200_000, maxTokens: 64_000,
  availableThinkingLevels: ['off', 'low', 'medium', 'high'], fastModeSupported: true, available: true,
}

const ompCatalog: ProviderCatalog = {
  requireAvailableModel: async () => lunaModel,
  capabilities: async (provider, modelId) => provider === 'openai-codex' && modelId === 'gpt-5.6-luna' ? lunaModel : undefined,
}

function ompManager(executable: string, options: { providers?: ProviderCatalog; approvalMode?: () => string | undefined } = {}): AgentRpcManager {
  const manager = new AgentRpcManager(
    executable,
    async (cwd) => cwd,
    async (path) => path,
    options.providers,
    () => new Set(),
    OMP_RPC_ADAPTER,
    options.approvalMode ?? (() => undefined),
  )
  managers.push(manager)
  return manager
}

interface ChunkRuntimeView {
  handleFrame(frame: Record<string, unknown>): void
  handleLine(line: string): void
  failTransport(error: Error): void
  chunkAssemblies: Map<string, unknown>
  chunkAssemblySweepTimer: ControlledChunkTimer | null
  child: { kill(signal?: NodeJS.Signals): boolean; once(event: 'close', listener: () => void): void }
}

class ControlledChunkTimer implements RpcChunkAssemblyTimer {
  unrefed = false
  cancelled = false

  constructor(readonly dueAt: number, readonly callback: () => void) {}

  unref(): void { this.unrefed = true }
  hasRef(): boolean { return !this.unrefed }
}

class ControlledChunkTiming implements RpcChunkAssemblyTiming {
  private current = 0
  private readonly active = new Set<ControlledChunkTimer>()
  readonly created: ControlledChunkTimer[] = []

  now(): number { return this.current }

  schedule(callback: () => void, delayMs: number): ControlledChunkTimer {
    const timer = new ControlledChunkTimer(this.current + delayMs, callback)
    this.active.add(timer)
    this.created.push(timer)
    return timer
  }

  cancel(timer: RpcChunkAssemblyTimer): void {
    const controlled = timer as ControlledChunkTimer
    controlled.cancelled = true
    this.active.delete(controlled)
  }

  advanceBy(elapsedMs: number): void {
    const target = this.current + elapsedMs
    while (true) {
      const next = [...this.active]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0]
      if (!next) break
      this.current = next.dueAt
      this.active.delete(next)
      next.callback()
    }
    this.current = target
  }

  fireLate(timer: ControlledChunkTimer): void {
    this.active.delete(timer)
    timer.callback()
  }
  activeTimers(): ControlledChunkTimer[] { return [...this.active] }
}

function directChunkRuntime(timing = new ControlledChunkTiming()): {
  runtime: RpcRuntime
  view: ChunkRuntimeView
  events: Array<Record<string, unknown>>
  timing: ControlledChunkTiming
} {
  const fake = fakeOmpAgent()
  const events: Array<Record<string, unknown>> = []
  const runtime = new RpcRuntime(
    fake.executable,
    [],
    fake.cwd,
    ({ event }) => events.push(event),
    () => undefined,
    {},
    { pollIntervalMs: 10 * 60_000, idleWindowMs: 0 },
    OMP_RPC_ADAPTER,
    timing,
  )
  runtimes.push(runtime)
  return { runtime, view: runtime as unknown as ChunkRuntimeView, events, timing }
}

function chunkFrame(chunkId: string, index: number, count: number, data: Buffer): Record<string, unknown> {
  return { type: 'rpc_chunk', chunkId, index, count, byteLength: data.length, data: data.toString('base64') }
}

describe('OMP RPC adapter argv', () => {
  const baseInput = { cwd: '/work/project', environment: {} as NodeJS.ProcessEnv }

  it('passes the model as a single provider/id selector without --provider', () => {
    const args = OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, providerId: 'openai-codex', modelId: 'gpt-5.6-luna' })
    expect(args).toEqual(['--mode', 'rpc', '--cwd', '/work/project', '--model', 'openai-codex/gpt-5.6-luna'])
  })

  it('passes an unresolved model string as-is and rejects unsafe values', () => {
    expect(OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, modelId: 'openai-codex/gpt-5.6-luna' }))
      .toContain('openai-codex/gpt-5.6-luna')
    expect(() => OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, modelId: '--resume' })).toThrow('Invalid model')
    expect(() => OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, providerId: 'p', modelId: 'model\nid' })).toThrow('Invalid model')
  })

  it('includes --approval-mode only for validated overrides', () => {
    expect(OMP_RPC_ADAPTER.buildStartArgs(baseInput)).not.toContain('--approval-mode')
    const args = OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, approvalMode: 'yolo' })
    expect(args.slice(-2)).toEqual(['--approval-mode', 'yolo'])
    expect(() => OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, approvalMode: 'sometimes' })).toThrow('Invalid approval mode')
  })

  it('appends the enabled computer-use skill and forwards the scoped app extensions', () => {
    const environment = {
      PRIME_WORK_SCHEDULE_SKILL_PATH: '/skills/schedule.md',
      PRIME_WORK_BROWSER_SKILL_PATH: '/skills/browser.md',
      PRIME_WORK_SCHEDULE_EXTENSION_PATH: '/extensions/schedules.ts',
      PRIME_WORK_BROWSER_EXTENSION_PATH: '/extensions/browser.ts',
      PRIME_WORK_ASK_USER_EXTENSION_PATH: '/extensions/ask-user.ts',
      GOOEYPI_COLLABORATION_EXTENSION_PATH: '/extensions/collaboration.ts',
      GOOEYPI_COMPUTER_USE_SKILL_PATH: '/skills/computer-use.md',
    } as NodeJS.ProcessEnv
    const args = OMP_RPC_ADAPTER.buildStartArgs({ ...baseInput, environment })
    expect(args).not.toContain('--skill')
    expect(args).toContain('--append-system-prompt')
    expect(args.slice(-8)).toEqual([
      '--extension', '/extensions/schedules.ts',
      '--extension', '/extensions/browser.ts',
      '--extension', '/extensions/ask-user.ts',
      '--extension', '/extensions/collaboration.ts',
    ])
  })
})

describe('OMP RPC handshake', () => {
  it('releases the exact runtime environment after OMP termination', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable)
    const environment = { GOOEYPI_COLLABORATION_TOKEN: 'omp-runtime-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    const runtime = await manager.start({ cwd: fake.cwd })

    expect(ended).not.toHaveBeenCalled()
    await manager.stop(runtime.runtimeId)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended.mock.calls[0][0]).toBe(environment)
    expect(ended.mock.calls[0][1]).toMatchObject({ runtimeId: runtime.runtimeId, harness: 'omp' })
  })

  it('negotiates protocol v2 before get_state and reads OMP-shaped state', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable, { providers: ompCatalog })
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    const runtime = await manager.start({ cwd: fake.cwd })

    expect(runtime.harness).toBe('omp')
    expect(runtime.sessionId).toBe('omp-session')
    expect(runtime.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6' })
    // fastModeEnabled: true in get_state maps to the priority service tier.
    expect(runtime.serviceTier).toBe('priority')
    expect(runtime.fastModeAvailable).toBe(true)
    expect(runtime.fastModeSupported).toBe(true)
    // contextUsage arrives directly in get_state data.
    expect(runtime.contextUsage).toEqual({ tokens: 12_000, contextWindow: 200_000, percent: 6 })
    // Unsolicited pre-request frames are tolerated and forwarded for the renderer to ignore.
    await waitUntil(() => events.some((event) => event.type === 'ready'))
    expect(events.some((event) => event.type === 'available_commands_update')).toBe(true)
  })

  it('fails the handshake when protocol negotiation is rejected', async () => {
    const fake = fakeOmpAgent({ acceptNegotiate: false })
    const manager = ompManager(fake.executable)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Unsupported protocol version')
    expect(manager.list()).toEqual([])
  })

  it('spawns with --approval-mode, provider/id model, and no --skill flags', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable, { providers: ompCatalog, approvalMode: () => 'yolo' })
    manager.setRuntimeEnvironmentProvider(() => ({
      PRIME_WORK_SCHEDULE_SKILL_PATH: '/skills/schedule.md',
      PRIME_WORK_BROWSER_SKILL_PATH: '/skills/browser.md',
      PRIME_WORK_SCHEDULE_EXTENSION_PATH: '/extensions/schedules.ts',
      PRIME_WORK_BROWSER_EXTENSION_PATH: '/extensions/browser.ts',
      PRIME_WORK_ASK_USER_EXTENSION_PATH: '/extensions/ask-user.ts',
      GOOEYPI_COLLABORATION_EXTENSION_PATH: '/extensions/collaboration.ts',
    }))
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    await manager.start({ cwd: fake.cwd, model: 'openai-codex/gpt-5.6-luna' })

    await waitUntil(() => events.some((event) => event.type === 'fake_argv'))
    const argv = (events.find((event) => event.type === 'fake_argv') as { argv: string[] }).argv
    expect(argv).toContain('--approval-mode')
    expect(argv[argv.indexOf('--approval-mode') + 1]).toBe('yolo')
    expect(argv[argv.indexOf('--model') + 1]).toBe('openai-codex/gpt-5.6-luna')
    expect(argv).not.toContain('--provider')
    expect(argv).not.toContain('--skill')
    const extensionPaths = argv.flatMap((value, index) => value === '--extension' ? [argv[index + 1]] : [])
    expect(extensionPaths).toEqual(['/extensions/schedules.ts', '/extensions/browser.ts', '/extensions/ask-user.ts', '/extensions/collaboration.ts'])
  })

  it('omits --approval-mode when no override is configured', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    await manager.start({ cwd: fake.cwd })

    await waitUntil(() => events.some((event) => event.type === 'fake_argv'))
    const argv = (events.find((event) => event.type === 'fake_argv') as { argv: string[] }).argv
    expect(argv).not.toContain('--approval-mode')
  })
})

describe('OMP RPC command translation', () => {
  it('attaches only an explicit valid post-admission steering snapshot', async () => {
    const actions = { queuedCount: 0, steering: [], followUps: [], active: { kind: 'turn', phase: 'running', label: 'redirect' } }
    const explicitFake = fakeOmpAgent({ sessionActions: actions })
    const explicitManager = ompManager(explicitFake.executable)
    const explicitRuntime = await explicitManager.start({ cwd: explicitFake.cwd })
    await expect(explicitManager.command(explicitRuntime.runtimeId, { type: 'steer', message: 'redirect' }))
      .resolves.toMatchObject({ sessionActions: actions })

    const omittedFake = fakeOmpAgent()
    const omittedManager = ompManager(omittedFake.executable)
    const omittedRuntime = await omittedManager.start({ cwd: omittedFake.cwd })
    const omitted = await omittedManager.command(omittedRuntime.runtimeId, { type: 'steer', message: 'redirect' })
    expect(omitted).not.toHaveProperty('sessionActions')
  })

  it('translates fork to branch and correlates the branch response', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    const response = await manager.command(runtime.runtimeId, { type: 'fork', entryId: 'entry-123' })

    expect(response.command).toBe('branch')
    expect(response.success).toBe(true)
    expect(response.data).toEqual({ received: 'branch', entryId: 'entry-123' })
  })

  it('translates get_fork_messages to get_branch_messages', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    const response = await manager.command(runtime.runtimeId, { type: 'get_fork_messages' })

    expect(response.command).toBe('get_branch_messages')
    expect(response.data).toMatchObject({ received: 'get_branch_messages' })
  })

  it('rejects Prime-only commands with a clear error before they reach the agent', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'send_message', targetActiveSessionId: 'session-1', message: 'hello' }))
      .rejects.toThrow('RPC command send_message is not supported by the OMP harness')
    await expect(manager.command(runtime.runtimeId, { type: 'clone' }))
      .rejects.toThrow('RPC command clone is not supported by the OMP harness')
  })

  it('maps set_service_tier onto set_fast_mode', async () => {
    const fake = fakeOmpAgent()
    const manager = ompManager(fake.executable, { providers: ompCatalog })
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    const priority = await manager.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'priority' })
    expect(priority).toEqual({ type: 'response', command: 'set_service_tier', success: true })
    await waitUntil(() => events.some((event) => event.type === 'fake_received' && event.enabled === true))

    await manager.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'default' })
    await waitUntil(() => events.some((event) => event.type === 'fake_received' && event.enabled === false))
    expect(manager.list()[0]?.serviceTier).toBe('default')
  })
})

describe('OMP RPC event normalization', () => {
  it('normalizes auto_compaction events to compaction events', async () => {
    const fake = fakeOmpAgent({ promptScript: `
    send({ type: 'auto_compaction_start', reason: 'threshold' })
    send({ type: 'auto_compaction_end', reason: 'threshold', aborted: false, willRetry: false })
    send({ type: 'agent_end', isTerminal: true })` })
    const manager = ompManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })

    await waitUntil(() => events.some((event) => event.type === 'compaction_end'))
    const start = events.find((event) => event.type === 'compaction_start')
    expect(start).toMatchObject({ reason: 'threshold' })
    expect(events.some((event) => String(event.type).startsWith('auto_compaction'))).toBe(false)
    expect(manager.list()[0]).toMatchObject({ isStreaming: false, isCompacting: false })
  })

  it('swallows non-terminal agent_end turn boundaries and forwards the terminal one', async () => {
    const fake = fakeOmpAgent({ promptScript: `
    streaming = true
    send({ type: 'agent_start' })
    send({ type: 'agent_end', isTerminal: false })
    setTimeout(() => { streaming = false; send({ type: 'agent_end', isTerminal: true }) }, 150)` })
    const manager = ompManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })

    await waitUntil(() => events.some((event) => event.type === 'agent_start'))
    // The non-terminal boundary must not stop the streaming row.
    await new Promise((resolveWait) => setTimeout(resolveWait, 60))
    expect(manager.list()[0]?.isStreaming).toBe(true)
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(0)
    await waitUntil(() => events.some((event) => event.type === 'agent_end'))
    const ends = events.filter((event) => event.type === 'agent_end')
    expect(ends).toHaveLength(1)
    expect(ends[0].isTerminal).toBe(true)
  })
})

describe('OMP RPC chunked frames', () => {
  it('reassembles an oversized event from base64 rpc_chunk frames', async () => {
    const fake = fakeOmpAgent({ promptScript: `
    const frame = Buffer.from(JSON.stringify({ type: 'big_event', payload: 'x'.repeat(1200000) }), 'utf8')
    const size = 256 * 1024
    const count = Math.ceil(frame.length / size)
    for (let index = 0; index < count; index += 1) {
      const slice = frame.subarray(index * size, Math.min(frame.length, (index + 1) * size))
      send({ type: 'rpc_chunk', chunkId: 'big-1', index, count, byteLength: slice.length, data: slice.toString('base64') })
    }
    send({ type: 'agent_end', isTerminal: true })` })
    const manager = ompManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })

    await waitUntil(() => events.some((event) => event.type === 'big_event'))
    const big = events.find((event) => event.type === 'big_event') as { payload: string }
    expect(big.payload).toHaveLength(1_200_000)
    expect(events.some((event) => event.type === 'rpc_chunk')).toBe(false)
    expect(events.some((event) => event.type === 'transport_limit')).toBe(false)
  })

  it('drops a malformed chunk sequence without wedging the runtime', async () => {
    const fake = fakeOmpAgent({ promptScript: `
    send({ type: 'rpc_chunk', chunkId: 'broken-1', index: 1, count: 2, data: Buffer.from('half').toString('base64') })` })
    const manager = ompManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })

    await waitUntil(() => events.some((event) => event.type === 'transport_limit'))
    expect(events.find((event) => event.type === 'transport_limit')).toMatchObject({ kind: 'chunk' })
    // The runtime keeps answering commands after the failed reassembly.
    const state = await manager.command(runtime.runtimeId, { type: 'get_state' })
    expect(state.success).toBe(true)
    expect(manager.list()).toHaveLength(1)
  })

  it('expires an incomplete prefix with one unrefed owned sweep timer', () => {
    const { view, events, timing } = directChunkRuntime()

    view.handleFrame(chunkFrame('abandoned', 0, 2, Buffer.from('{"type":"partial"')))

    expect(view.chunkAssemblies).toHaveLength(1)
    expect(view.chunkAssemblySweepTimer).not.toBeNull()
    expect(view.chunkAssemblySweepTimer?.hasRef()).toBe(false)
    expect(timing.activeTimers()).toHaveLength(1)

    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS)

    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transport_limit',
      kind: 'chunk',
      error: expect.stringMatching(/expired.*inactivity/i),
    }))
  })

  it('releases four expired prefixes so a later complete event is accepted', () => {
    const { view, events, timing } = directChunkRuntime()

    for (const chunkId of ['one', 'two', 'three', 'four']) {
      view.handleFrame(chunkFrame(chunkId, 0, 2, Buffer.from(`{"type":"${chunkId}`)))
    }
    expect(view.chunkAssemblies).toHaveLength(4)

    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS)
    expect(view.chunkAssemblies).toHaveLength(0)

    const complete = Buffer.from(JSON.stringify({ type: 'after_expiry', payload: 'accepted' }))
    const splitAt = Math.floor(complete.length / 2)
    view.handleFrame(chunkFrame('later', 0, 2, complete.subarray(0, splitAt)))
    view.handleFrame(chunkFrame('later', 1, 2, complete.subarray(splitAt)))

    expect(events).toContainEqual({ type: 'after_expiry', payload: 'accepted' })
    expect(events.some((event) => event.error === 'too many concurrent chunk reassemblies')).toBe(false)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
  })

  it('rejects a fifth non-expired assembly without disturbing the four admitted prefixes', () => {
    const { view, events, timing } = directChunkRuntime()

    for (const chunkId of ['one', 'two', 'three', 'four']) {
      view.handleFrame(chunkFrame(chunkId, 0, 2, Buffer.from('{')))
    }
    const ownedTimer = view.chunkAssemblySweepTimer
    view.handleFrame(chunkFrame('fifth', 0, 2, Buffer.from('{')))

    expect([...view.chunkAssemblies.keys()]).toEqual(['one', 'two', 'three', 'four'])
    expect(view.chunkAssemblySweepTimer).not.toBeNull()
    expect(view.chunkAssemblySweepTimer?.hasRef()).toBe(false)
    expect(timing.activeTimers()).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transport_limit',
      kind: 'chunk',
      error: 'too many concurrent chunk reassemblies',
    }))
    expect(ownedTimer?.cancelled).toBe(true)
  })

  it('leaves a valid multiplexed assembly intact across invalid, empty, and missing chunk IDs', () => {
    const { view, events, timing } = directChunkRuntime()
    const complete = Buffer.from(JSON.stringify({ type: 'survived_invalid_ids' }))
    const splitAt = Math.floor(complete.length / 2)
    view.handleFrame(chunkFrame('valid-a', 0, 2, complete.subarray(0, splitAt)))
    const ownedTimer = view.chunkAssemblySweepTimer

    view.handleFrame({ type: 'rpc_chunk', chunkId: '', index: 0, count: 2, data: '' })
    view.handleFrame({ type: 'rpc_chunk', chunkId: 'x'.repeat(129), index: 0, count: 2, data: '' })
    view.handleFrame({ type: 'rpc_chunk', index: 0, count: 2, data: '' })

    expect([...view.chunkAssemblies.keys()]).toEqual(['valid-a'])
    expect(view.chunkAssemblySweepTimer).toBe(ownedTimer)
    expect(timing.activeTimers()).toEqual([ownedTimer])
    view.handleFrame(chunkFrame('valid-a', 1, 2, complete.subarray(splitAt)))

    expect(events).toContainEqual({ type: 'survived_invalid_ids' })
    expect(events.filter((event) => event.type === 'transport_limit' && event.kind === 'chunk')).toHaveLength(3)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
  })

  it('refreshes the inactivity deadline only after valid byte progress', () => {
    const { view, events, timing } = directChunkRuntime()

    view.handleFrame(chunkFrame('progress', 0, 3, Buffer.from('{"type":')))
    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS - 1)
    view.handleFrame(chunkFrame('progress', 1, 3, Buffer.from('"still-alive"')))

    timing.advanceBy(1)
    expect(view.chunkAssemblies).toHaveLength(1)
    expect(events.some((event) => event.type === 'transport_limit')).toBe(false)

    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS - 1)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({ type: 'transport_limit', kind: 'chunk' }))
  })

  it('gives a new zero-byte prefix an initial deadline without letting later zero-byte chunks refresh it', () => {
    const { view, events, timing } = directChunkRuntime()

    view.handleFrame(chunkFrame('zero-progress', 0, 3, Buffer.alloc(0)))
    expect(view.chunkAssemblies).toHaveLength(1)
    expect(view.chunkAssemblySweepTimer?.hasRef()).toBe(false)

    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS - 1)
    view.handleFrame(chunkFrame('zero-progress', 1, 3, Buffer.alloc(0)))
    timing.advanceBy(1)

    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
    expect(events).toContainEqual(expect.objectContaining({ type: 'transport_limit', kind: 'chunk' }))
  })

  it('expires only due staggered assemblies and rearms one unrefed timer for the remainder', () => {
    const { view, events, timing } = directChunkRuntime()

    view.handleFrame(chunkFrame('earlier', 0, 2, Buffer.from('{')))
    timing.advanceBy(10_000)
    view.handleFrame(chunkFrame('later', 0, 2, Buffer.from('{')))
    expect(timing.activeTimers()).toHaveLength(1)
    expect(timing.created).toHaveLength(2)
    expect(timing.created[0]?.cancelled).toBe(true)
    const earliestTimer = view.chunkAssemblySweepTimer
    expect(earliestTimer?.hasRef()).toBe(false)

    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS - 10_000)

    expect([...view.chunkAssemblies.keys()]).toEqual(['later'])
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(1)
    expect(timing.activeTimers()).toHaveLength(1)
    expect(view.chunkAssemblySweepTimer).not.toBe(earliestTimer)
    expect(view.chunkAssemblySweepTimer?.hasRef()).toBe(false)

    timing.advanceBy(10_000)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(events.filter((event) => event.type === 'transport_limit')).toHaveLength(2)
    expect(timing.activeTimers()).toHaveLength(0)
  })

  it('uses monotonic inactivity when the wall clock jumps backward', () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const { view, timing } = directChunkRuntime()
    view.handleFrame(chunkFrame('wall-backward', 0, 2, Buffer.from('{')))

    wallClock.mockReturnValue(-5_000_000)
    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS)

    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
  })

  it('uses monotonic inactivity when the wall clock jumps forward', () => {
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
    const { view, timing } = directChunkRuntime()
    view.handleFrame(chunkFrame('wall-forward', 0, 2, Buffer.from('{')))
    const earlyTimer = view.chunkAssemblySweepTimer
    expect(earlyTimer).not.toBeNull()

    wallClock.mockReturnValue(50_000_000)
    timing.fireLate(earlyTimer as ControlledChunkTimer)

    expect(view.chunkAssemblies).toHaveLength(1)
    expect(view.chunkAssemblySweepTimer).not.toBe(earlyTimer)
    expect(view.chunkAssemblySweepTimer?.hasRef()).toBe(false)
    timing.advanceBy(RPC_CHUNK_ASSEMBLY_INACTIVITY_MS)
    expect(view.chunkAssemblies).toHaveLength(0)
  })

  it('retains the existing chunk-count and decoded-byte bounds', () => {
    const { view, events } = directChunkRuntime()

    view.handleFrame(chunkFrame('count-limit', 0, 4_097, Buffer.alloc(0)))
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transport_limit',
      kind: 'chunk',
      error: 'chunked frame carried invalid sequencing',
    }))

    const atLimit = Buffer.alloc(RPC_READ_FRAME_LIMIT_BYTES)
    view.handleFrame(chunkFrame('byte-limit', 0, 2, atLimit))
    expect(view.chunkAssemblies).toHaveLength(1)
    view.handleFrame(chunkFrame('byte-limit', 1, 2, Buffer.from('x')))
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'transport_limit',
      kind: 'chunk',
      error: 'chunked frame exceeded the maximum frame size',
    }))
  })

  it('clears the owned timer and buffers on completion and malformed input', () => {
    const { view } = directChunkRuntime()
    const complete = Buffer.from(JSON.stringify({ type: 'finished' }))
    const splitAt = Math.floor(complete.length / 2)

    view.handleFrame(chunkFrame('complete', 0, 2, complete.subarray(0, splitAt)))
    expect(view.chunkAssemblySweepTimer).not.toBeNull()
    view.handleFrame(chunkFrame('complete', 1, 2, complete.subarray(splitAt)))
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()

    view.handleFrame(chunkFrame('malformed', 0, 3, Buffer.from('{')))
    expect(view.chunkAssemblySweepTimer).not.toBeNull()
    view.handleFrame(chunkFrame('malformed', 2, 3, Buffer.from('}')))
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
  })

  it('clears every pending assembly after malformed reconstructed or raw JSON', () => {
    const reconstructed = directChunkRuntime()
    reconstructed.view.handleFrame(chunkFrame('pending', 0, 2, Buffer.from('{')))
    reconstructed.view.handleFrame(chunkFrame('bad-json', 0, 1, Buffer.from('{')))

    expect(reconstructed.view.chunkAssemblies).toHaveLength(0)
    expect(reconstructed.view.chunkAssemblySweepTimer).toBeNull()
    expect(reconstructed.timing.activeTimers()).toHaveLength(0)
    expect(reconstructed.events).toContainEqual(expect.objectContaining({
      type: 'transport_error',
      error: expect.stringMatching(/malformed chunked frame/i),
    }))

    const raw = directChunkRuntime()
    raw.view.handleFrame(chunkFrame('pending', 0, 2, Buffer.from('{')))
    raw.view.handleLine('{')

    expect(raw.view.chunkAssemblies).toHaveLength(0)
    expect(raw.view.chunkAssemblySweepTimer).toBeNull()
    expect(raw.timing.activeTimers()).toHaveLength(0)
    expect(raw.events).toContainEqual(expect.objectContaining({
      type: 'transport_error',
      error: expect.stringMatching(/malformed JSON/i),
    }))
  })

  it('clears the owned timer and buffers on stop and transport failure', async () => {
    const stopped = directChunkRuntime()
    stopped.view.handleFrame(chunkFrame('stop', 0, 2, Buffer.from('{')))
    expect(stopped.view.chunkAssemblySweepTimer).not.toBeNull()
    const stoppedTimer = stopped.view.chunkAssemblySweepTimer as ControlledChunkTimer

    const stopping = stopped.runtime.stop()
    expect(stoppedTimer.cancelled).toBe(true)
    expect(stopped.view.chunkAssemblies).toHaveLength(0)
    expect(stopped.view.chunkAssemblySweepTimer).toBeNull()
    stopped.view.handleFrame(chunkFrame('during-stop', 0, 2, Buffer.from('{')))
    expect(stopped.view.chunkAssemblies).toHaveLength(0)
    expect(stopped.view.chunkAssemblySweepTimer).toBeNull()
    stopped.timing.fireLate(stoppedTimer)
    expect(stopped.view.chunkAssemblies).toHaveLength(0)
    expect(stopped.view.chunkAssemblySweepTimer).toBeNull()
    expect(stopped.timing.activeTimers()).toHaveLength(0)
    expect(stopped.events.some((event) => event.type === 'transport_limit')).toBe(false)
    await stopping

    const failed = directChunkRuntime()
    failed.view.handleFrame(chunkFrame('failure', 0, 2, Buffer.from('{')))
    expect(failed.view.chunkAssemblySweepTimer).not.toBeNull()
    const failedTimer = failed.view.chunkAssemblySweepTimer as ControlledChunkTimer

    failed.view.failTransport(new Error('test transport failure'))
    expect(failedTimer.cancelled).toBe(true)
    expect(failed.view.chunkAssemblies).toHaveLength(0)
    expect(failed.view.chunkAssemblySweepTimer).toBeNull()
    failed.timing.fireLate(failedTimer)
    expect(failed.view.chunkAssemblies).toHaveLength(0)
    expect(failed.view.chunkAssemblySweepTimer).toBeNull()
    expect(failed.timing.activeTimers()).toHaveLength(0)
    expect(failed.events.some((event) => event.type === 'transport_limit')).toBe(false)
    await failed.runtime.stop()
  })

  it('clears the owned timer and buffers when the child closes', async () => {
    const { view, events, timing } = directChunkRuntime()
    view.handleFrame(chunkFrame('child-close', 0, 2, Buffer.from('{')))
    expect(view.chunkAssemblySweepTimer).not.toBeNull()
    const closedTimer = view.chunkAssemblySweepTimer as ControlledChunkTimer

    const closed = new Promise<void>((resolve) => view.child.once('close', resolve))
    view.child.kill('SIGTERM')
    await closed

    expect(closedTimer.cancelled).toBe(true)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
    timing.fireLate(closedTimer)
    expect(view.chunkAssemblies).toHaveLength(0)
    expect(view.chunkAssemblySweepTimer).toBeNull()
    expect(timing.activeTimers()).toHaveLength(0)
    expect(events.some((event) => event.type === 'transport_limit')).toBe(false)
  })
})
