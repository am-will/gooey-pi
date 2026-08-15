import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, PI_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import type { ProviderCatalog } from '../../electron/main/agent-rpc'
import type { PrimeModelDescriptor } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface FakePiOptions {
  /** JavaScript statements the fake runs after acknowledging a prompt. */
  promptScript?: string
}

function fakePiAgent(options: FakePiOptions = {}): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pi-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-pi.cjs')
  // Like the real pi, the fake pushes no ready frame and knows no native
  // negotiate_protocol, branch, or fast-mode commands; get_state carries
  // hostile serviceTier/fastModeEnabled/contextUsage fields the adapter must
  // ignore, and get_session_stats owns the authoritative context usage.
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
send({ type: 'fake_argv', argv: process.argv.slice(2) })
send({ type: 'fake_cwd', cwd: process.cwd() })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: {
      sessionId: 'pi-session', isStreaming: false, isCompacting: false, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6' },
      serviceTier: 'priority', fastModeEnabled: true,
      contextUsage: { tokens: 999999, contextWindow: 272000, percent: 99 },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 12000, contextWindow: 272000, percent: 4 } } })
  } else if (command.type === 'fork' || command.type === 'get_fork_messages') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { received: command.type, entryId: command.entryId } })
  } else if (command.type === 'prompt') {
    send({ type: 'fake_prompt', message: command.message })
    send({ id: command.id, type: 'response', command: 'prompt', success: true, data: { agentInvoked: true } })
    ${options.promptScript ?? ''}
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  } else {
    send({ type: 'fake_unknown_command', command: command.type })
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command ' + command.type })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

const lunaModel: PrimeModelDescriptor = {
  key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6',
  reasoning: true, input: ['text', 'image'], contextWindow: 272_000, maxTokens: 64_000,
  availableThinkingLevels: ['off', 'low', 'medium', 'high'], fastModeSupported: true, available: true,
}

const piCatalog: ProviderCatalog = {
  requireAvailableModel: async () => lunaModel,
  capabilities: async (provider, modelId) => provider === 'openai-codex' && modelId === 'gpt-5.6-luna' ? lunaModel : undefined,
}

function piManager(executable: string, options: { providers?: ProviderCatalog } = {}): AgentRpcManager {
  const manager = new AgentRpcManager(
    executable,
    async (cwd) => cwd,
    async (path) => path,
    options.providers,
    () => new Set(),
    PI_RPC_ADAPTER,
    () => undefined,
  )
  managers.push(manager)
  return manager
}

describe('pi RPC adapter argv', () => {
  const baseInput = { cwd: '/work/project', environment: {} as NodeJS.ProcessEnv }

  it('builds the base argv without a --cwd flag and declares spawnsInCwd instead', () => {
    expect(PI_RPC_ADAPTER.buildStartArgs(baseInput)).toEqual(['--mode', 'rpc'])
    expect(PI_RPC_ADAPTER.spawnsInCwd).toBe(true)
  })

  it('resumes with --session, never the interactive --resume selector', () => {
    const args = PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, sessionPath: '/sessions/bucket/run.jsonl' })
    expect(args).toEqual(['--mode', 'rpc', '--session', '/sessions/bucket/run.jsonl'])
    expect(args).not.toContain('--resume')
  })

  it('passes the model as split --provider/--model flags like Prime', () => {
    const args = PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, providerId: 'openai-codex', modelId: 'gpt-5.6-luna', thinking: 'high' })
    expect(args).toEqual(['--mode', 'rpc', '--provider', 'openai-codex', '--model', 'gpt-5.6-luna', '--thinking', 'high'])
  })

  it('passes an unresolved model string without --provider and rejects unsafe values', () => {
    expect(PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, modelId: 'gpt-5.6-luna' }))
      .toEqual(['--mode', 'rpc', '--model', 'gpt-5.6-luna'])
    expect(() => PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, modelId: '--resume' })).toThrow('Invalid model')
    expect(() => PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, providerId: 'p', modelId: 'model\nid' })).toThrow('Invalid model')
  })

  it('ignores the OMP-only approval override', () => {
    expect(PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, approvalMode: 'yolo' })).toEqual(['--mode', 'rpc'])
  })

  it('injects only the enabled computer-use skill and forwards the scoped app extensions', () => {
    const environment = {
      PRIME_WORK_SCHEDULE_SKILL_PATH: '/skills/schedule.md',
      PRIME_WORK_BROWSER_SKILL_PATH: '/skills/browser.md',
      PRIME_WORK_SCHEDULE_EXTENSION_PATH: '/extensions/schedules.ts',
      PRIME_WORK_BROWSER_EXTENSION_PATH: '/extensions/browser.ts',
      PRIME_WORK_ASK_USER_EXTENSION_PATH: '/extensions/ask-user.ts',
      GOOEYPI_COLLABORATION_EXTENSION_PATH: '/extensions/collaboration.ts',
      GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: '/extensions/pi-fast-mode.ts',
      GOOEYPI_COMPUTER_USE_SKILL_PATH: '/skills/computer-use.md',
    } as NodeJS.ProcessEnv
    const args = PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, environment })
    expect(args.slice(-12)).toEqual([
      '--skill', '/skills/computer-use.md',
      '--extension', '/extensions/pi-fast-mode.ts',
      '--extension', '/extensions/schedules.ts',
      '--extension', '/extensions/browser.ts',
      '--extension', '/extensions/ask-user.ts',
      '--extension', '/extensions/collaboration.ts',
    ])
  })

  it('drops unsafe extension paths instead of passing them through', () => {
    const environment = { PRIME_WORK_BROWSER_EXTENSION_PATH: '--extension-injection' } as NodeJS.ProcessEnv
    expect(PI_RPC_ADAPTER.buildStartArgs({ ...baseInput, environment })).toEqual(['--mode', 'rpc'])
  })
})

