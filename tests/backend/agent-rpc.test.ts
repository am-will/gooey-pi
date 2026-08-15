import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'
import { MAX_RPC_WRITE_FRAME_BYTES, rpcRequestFrameBytes } from '../../electron/main/agent-rpc/limits'
import { RpcRuntime } from '../../electron/main/agent-rpc/runtime'
import { FramedRpcTransport } from '../../electron/main/agent-rpc/transport'
import type { RpcObject } from '../../electron/main/agent-rpc/types'
import { PrimeProviderService } from '../../electron/main/providers'
import type { RuntimeInfo } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fakeAgent(promptResponse: string, stateResponse?: string): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
input.on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send(${stateResponse ?? "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', thinkingLevel: 'medium', isStreaming: false } }"})
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 25000, contextWindow: 100000, percent: 25 } } })
  } else if (command.type === 'prompt') {
    send(${promptResponse})
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  } else if (command.type === 'set_service_tier') {
    send({ id: command.id, type: 'response', command: 'set_service_tier', success: true })
  }
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

function managerFor(executable: string): AgentRpcManager {
  const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path)
  managers.push(manager)
  return manager
}

const processExists = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('agent RPC command frame bounds', () => {
  it('accepts the largest canonical image that fits transport and rejects the next base64 block', async () => {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const imageData = (bytes: number) => Buffer.concat([signature, Buffer.alloc(Math.max(0, bytes - signature.length))]).toString('base64')
    const command = (bytes: number) => ({
      type: 'prompt',
      message: 'describe this image',
      images: [{ type: 'image', data: imageData(bytes), mimeType: 'image/png' }],
    })
    const sample = command(signature.length)
    const overhead = rpcRequestFrameBytes(sample) - sample.images[0].data.length
    let decodedBytes = Math.floor((MAX_RPC_WRITE_FRAME_BYTES - overhead) / 4) * 3
    while (rpcRequestFrameBytes(command(decodedBytes + 1)) <= MAX_RPC_WRITE_FRAME_BYTES) decodedBytes += 1
    while (rpcRequestFrameBytes(command(decodedBytes)) > MAX_RPC_WRITE_FRAME_BYTES) decodedBytes -= 1

    const accepted = await validateRpcCommand(command(decodedBytes), async (path) => path)
    expect(rpcRequestFrameBytes(accepted)).toBeLessThanOrEqual(MAX_RPC_WRITE_FRAME_BYTES)
    await expect(validateRpcCommand(command(decodedBytes + 1), async (path) => path)).rejects.toThrow('too large for the RPC transport')
  })

  it('rejects malformed base64 and image data that does not match its MIME type', async () => {
    const command = (data: string, mimeType = 'image/png') => ({ type: 'prompt', message: 'inspect', images: [{ type: 'image', data, mimeType }] })
    await expect(validateRpcCommand(command('not base64'), async (path) => path)).rejects.toThrow('canonical base64')
    await expect(validateRpcCommand(command(Buffer.from('GIF89a').toString('base64')), async (path) => path)).rejects.toThrow('does not match')
  })

  it.each([
    ['prime', PRIME_RPC_ADAPTER, '/mcp login notion'],
    ['omp', OMP_RPC_ADAPTER, '/mcp reauth docs'],
    ['pi', PI_RPC_ADAPTER, '/mcp-auth files'],
  ] as const)('rejects forged %s auth commands for every main-process delivery mode', async (harness, adapter, message) => {
    const wireCommand = vi.fn(async () => ({ type: 'response', command: 'prompt', success: true, data: {} }))
    const runtime = {
      snapshot: () => ({ runtimeId: 'runtime-auth-policy', harness, cwd: '/tmp', isStreaming: false, imageInputSupported: true }),
      command: wireCommand,
    }
    const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), adapter)
    ;(manager as unknown as { runtimes: Map<string, unknown> }).runtimes.set('runtime-auth-policy', runtime)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      for (const command of [
        { type: 'prompt', message, images: [{ type: 'image', data: png, mimeType: 'image/png' }] },
        { type: 'steer', message },
        { type: 'follow_up', message },
        { type: 'set_heartbeat', schedule: '0 * * * *', prompt: message },
      ]) {
        await expect(manager.command('runtime-auth-policy', command)).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
      }
      expect(wireCommand).not.toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })
})

describe('agent RPC responses', () => {
  it('uses a newly discovered executable for future runtime starts', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    let executable: string | null = null
    const manager = new AgentRpcManager(() => executable, async (cwd) => cwd, async (path) => path)
    managers.push(manager)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Prime Agent executable was not found')
    executable = fake.executable
    await expect(manager.start({ cwd: fake.cwd })).resolves.toMatchObject({ harness: 'prime', cwd: fake.cwd })
  })

  it('hydrates and refreshes authoritative context-window usage', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-context-'))
    dirs.push(cwd)
    const executable = join(cwd, 'context-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
let stats = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'context', isStreaming: false } })
  else if (command.type === 'get_session_stats') {
    stats += 1
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: stats * 25000, contextWindow: 100000, percent: stats * 25 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_end' })
  } else if (command.type === 'abort') send({ id: command.id, type: 'response', command: 'abort', success: true })
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<{ event: Record<string, unknown> }> = []
    manager.setEventSink((event) => events.push(event))

    const runtime = await manager.start({ cwd })
    expect(runtime.contextUsage).toEqual({ tokens: 25_000, contextWindow: 100_000, percent: 25 })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })
    await waitUntil(() => events.some(({ event }) => event.type === 'context_usage'
      && typeof (event.contextUsage as { percent?: unknown } | undefined)?.percent === 'number'
      && Number((event.contextUsage as { percent: number }).percent) >= 50))
    expect(manager.list()[0]?.contextUsage?.percent).toBeGreaterThanOrEqual(50)
  })

  it('projects context usage while a response streams and corrects it at message boundaries', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-live-context-'))
    dirs.push(cwd)
    const executable = join(cwd, 'live-context-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
let contextTokens = 40000
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'live-context', isStreaming: false } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: contextTokens, contextWindow: 100000, percent: contextTokens / 1000 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_start' })
    send({ type: 'message_start', message: { role: 'user', content: 'continue' } })
    contextTokens = 40100
    send({ type: 'message_end', message: { role: 'user', content: 'continue' } })
    setTimeout(() => send({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 80 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400) },
    }), 40)
    setTimeout(() => send({
      type: 'message_update',
      message: { role: 'assistant', usage: { output: 200 } },
      assistantMessageEvent: { type: 'text_delta', delta: 'finished' },
    }), 100)
    setTimeout(() => {
      contextTokens = 40500
      send({ type: 'message_end', message: { role: 'assistant', usage: { output: 200 } } })
    }, 180)
    setTimeout(() => send({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'Read', args: { path: 'large.txt' } }), 210)
    setTimeout(() => {
      contextTokens = 40700
      send({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'Read', result: 'tool output' })
      send({ type: 'message_end', message: { role: 'toolResult', content: 'tool output' } })
    }, 240)
    setTimeout(() => send({ type: 'agent_end' }), 360)
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const events: Array<Record<string, unknown>> = []
    const runtime = new RpcRuntime(process.execPath, [executable], cwd, ({ event }) => events.push(event), () => undefined)
    try {
      await runtime.handshake()
      await runtime.command({ type: 'prompt', message: 'continue' })
      await waitUntil(() => events.some((event) => event.type === 'context_usage'
        && Number((event.contextUsage as { tokens?: number } | undefined)?.tokens) > 40_100
        && Number((event.contextUsage as { tokens?: number } | undefined)?.tokens) < 40_500))
      const liveUsageIndex = events.findIndex((event) => event.type === 'context_usage'
        && Number((event.contextUsage as { tokens?: number } | undefined)?.tokens) > 40_100)
      expect(liveUsageIndex).toBeGreaterThanOrEqual(0)
      expect(events.findIndex((event) => event.type === 'agent_end')).toBe(-1)

      await waitUntil(() => runtime.snapshot().contextUsage?.tokens === 40_700)
      expect(events.findIndex((event) => event.type === 'agent_end')).toBe(-1)
      await waitUntil(() => events.some((event) => event.type === 'agent_end'))
      expect(runtime.snapshot().contextUsage).toEqual({ tokens: 40_700, contextWindow: 100_000, percent: 40.7 })
    } finally {
      await runtime.stop()
    }
  })

  it('runs a trailing authoritative refresh when agent_end lands during an in-flight refresh', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-trailing-context-'))
    dirs.push(cwd)
    const executable = join(cwd, 'trailing-context-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
let statsRequests = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'trailing-context', isStreaming: false } })
  } else if (command.type === 'get_session_stats') {
    statsRequests += 1
    const tokens = statsRequests === 1 ? 10000 : statsRequests === 2 ? 20000 : 30000
    const respond = () => send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens, contextWindow: 100000, percent: tokens / 1000 } } })
    if (statsRequests === 2) setTimeout(respond, 180)
    else respond()
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_start' })
    send({ type: 'message_start', message: { role: 'user', content: 'continue' } })
    send({ type: 'message_end', message: { role: 'user', content: 'continue' } })
    setTimeout(() => send({ type: 'agent_end' }), 20)
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const events: Array<Record<string, unknown>> = []
    const runtime = new RpcRuntime(process.execPath, [executable], cwd, ({ event }) => events.push(event), () => undefined)
    try {
      await runtime.handshake()
      await runtime.command({ type: 'prompt', message: 'continue' })
      await waitUntil(() => events.some((event) => event.type === 'agent_end'))
      await waitUntil(() => runtime.snapshot().contextUsage?.tokens === 30_000)
      expect(events.filter((event) => event.type === 'context_usage').at(-1)?.contextUsage).toEqual({
        tokens: 30_000,
        contextWindow: 100_000,
        percent: 30,
      })
    } finally {
      await runtime.stop()
    }
  })

  it('stays busy while an overflow compaction is waiting to restart', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-compaction-'))
    dirs.push(cwd)
    const executable = join(cwd, 'compaction-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'compaction', isStreaming: false, isCompacting: false } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 50000, contextWindow: 100000, percent: 50 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_end' })
    send({ type: 'compaction_start', reason: 'overflow' })
    send({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true, result: { summary: 'Compacted', tokensBefore: 95000 } })
    setTimeout(() => send({ type: 'agent_start' }), 450)
    setTimeout(() => send({ type: 'agent_end' }), 550)
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd })

    const completion = manager.runPromptToCompletion(runtime.runtimeId, 'continue')
    await waitUntil(() => events.some((event) => event.type === 'compaction_end'))
    expect(manager.list()[0]).toMatchObject({ isStreaming: true, isCompacting: false })
    let settled = false
    void completion.finally(() => { settled = true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    expect(settled).toBe(false)
    await completion
    expect(events.some((event) => event.type === 'agent_start')).toBe(true)
    expect(manager.list()[0]).toMatchObject({ isStreaming: false, isCompacting: false })
  })

  it('stays busy while a provider auto-retry is waiting to restart', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-retry-'))
    dirs.push(cwd)
    const executable = join(cwd, 'retry-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'retry', isStreaming: false, isCompacting: false } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 50000, contextWindow: 100000, percent: 50 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    send({ type: 'agent_end' })
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 450, errorMessage: 'overloaded' })
    setTimeout(() => send({ type: 'agent_start' }), 450)
    setTimeout(() => send({ type: 'agent_end' }), 550)
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<Record<string, unknown>> = []
    manager.setEventSink(({ event }) => events.push(event))
    const runtime = await manager.start({ cwd })

    const completion = manager.runPromptToCompletion(runtime.runtimeId, 'continue')
    await waitUntil(() => events.some((event) => event.type === 'auto_retry_start'))
    // get_state reports isStreaming false during the backoff; the retry flag
    // learned from events must keep the snapshot busy anyway.
    expect(manager.list()[0]).toMatchObject({ isStreaming: true, isCompacting: false })
    let settled = false
    void completion.finally(() => { settled = true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
    expect(settled).toBe(false)
    await completion
    expect(events.some((event) => event.type === 'agent_start')).toBe(true)
    expect(manager.list()[0]).toMatchObject({ isStreaming: false, isCompacting: false })
  })

  it('rejects a negative command response with the agent error', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: false, error: 'No model credentials are configured' }")
    const manager = managerFor(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })).rejects.toThrow('No model credentials are configured')
  })

  it('rejects a response whose command does not match its request', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'follow_up', success: true }")
    const manager = managerFor(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })).rejects.toThrow(/mismatched response/)
  })

  it('does not admit a runtime when the handshake fails', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", "{ id: command.id, type: 'response', command: 'get_state', success: false, error: 'Unable to initialize session' }")
    const manager = managerFor(fake.executable)
    const environment = { GOOEYPI_COLLABORATION_TOKEN: 'failed-start-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Unable to initialize session')
    expect(manager.list()).toEqual([])
    expect(ended).toHaveBeenCalledOnce()
    expect(ended.mock.calls[0][0]).toBe(environment)
  })

  it('releases a minted environment when admission fails before a runtime exists', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const environment = { PRIME_WORK_BROWSER_TOKEN: 'never-spawned-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => {
      manager.beginShutdown()
      return environment
    })
    manager.setRuntimeEndListener(ended)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('manager is shutting down')
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(environment, undefined)
  })

  it('notifies runtime termination once after explicit stop while active claims remain owned', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const environment = { PRIME_WORK_SCHEDULE_TOKEN: 'active-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    const runtime = await manager.start({ cwd: fake.cwd })

    expect(ended).not.toHaveBeenCalled()
    await expect(manager.stop(runtime.runtimeId)).resolves.toBe(true)
    await waitUntil(() => ended.mock.calls.length === 1)
    expect(ended.mock.calls[0][0]).toBe(environment)
    expect(ended.mock.calls[0][1]).toMatchObject({ runtimeId: runtime.runtimeId })

    await expect(manager.stop(runtime.runtimeId)).resolves.toBe(false)
    await manager.stopAll()
    expect(ended).toHaveBeenCalledOnce()
  })

  it('notifies runtime termination after natural child exit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-natural-exit-'))
    dirs.push(cwd)
    const executable = join(cwd, 'natural-exit-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'natural-exit', isStreaming: false } })
  else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } } })
    setTimeout(() => process.exit(0), 500)
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const environment = { PRIME_WORK_BROWSER_TOKEN: 'natural-exit-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    const runtime = await manager.start({ cwd })

    expect(ended).not.toHaveBeenCalled()
    await waitUntil(() => ended.mock.calls.length === 1)
    expect(ended.mock.calls[0][0]).toBe(environment)
    expect(ended.mock.calls[0][1]).toMatchObject({ runtimeId: runtime.runtimeId })
    expect(manager.list()).toEqual([])
  })

  it('releases the runtime slot on a failed start even when the child cannot be stopped', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-stuck-'))
    dirs.push(cwd)
    const manager = managerFor('/bin/cat')
    const environment = { PRIME_WORK_SCHEDULE_TOKEN: 'unreapable-start-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    const handshake = vi.spyOn(RpcRuntime.prototype, 'handshake').mockRejectedValue(new Error('handshake unavailable'))
    // Simulate a child that survives the stop escalation: stop resolves false
    // and the close-event cleanup never runs.
    const stop = vi.spyOn(RpcRuntime.prototype, 'stop').mockResolvedValue(false)
    try {
      await expect(manager.start({ cwd })).rejects.toThrow('handshake unavailable')
      expect(manager.list()).toEqual([])
      expect(ended).toHaveBeenCalledOnce()
      expect(ended.mock.calls[0][0]).toBe(environment)
    } finally {
      handshake.mockRestore()
      stop.mockRestore()
    }
  })

  it('retires the previous idle runtime when a new session starts', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    let claim = 0
    const ended: NodeJS.ProcessEnv[] = []
    manager.setRuntimeEnvironmentProvider(() => ({ RUNTIME_CLAIM: String(++claim) }))
    manager.setRuntimeEndListener((environment) => ended.push(environment))
    const first = await manager.start({ cwd: fake.cwd })

    const second = await manager.start({ cwd: fake.cwd })

    expect(manager.list()).toHaveLength(1)
    expect(manager.list().some((runtime) => runtime.runtimeId === first.runtimeId)).toBe(false)
    expect(manager.list().some((runtime) => runtime.runtimeId === second.runtimeId)).toBe(true)
    expect(ended).toEqual([{ RUNTIME_CLAIM: '1' }])
  })

  it('distinguishes interactive and unattended runtime environments', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const modes: boolean[] = []
    manager.setRuntimeEnvironmentProvider((scope) => { modes.push(scope.interactive); return {} })

    await manager.start({ cwd: fake.cwd })
    await manager.startUnattended({ cwd: fake.cwd })

    expect(modes).toEqual([true, false])
  })

  it('retires idle runtimes after a capability environment change', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const environment = { RUNTIME_CLAIM: 'retired' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    await manager.start({ cwd: fake.cwd })

    await manager.requestRuntimeEnvironmentRefresh()

    await waitUntil(() => manager.list().length === 0)
    expect(ended).toHaveBeenCalledOnce()
    expect(ended.mock.calls[0][0]).toBe(environment)
  })

  it('retires a runtime whose launch overlapped a capability environment change', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    manager.setRuntimeEnvironmentProvider(() => {
      void manager.requestRuntimeEnvironmentRefresh()
      return {}
    })

    await manager.start({ cwd: fake.cwd })

    await waitUntil(() => manager.list().length === 0)
  })

  it('admits more than four runtimes when every existing session is active', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'busy', isStreaming: true, isCompacting: false } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const manager = managerFor(fake.executable)
    const runtimes: RuntimeInfo[] = []
    for (let index = 0; index < 5; index += 1) runtimes.push(await manager.start({ cwd: fake.cwd }))

    expect(new Set(runtimes.map((runtime) => runtime.runtimeId)).size).toBe(5)
    expect(manager.list()).toHaveLength(5)
  })

  it('decorates runtime reasoning and fast-mode capabilities from the Prime catalog', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', thinkingLevel: 'high', isStreaming: false, model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const providers = new PrimeProviderService({ authPath: join(fake.cwd, 'auth.json'), modelsPath: join(fake.cwd, 'models.json') })
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)

    const runtime = await manager.start({ cwd: fake.cwd, fast: true })

    expect(runtime.fastModeSupported).toBe(true)
    expect(runtime.fastModeAvailable).toBe(true)
    expect(runtime.serviceTier).toBe('priority')
    expect(runtime.availableThinkingLevels).toContain('xhigh')
    expect(runtime.availableThinkingLevels).not.toContain('max')
  })
  it('rejects images authoritatively when the active runtime model is text-only', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', isStreaming: false, model: { provider: 'fixture', id: 'text-model', name: 'Text model' } } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const providers = {
      capabilities: async () => ({
        key: 'fixture/text-model', provider: 'fixture', id: 'text-model', name: 'Text model', reasoning: false,
        input: ['text'], contextWindow: 1_000, maxTokens: 100, availableThinkingLevels: ['off'], fastModeSupported: false, available: true,
      }),
      requireAvailableModel: async () => { throw new Error('not used') },
    } as unknown as PrimeProviderService
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)
    const runtime = await manager.start({ cwd: fake.cwd })

    expect(runtime.imageInputSupported).toBe(false)
    await expect(manager.command(runtime.runtimeId, {
      type: 'prompt', message: 'inspect', images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }],
    })).rejects.toThrow('active model does not accept images')
  })

  it('terminates a process group that keeps writing after an oversized frame', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-overflow-'))
    dirs.push(cwd)
    const executable = join(cwd, 'overflow-agent.cjs')
    const pidFile = join(cwd, 'pid')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.on('SIGTERM', () => {})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'overflow', isStreaming: false } }) + '\\n')
    setTimeout(() => process.stdout.write('x'.repeat(17 * 1024 * 1024)), 25)
  } else if (command.type === 'get_session_stats') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 10, contextWindow: 100, percent: 10 } } }) + '\\n')
  }
})
setInterval(() => {}, 1000)
`)
    chmodSync(executable, 0o755)
    const manager = managerFor(executable)
    const events: Array<{ event: { type?: unknown; error?: unknown } }> = []
    manager.setEventSink((event) => events.push(event))
    await manager.start({ cwd })
    const pid = Number(readFileSync(pidFile, 'utf8'))

    await waitUntil(() => manager.list().length === 0)
    expect(events.filter((envelope) => envelope.event.type === 'transport_error')).toHaveLength(1)
    expect(String(events.find((envelope) => envelope.event.type === 'transport_error')?.event.error)).toMatch(/maximum frame size/i)
    expect(processExists(pid)).toBe(false)
  }, 12_000)


  it('cancels a queued write on timeout so the line never reaches the child and its budget is released', async () => {
    const heldWrites: Array<{ line: string; finish: (error?: Error | null) => void }> = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdout, stderr,
      stdin: {
        writable: true,
        write: (line: string, finish: (error?: Error | null) => void) => { heldWrites.push({ line, finish }); return true },
        end: () => undefined,
        destroy: () => undefined,
      },
    } as unknown as ChildProcessWithoutNullStreams
    const transport = new FramedRpcTransport(child, () => undefined, () => undefined, () => true, 60_000)
    const budget = () => (transport as unknown as { queuedWriteBytes: number }).queuedWriteBytes

    const first = transport.enqueue('{"type":"first"}\n')
    const second = transport.enqueue('{"type":"second"}\n')
    await new Promise((resolveTick) => setImmediate(resolveTick))
    expect(heldWrites.map((held) => held.line)).toEqual(['{"type":"first"}\n'])
    expect(budget()).toBeGreaterThan(Buffer.byteLength('{"type":"first"}\n'))

    expect(second.cancel()).toBe('cancelled')
    expect(budget()).toBe(Buffer.byteLength('{"type":"first"}\n'))
    expect(first.cancel()).toBe('flushed')

    heldWrites[0].finish(null)
    await expect(first.done).resolves.toBeUndefined()
    await expect(second.done).rejects.toThrow('cancelled before it was sent')
    expect(heldWrites.map((held) => held.line)).toEqual(['{"type":"first"}\n'])
    expect(budget()).toBe(0)
  })

  it('fails the transport within the write deadline when the child stops reading stdin', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdout, stderr,
      stdin: { writable: true, write: () => true, end: () => undefined, destroy: () => undefined },
    } as unknown as ChildProcessWithoutNullStreams
    const onFailure = vi.fn()
    const transport = new FramedRpcTransport(child, () => undefined, onFailure, () => true, 50)

    await expect(transport.enqueue('{"type":"stuck"}\n').done).rejects.toThrow('stopped reading RPC input')
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect((transport as unknown as { queuedWriteBytes: number }).queuedWriteBytes).toBe(0)
  })

  it('reports delivery-uncertain timeouts and consumes the late response instead of orphaning it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-uncertain-'))
    dirs.push(cwd)
    const executable = join(cwd, 'sleepy-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'sleepy') {
    setTimeout(() => send({ id: command.id, type: 'response', command: 'sleepy', success: true }), 300)
  }
})
setInterval(() => {}, 1000)
`)
    chmodSync(executable, 0o755)
    const events: Array<{ event: { type?: unknown } }> = []
    const runtime = new RpcRuntime(executable, [], cwd, (envelope) => events.push(envelope as unknown as { event: { type?: unknown } }), () => undefined)
    try {
      const request = (runtime as unknown as { request(command: RpcObject, timeoutMs: number): Promise<RpcObject> }).request.bind(runtime)
      await expect(request({ type: 'sleepy' }, 100)).rejects.toThrow(/timed out after delivery.*do not retry automatically/)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))
      expect(events.some((envelope) => envelope.event.type === 'orphan_response')).toBe(false)
    } finally {
      await runtime.stop()
    }
  }, 10_000)

  it('stops only runtimes whose cwd is inside a removed project root', async () => {
    const busyState = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'busy', isStreaming: true } }"
    const project = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", busyState)
    const outside = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", busyState)
    const manager = managerFor(project.executable)
    const ended: NodeJS.ProcessEnv[] = []
    manager.setRuntimeEnvironmentProvider(({ cwd }) => ({ RUNTIME_CLAIM: cwd }))
    manager.setRuntimeEndListener((environment) => ended.push(environment))
    const projectRuntime = await manager.start({ cwd: project.cwd })
    const outsideRuntime = await manager.start({ cwd: outside.cwd })

    await manager.stopForProjectRoots([project.cwd])

    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([outsideRuntime.runtimeId])
    expect(manager.list().some((runtime) => runtime.runtimeId === projectRuntime.runtimeId)).toBe(false)
    expect(ended).toEqual([{ RUNTIME_CLAIM: project.cwd }])
  })

  it('notifies termination for session stop and manager shutdown', async () => {
    const sessionFile = '/sessions/runtime-claim.jsonl'
    const state = `{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'claimed', sessionFile: ${JSON.stringify(sessionFile)}, isStreaming: true } }`
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const sessionManager = managerFor(fake.executable)
    const sessionEnded = vi.fn()
    sessionManager.setRuntimeEnvironmentProvider(() => ({ RUNTIME_CLAIM: 'session-stop' }))
    sessionManager.setRuntimeEndListener(sessionEnded)
    await sessionManager.start({ cwd: fake.cwd, sessionPath: sessionFile })

    await sessionManager.stopForSession(sessionFile)
    expect(sessionEnded).toHaveBeenCalledOnce()

    const shutdownManager = managerFor(fake.executable)
    const shutdownEnded = vi.fn()
    shutdownManager.setRuntimeEnvironmentProvider(() => ({ RUNTIME_CLAIM: 'shutdown' }))
    shutdownManager.setRuntimeEndListener(shutdownEnded)
    await shutdownManager.start({ cwd: fake.cwd })

    await shutdownManager.stopAll()
    expect(shutdownEnded).toHaveBeenCalledOnce()
  })

})