describe('pi RPC handshake', () => {
  it('releases the exact runtime environment after Pi termination', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable)
    const environment = { GOOEYPI_COLLABORATION_TOKEN: 'pi-runtime-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    const runtime = await manager.start({ cwd: fake.cwd })

    expect(ended).not.toHaveBeenCalled()
    await manager.stop(runtime.runtimeId)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended.mock.calls[0][0]).toBe(environment)
    expect(ended.mock.calls[0][1]).toMatchObject({ runtimeId: runtime.runtimeId, harness: 'pi' })
  })

  it('handshakes Prime-style without protocol negotiation and reads no harness state fields', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    const runtime = await manager.start({ cwd: fake.cwd })

    expect(runtime.harness).toBe('pi')
    expect(runtime.sessionId).toBe('pi-session')
    expect(runtime.model).toEqual({ provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6' })
    // readState returns {}: the hostile serviceTier/fastModeEnabled fields in
    // get_state never reach the runtime info.
    expect(runtime.serviceTier).toBeUndefined()
    expect(runtime.fastModeAvailable).toBeUndefined()
    // Context usage flows through the shared get_session_stats path, not the
    // contextUsage field pi's get_state does not really carry.
    expect(runtime.contextUsage).toEqual({ tokens: 12_000, contextWindow: 272_000, percent: 4 })
    // A negotiate_protocol frame would have been answered with a failure that
    // aborts the handshake; the fake also records every unknown command.
    expect(events.some((event) => event.type === 'fake_unknown_command')).toBe(false)
  })

  it('spawns the child in the authorized cwd because pi has no --cwd flag', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    await manager.start({ cwd: fake.cwd })

    await waitUntil(() => events.some((event) => event.type === 'fake_cwd'))
    const reported = (events.find((event) => event.type === 'fake_cwd') as { cwd: string }).cwd
    expect(realpathSync(reported)).toBe(realpathSync(fake.cwd))
    const argv = (events.find((event) => event.type === 'fake_argv') as { argv: string[] }).argv
    expect(argv).not.toContain('--cwd')
  })

  it('spawns with --session, split provider/model flags, and scoped extensions', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable, { providers: piCatalog })
    manager.setRuntimeEnvironmentProvider(() => ({
      PRIME_WORK_SCHEDULE_SKILL_PATH: '/skills/schedule.md',
      PRIME_WORK_BROWSER_SKILL_PATH: '/skills/browser.md',
      PRIME_WORK_SCHEDULE_EXTENSION_PATH: '/extensions/schedules.ts',
      PRIME_WORK_BROWSER_EXTENSION_PATH: '/extensions/browser.ts',
      PRIME_WORK_ASK_USER_EXTENSION_PATH: '/extensions/ask-user.ts',
      GOOEYPI_COLLABORATION_EXTENSION_PATH: '/extensions/collaboration.ts',
      GOOEYPI_PI_FAST_MODE_EXTENSION_PATH: '/extensions/pi-fast-mode.ts',
    }))
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))

    await manager.start({ cwd: fake.cwd, sessionPath: '/sessions/bucket/run.jsonl', model: 'openai-codex/gpt-5.6-luna', thinking: 'high' })

    await waitUntil(() => events.some((event) => event.type === 'fake_argv'))
    const argv = (events.find((event) => event.type === 'fake_argv') as { argv: string[] }).argv
    expect(argv[argv.indexOf('--session') + 1]).toBe('/sessions/bucket/run.jsonl')
    expect(argv).not.toContain('--resume')
    expect(argv[argv.indexOf('--provider') + 1]).toBe('openai-codex')
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-5.6-luna')
    expect(argv[argv.indexOf('--thinking') + 1]).toBe('high')
    expect(argv).not.toContain('--skill')
    expect(argv).not.toContain('--approval-mode')
    const extensionPaths = argv.flatMap((value, index) => value === '--extension' ? [argv[index + 1]] : [])
    expect(extensionPaths).toEqual(['/extensions/pi-fast-mode.ts', '/extensions/schedules.ts', '/extensions/browser.ts', '/extensions/ask-user.ts', '/extensions/collaboration.ts'])
  })
})