describe('compaction watchdog', () => {
  const watchdogAgent = (name: string, promptScript: string): { cwd: string; executable: string } => {
    const cwd = mkdtempSync(join(tmpdir(), `prime-work-rpc-${name}-`))
    dirs.push(cwd)
    const executable = join(cwd, `${name}.cjs`)
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let compacting = false
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'watchdog', isStreaming: false, isCompacting: compacting } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: 50000, contextWindow: 100000, percent: 50 } } })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    ${promptScript}
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: 'abort', success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    return { cwd, executable }
  }

  const startWatchdogRuntime = async (fake: { cwd: string; executable: string }, events: Record<string, unknown>[]): Promise<RpcRuntime> => {
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, { pollIntervalMs: 80, endGraceMs: 150 })
    await runtime.handshake()
    return runtime
  }

  it('synthesizes compaction lifecycle events when the agent reports compacting without streaming them', async () => {
    const fake = watchdogAgent('silent-compaction', `
    compacting = true
    setTimeout(() => { compacting = false }, 600)`)
    const events: Record<string, unknown>[] = []
    const runtime = await startWatchdogRuntime(fake, events)
    try {
      await runtime.command({ type: 'prompt', message: 'continue' })
      await waitUntil(() => events.some((event) => event.type === 'compaction_start' && event.synthetic === true))
      expect(runtime.snapshot().isCompacting).toBe(true)
      await waitUntil(() => events.some((event) => event.type === 'compaction_end' && event.synthetic === true))
      expect(runtime.snapshot().isCompacting).toBe(false)
    } finally {
      await runtime.stop()
    }
  })

  it('swallows the buffered real compaction_start after synthesizing and forwards the real end', async () => {
    const fake = watchdogAgent('buffered-compaction', `
    compacting = true
    setTimeout(() => {
      compacting = false
      send({ type: 'compaction_start', reason: 'threshold' })
      send({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 'Compacted', tokensBefore: 90000 } })
    }, 500)`)
    const events: Record<string, unknown>[] = []
    const runtime = await startWatchdogRuntime(fake, events)
    try {
      await runtime.command({ type: 'prompt', message: 'continue' })
      await waitUntil(() => events.some((event) => event.type === 'compaction_start' && event.synthetic === true))
      await waitUntil(() => events.some((event) => event.type === 'compaction_end'))
      // Wait past the grace window to prove no synthetic end fires after the real one.
      await new Promise((resolveWait) => setTimeout(resolveWait, 300))
      const starts = events.filter((event) => event.type === 'compaction_start')
      expect(starts).toHaveLength(1)
      expect(starts[0].synthetic).toBe(true)
      const ends = events.filter((event) => event.type === 'compaction_end')
      expect(ends).toHaveLength(1)
      expect(ends[0].synthetic).toBeUndefined()
      expect(ends[0].result).toMatchObject({ summary: 'Compacted' })
      expect(runtime.snapshot().isCompacting).toBe(false)
    } finally {
      await runtime.stop()
    }
  })

  it('stays out of the way when compaction events stream live', async () => {
    const fake = watchdogAgent('live-compaction', `
    compacting = true
    send({ type: 'compaction_start', reason: 'threshold' })
    setTimeout(() => {
      compacting = false
      send({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false, result: { summary: 'Compacted live', tokensBefore: 80000 } })
    }, 400)`)
    const events: Record<string, unknown>[] = []
    const runtime = await startWatchdogRuntime(fake, events)
    try {
      await runtime.command({ type: 'prompt', message: 'continue' })
      await waitUntil(() => events.some((event) => event.type === 'compaction_start'))
      expect(runtime.snapshot().isCompacting).toBe(true)
      await waitUntil(() => events.some((event) => event.type === 'compaction_end'))
      await new Promise((resolveWait) => setTimeout(resolveWait, 300))
      const starts = events.filter((event) => event.type === 'compaction_start')
      expect(starts).toHaveLength(1)
      expect(starts[0].synthetic).toBeUndefined()
      const ends = events.filter((event) => event.type === 'compaction_end')
      expect(ends).toHaveLength(1)
      expect(ends[0].synthetic).toBeUndefined()
      expect(runtime.snapshot().isCompacting).toBe(false)
    } finally {
      await runtime.stop()
    }
  })
})

describe('framed RPC transport stdio failure', () => {
  interface FakeRpcChild extends EventEmitter {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
  }

  function fakeChild(): FakeRpcChild {
    const child = new EventEmitter() as FakeRpcChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    return child
  }

  const asChild = (child: FakeRpcChild): ChildProcessWithoutNullStreams => child as unknown as ChildProcessWithoutNullStreams

  it('routes stdout and stderr pipe errors into the fatal frame path instead of crashing', () => {
    const uncaught: unknown[] = []
    const spy: NodeJS.UncaughtExceptionListener = (error) => { uncaught.push(error) }
    process.on('uncaughtException', spy)
    try {
      const failures: unknown[] = []
      const child = fakeChild()
      new FramedRpcTransport(asChild(child), () => {}, (error) => failures.push(error), () => true)
      const pipeError = new Error('read EPIPE')
      child.stdout.emit('error', pipeError)
      expect(failures).toEqual([pipeError])
      // A second pipe failure and the trailing stdout end must not re-fire the fatal path.
      child.stderr.emit('error', new Error('read ECONNRESET'))
      child.stdout.emit('end')
      expect(failures).toEqual([pipeError])
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', spy)
    }
  })

  it('fails the transport when only stderr errors', () => {
    const failures: unknown[] = []
    const child = fakeChild()
    new FramedRpcTransport(asChild(child), () => {}, (error) => failures.push(error), () => true)
    const pipeError = new Error('read ECONNRESET')
    child.stderr.emit('error', pipeError)
    expect(failures).toEqual([pipeError])
  })
})