describe('pi RPC command translation', () => {
  it('passes fork and get_fork_messages through untranslated', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    const fork = await manager.command(runtime.runtimeId, { type: 'fork', entryId: 'entry-123' })
    expect(fork.command).toBe('fork')
    expect(fork.data).toEqual({ received: 'fork', entryId: 'entry-123' })

    const messages = await manager.command(runtime.runtimeId, { type: 'get_fork_messages' })
    expect(messages.command).toBe('get_fork_messages')
    expect(messages.data).toMatchObject({ received: 'get_fork_messages' })
  })

  it('rejects Prime-only daemon commands with a clear error before they reach the agent', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'send_message', targetActiveSessionId: 'session-1', message: 'hello' }))
      .rejects.toThrow('RPC command send_message is not supported by the Pi harness')
    await expect(manager.command(runtime.runtimeId, { type: 'clone' }))
      .rejects.toThrow('RPC command clone is not supported by the Pi harness')
    await expect(manager.command(runtime.runtimeId, { type: 'list_heartbeats' }))
      .rejects.toThrow('RPC command list_heartbeats is not supported by the Pi harness')
    expect(events.some((event) => event.type === 'fake_unknown_command')).toBe(false)
  })

  it('maps set_service_tier onto the bundled Pi fast-mode command', async () => {
    const fake = fakePiAgent()
    const manager = piManager(fake.executable, { providers: piCatalog })
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'priority' })
    expect(manager.list()[0]?.serviceTier).toBe('priority')
    await manager.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'default' })
    expect(manager.list()[0]?.serviceTier).toBe('default')
    expect(events.filter((event) => event.type === 'fake_prompt').map((event) => event.message)).toEqual([
      '/gooeypi-fast-mode priority',
      '/gooeypi-fast-mode default',
    ])
    expect(events.some((event) => event.type === 'fake_unknown_command')).toBe(false)
  })
})

describe('pi RPC event normalization', () => {
  it('passes Prime-vocabulary events through unmodified, including unknown types', async () => {
    const fake = fakePiAgent({ promptScript: `
    send({ type: 'agent_start' })
    send({ type: 'session_info_changed', name: 'Renamed session' })
    send({ type: 'agent_end', isTerminal: false })` })
    const manager = piManager(fake.executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })

    await waitUntil(() => events.some((event) => event.type === 'agent_end'))
    // Unknown event types are forwarded for the reducer to ignore, and pi's
    // agent_end is terminal Prime-style even without an isTerminal marker.
    expect(events.find((event) => event.type === 'session_info_changed')).toMatchObject({ name: 'Renamed session' })
    expect(events.filter((event) => event.type === 'agent_end')).toHaveLength(1)
    expect(manager.list()[0]?.isStreaming).toBe(false)
  })

  it('reads {} from get_state for harness fields', () => {
    expect(PI_RPC_ADAPTER.readState({
      serviceTier: 'priority',
      fastModeEnabled: true,
      contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
    })).toEqual({})
  })
})
