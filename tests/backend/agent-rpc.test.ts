import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRpcManager, OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER, PRIME_RUST_RPC_ADAPTER, primeRpcAdapter, primeStartRecovery, UnsupportedRpcCommandError, type HarnessRpcAdapter } from '../../electron/main/agent-rpc'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'
import { rpcRequestFrameBytes } from '../../electron/main/agent-rpc/limits'
import { RPC_WRITE_FRAME_LIMIT_BYTES } from '../../electron/main/jsonl-limits'
import { RpcRuntime } from '../../electron/main/agent-rpc/runtime'
import { FramedRpcTransport } from '../../electron/main/agent-rpc/transport'
import type { RpcObject } from '../../electron/main/agent-rpc/types'
import { PrimeProviderService } from '../../electron/main/providers'
import { RepositoryUseGate } from '../../electron/main/repository-use-gate'
import type { PrimeImplementation, RuntimeInfo, SessionActionSnapshot } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const managers: AgentRpcManager[] = []

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('runtime capability retirement polling', () => {
  it('owns one poll per busy runtime and clears it on idle retirement or shutdown', async () => {
    vi.useFakeTimers()
    try {
      const manager = new AgentRpcManager(null, async (cwd) => cwd, async (path) => path)
      const info: RuntimeInfo = { runtimeId: 'busy-retirement', harness: 'prime', cwd: '/tmp', isStreaming: true, isCompacting: false }
      const stop = vi.fn(async () => true)
      const runtime = { runtimeId: info.runtimeId, snapshot: () => info, stop }
      const internals = manager as unknown as { runtimes: Map<string, unknown>; runtimeEnvironmentRevisions: Map<string, number> }
      internals.runtimes.set(info.runtimeId, runtime)
      internals.runtimeEnvironmentRevisions.set(info.runtimeId, 0)
      await manager.requestRuntimeEnvironmentRefresh()
      await manager.requestRuntimeEnvironmentRefresh()
      await manager.requestRuntimeEnvironmentRefresh()
      expect(vi.getTimerCount()).toBe(1)
      info.isStreaming = false
      await vi.advanceTimersByTimeAsync(250)
      expect(stop).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
      info.isStreaming = true
      await manager.requestRuntimeEnvironmentRefresh()
      expect(vi.getTimerCount()).toBe(1)
      manager.beginShutdown()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

describe('reserved desktop RPC events', () => {
  it('ignores forged exits and transport failures without consuming the real exit', async () => {
    const fake = fakeAgent(`{ id: command.id, type: 'response', command: 'prompt', success: true }`)
    const manager = managerFor(fake.executable)
    const delivered: RpcObject[] = []
    manager.setEventSink(({ event }) => delivered.push(event))
    const info = await manager.start({ cwd: fake.cwd })
    const runtime = (manager as unknown as { runtimes: Map<string, RpcRuntime> }).runtimes.get(info.runtimeId)
    if (!runtime) throw new Error('Missing runtime')
    const incoming = runtime as unknown as { handleFrame(frame: unknown): void }
    delivered.length = 0
    incoming.handleFrame({ type: 'runtime_exit', expected: true, code: 0 })
    incoming.handleFrame({ type: 'transport_error', error: 'Forged desktop failure' })
    incoming.handleFrame({ type: 'transport_limit', kind: 'forged' })
    incoming.handleFrame({ type: 'context_usage', contextUsage: { tokens: 1 } })
    incoming.handleFrame({ type: 'session_usage', sessionUsage: { cost: 0 } })
    incoming.handleFrame({ type: 'orphan_response', command: 'forged' })
    expect(delivered.filter((event) => ['runtime_exit', 'transport_error', 'transport_limit', 'context_usage', 'session_usage', 'orphan_response'].includes(String(event.type)))).toEqual([])
    await manager.stop(info.runtimeId)
    expect(delivered.filter((event) => event.type === 'runtime_exit')).toMatchObject([{ expected: true }])
  })
})

describe('agent RPC exit details', () => {
  const writeAgent = (name: string, source: string): { cwd: string; executable: string } => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-exit-'))
    dirs.push(cwd)
    const executable = join(cwd, name)
    writeFileSync(executable, source)
    chmodSync(executable, 0o755)
    return { cwd, executable }
  }
  const writeExitingAgent = (body: string) => writeAgent('exit-agent.cjs', `#!/usr/bin/env node
${body}
`)
  // An agent that rejects its argv closes stdin before it exits, so GooeyPi's
  // first write can break the pipe before the close event that says why.
  const writeStdinClosingAgent = (lingerSeconds: number) => writeAgent('exit-agent.sh', `#!/bin/sh
exec 0<&-
printf 'Error: Unknown option: --extension\\n' >&2
sleep ${lingerSeconds}
exit 1
`)
  const stderrTail = (runtime: RpcRuntime): string => (runtime as unknown as { transport: { stderrTail(): string } }).transport.stderrTail()

  it('includes a sanitized stderr tail when the agent exits before any frame', async () => {
    const fake = writeExitingAgent(`process.stderr.write('Error: Tool "session_list" from extension "pi-session-search" conflicts with extension "omp-work-collaboration"')
process.exit(1)`)
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, () => undefined, () => undefined)
    try {
      await expect(runtime.handshake()).rejects.toThrow(/RPC exited \(1\): Error: Tool "session_list"/)
    } finally {
      await runtime.stop()
    }
  })

  it('reports the exit and its stderr tail when a write breaks the pipe first', async () => {
    const fake = writeStdinClosingAgent(0.5)
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, () => undefined, () => undefined)
    try {
      await waitUntil(() => stderrTail(runtime).includes('Unknown option'))
      await expect(runtime.handshake()).rejects.toThrow('Prime Agent RPC exited (1): Error: Unknown option: --extension')
    } finally {
      await runtime.stop()
    }
  })

  it('still fails a broken pipe when the agent never exits', async () => {
    const fake = writeStdinClosingAgent(30)
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, () => undefined, () => undefined)
    try {
      await waitUntil(() => stderrTail(runtime).includes('Unknown option'))
      await expect(runtime.handshake()).rejects.toThrow(/EPIPE/)
    } finally {
      await runtime.stop()
    }
  })

  it('redacts secrets and bounds the early exit message', async () => {
    const fake = writeExitingAgent(`process.stderr.write('\\u001b[31mtoken ghp_' + 'a'.repeat(40) + ' leaked\\u001b[0m\\n' + 'x'.repeat(5000) + '\\n' + 'final line ' + 'B'.repeat(300))
process.exit(1)`)
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, () => undefined, () => undefined)
    try {
      await expect(runtime.handshake()).rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return !message.includes('ghp_a') && !message.includes('\u001b') && message.length < 400
      })
    } finally {
      await runtime.stop()
    }
  })

  it('does not append stderr after the agent has emitted a frame', async () => {
    const fake = writeExitingAgent(`const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'framed', isStreaming: false } }) + '\\n')
  } else if (command.type === 'trigger_exit') {
    process.stderr.write('secret')
    process.exit(1)
  }
})`)
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, () => undefined, () => undefined)
    try {
      await runtime.handshake()
      const request = (runtime as unknown as { request(command: RpcObject, timeoutMs: number): Promise<RpcObject> }).request.bind(runtime)
      const error = await request({ type: 'trigger_exit' }, 10_000).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe('Prime Agent RPC exited (1)')
    } finally {
      await runtime.stop()
    }
  })
})

function fakeAgent(promptResponse: string, stateResponse?: string, exitDelayMs = 0, controlCommands = false): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const input = readline.createInterface({ input: process.stdin })
let stateCalls = 0
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
  } else if (${controlCommands} && ['set_model', 'set_thinking_level'].includes(command.type)) {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'set_service_tier') {
    send({ id: command.id, type: 'response', command: 'set_service_tier', success: true })
  }
})
input.on('close', () => {
  if (${exitDelayMs} > 0) {
    process.on('SIGTERM', () => {})
    setTimeout(() => process.exit(0), ${exitDelayMs})
  } else {
    process.exit(0)
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
  it.each(['workspace lease', 'runtime admission'] as const)('revokes a project start suspended at %s without affecting sibling roots', async (stage) => {
    const project = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const sibling = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(project.executable)
    let releaseGate!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { releaseGate = resolve })
    const admissionEntered = new Promise<void>((resolve) => { entered = resolve })
    const releaseLease = vi.fn()
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(({ cwd }) => ({ CLAIM: cwd }))
    manager.setRuntimeEndListener(ended)
    manager.setWorkspaceUseProvider(async (cwd) => {
      if (cwd === project.cwd) {
        entered()
        if (stage === 'workspace lease') await gate
      }
      return { release: releaseLease }
    })
    if (stage === 'runtime admission') (manager as unknown as { runtimeAdmission: Promise<void> }).runtimeAdmission = gate
    const starting = manager.start({ cwd: project.cwd }).then((info) => ({ info }), (error: unknown) => ({ error }))
    await admissionEntered
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await manager.stopForProjectRoots([project.cwd])
    releaseGate()
    const outcome = await starting
    expect(outcome).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('Project') }) })
    expect(manager.list()).toEqual([])
    expect(releaseLease).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledExactlyOnceWith({ CLAIM: project.cwd }, undefined)
    const outside = await manager.start({ cwd: sibling.cwd })
    expect(outside.cwd).toBe(sibling.cwd)
    expect(manager.list().map((info) => info.runtimeId)).toEqual([outside.runtimeId])
    // Removal cancels the overlapping admission, rather than permanently denying a re-granted root.
    const fresh = await manager.start({ cwd: project.cwd })
    expect(fresh.cwd).toBe(project.cwd)
  })

  it('holds repository use for the lifetime of a runtime', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const release = vi.fn()
    const begin = vi.fn(async () => ({ release }))
    manager.setWorkspaceUseProvider(begin)

    const runtime = await manager.start({ cwd: fake.cwd })
    expect(begin).toHaveBeenCalledWith(fake.cwd, expect.objectContaining({ kind: 'agent', harness: 'prime' }), expect.any(Function))
    expect(release).not.toHaveBeenCalled()

    await manager.stop(runtime.runtimeId)
    await waitUntil(() => release.mock.calls.length === 1)
  })

  it('retires a completed idle resident runtime for branch checkout', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const gate = new RepositoryUseGate()
    manager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => gate.beginWorkspaceUse(cwd, owner, retireIfIdle))
    const runtime = await manager.start({ cwd: fake.cwd })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'completed work' })

    await expect(gate.runBranchCheckout(fake.cwd, async () => 'changed')).resolves.toBe('changed')
    expect(manager.list()).toEqual([])
  })

  it('keeps commanding other runtimes while a checkout retires an idle one', async () => {
    const slowState = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', isStreaming: stateCalls++ === 0, isCompacting: false } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", slowState, 1_500)
    const other = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const gate = new RepositoryUseGate()
    manager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => gate.beginWorkspaceUse(cwd, owner, retireIfIdle))
    const runtime = await manager.start({ cwd: fake.cwd })
    const otherRuntime = await manager.start({ cwd: other.cwd })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'complete work' })
    await waitUntil(() => manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId)?.isStreaming === false)

    const retirement = gate.runBranchCheckout(fake.cwd, async () => 'changed')
    await expect(Promise.race([
      retirement.then(() => 'retired'),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 500)),
    ])).resolves.toBe('pending')
    await expect(Promise.race([
      manager.command(otherRuntime.runtimeId, { type: 'prompt', message: 'keep working' }).then(() => 'commanded'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed out'), 1_000)),
    ])).resolves.toBe('commanded')
    await retirement
  }, 10_000)

  it('rejects commands to a runtime that is being retired', async () => {
    const slowState = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', isStreaming: stateCalls++ === 0, isCompacting: false } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", slowState, 1_500)
    const other = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const gate = new RepositoryUseGate()
    manager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => gate.beginWorkspaceUse(cwd, owner, retireIfIdle))
    const runtime = await manager.start({ cwd: fake.cwd })
    await manager.start({ cwd: other.cwd })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'complete work' })
    await waitUntil(() => manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId)?.isStreaming === false)

    const retirement = gate.runBranchCheckout(fake.cwd, async () => 'changed')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'too late' })).rejects.toThrow(/being retired/)
    await retirement
  }, 10_000)

  it('keeps a busy resident runtime and refuses branch checkout', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'busy', isStreaming: true, isCompacting: false } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const manager = managerFor(fake.executable)
    const gate = new RepositoryUseGate()
    manager.setWorkspaceUseProvider((cwd, owner, retireIfIdle) => gate.beginWorkspaceUse(cwd, owner, retireIfIdle))
    await manager.start({ cwd: fake.cwd })

    await expect(gate.runBranchCheckout(fake.cwd, async () => 'changed')).rejects.toMatchObject({ code: 'active-work' })
    expect(manager.list()).toHaveLength(1)
  })

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
    let decodedBytes = Math.floor((RPC_WRITE_FRAME_LIMIT_BYTES - overhead) / 4) * 3
    while (rpcRequestFrameBytes(command(decodedBytes + 1)) <= RPC_WRITE_FRAME_LIMIT_BYTES) decodedBytes += 1
    while (rpcRequestFrameBytes(command(decodedBytes)) > RPC_WRITE_FRAME_LIMIT_BYTES) decodedBytes -= 1

    const accepted = await validateRpcCommand(command(decodedBytes), async (path) => path)
    expect(rpcRequestFrameBytes(accepted)).toBeLessThanOrEqual(RPC_WRITE_FRAME_LIMIT_BYTES)
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
        { type: 'send_message', targetActiveSessionId: 'session-1', message },
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

describe('agent RPC prompt admission capabilities', () => {
  it.each([
    ['prime', PRIME_RPC_ADAPTER, true],
    ['omp', OMP_RPC_ADAPTER, false],
    ['pi', PI_RPC_ADAPTER, false],
  ] as const)('keeps or strips streamingBehavior for %s at the wire seam', async (harness, adapter, accepts) => {
    const cwd = mkdtempSync(join(tmpdir(), `prompt-capability-${harness}-`))
    dirs.push(cwd)
    const executable = join(cwd, 'fake-agent.cjs')
    const wirePath = join(cwd, 'wire-command.json')
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true,
      data: { sessionId: 'capability-session', isStreaming: false } })
  } else if (command.type === 'prompt') {
    fs.writeFileSync(${JSON.stringify(wirePath)}, JSON.stringify(command))
    send({ id: command.id, type: 'response', command: command.type, success: true })
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const manager = new AgentRpcManager(executable, async (path) => path, async (path) => path, undefined, () => new Set(), adapter)
    managers.push(manager)
    const runtime = await manager.start({ cwd })
    await manager.command(runtime.runtimeId, {
      type: 'prompt',
      message: 'admit this prompt',
      streamingBehavior: 'steer',
      images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }],
    })

    const wire = JSON.parse(readFileSync(wirePath, 'utf8'))
    expect(wire).toMatchObject({
      type: 'prompt',
      message: 'admit this prompt',
      ...(accepts ? { streamingBehavior: 'steer' } : {}),
      images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') }],
    })
    expect(wire.id).toEqual(expect.any(String))
    if (!accepts) expect(wire).not.toHaveProperty('streamingBehavior')
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

  it('resolves the adapter once per start and keeps it for the runtime', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'busy', isStreaming: true, isCompacting: false } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state)
    const refusing: HarnessRpcAdapter = { ...PRIME_RPC_ADAPTER, translateCommand: () => { throw new Error('refused by the second adapter') } }
    let current = PRIME_RPC_ADAPTER
    const adapterSource = vi.fn(() => current)
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), adapterSource)
    managers.push(manager)
    const constructionCalls = adapterSource.mock.calls.length

    const first = await manager.start({ cwd: fake.cwd })
    current = refusing
    const second = await manager.start({ cwd: fake.cwd })

    expect(adapterSource).toHaveBeenCalledTimes(constructionCalls + 2)
    await expect(manager.command(first.runtimeId, { type: 'prompt', message: 'first adapter' })).resolves.toMatchObject({ success: true })
    await expect(manager.command(second.runtimeId, { type: 'prompt', message: 'second adapter' })).rejects.toThrow('refused by the second adapter')
  })

  it('runs every event an adapter expands one harness frame into, in order', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const actions = { queuedCount: 1, steering: [], followUps: ['after this turn'] }
    const expanding: HarnessRpcAdapter = {
      ...PRIME_RPC_ADAPTER,
      normalizeEvent: (event) => event.type === 'burst' ? [{ type: 'session_action_update', actions }, { type: 'agent_end' }] : event,
    }
    const events: RpcObject[] = []
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, {}, expanding)
    try {
      await runtime.handshake()
      const frames = runtime as unknown as { handleFrame(frame: RpcObject): void }
      frames.handleFrame({ type: 'agent_start' })
      expect(runtime.snapshot().isStreaming).toBe(true)
      frames.handleFrame({ type: 'burst' })

      const lifecycle = events.filter((event) => ['agent_start', 'session_action_update', 'agent_end', 'burst'].includes(String(event.type)))
      expect(lifecycle).toEqual([{ type: 'agent_start' }, { type: 'session_action_update', actions }, { type: 'agent_end' }])
      expect(runtime.snapshot()).toMatchObject({ isStreaming: false, sessionActions: actions })
    } finally {
      await runtime.stop()
    }
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
    send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data: { contextUsage: { tokens: stats * 25000, contextWindow: 100000, percent: stats * 25 }, cost: stats * 0.21, tokens: { input: stats * 20000, output: stats * 5000, cacheRead: 0, cacheWrite: 0, total: stats * 25000 } } })
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
    expect(runtime.sessionUsage).toEqual({ cost: 0.21, tokens: { input: 20_000, output: 5_000, cacheRead: 0, cacheWrite: 0, total: 25_000 } })
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'continue' })
    await waitUntil(() => events.some(({ event }) => event.type === 'context_usage'
      && typeof (event.contextUsage as { percent?: unknown } | undefined)?.percent === 'number'
      && Number((event.contextUsage as { percent: number }).percent) >= 50))
    expect(manager.list()[0]?.contextUsage?.percent).toBeGreaterThanOrEqual(50)
    await waitUntil(() => events.some(({ event }) => event.type === 'session_usage'
      && Number((event.sessionUsage as { cost?: unknown } | undefined)?.cost) >= 0.42))
    expect(manager.list()[0]?.sessionUsage?.cost).toBeGreaterThanOrEqual(0.42)
  })

  it('reports a null session cost when get_session_stats omits it', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const runtime = await manager.start({ cwd: fake.cwd })
    expect(runtime.contextUsage).toEqual({ tokens: 25_000, contextWindow: 100_000, percent: 25 })
    expect(runtime.sessionUsage).toBeUndefined()
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
      message: { role: 'assistant', usage: { output: 80 }, content: 'x'.repeat(100_000) },
      assistantMessageEvent: { type: 'text_delta', delta: 'x'.repeat(400), partial: 'x'.repeat(100_000) },
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
      const streamed = events.find((event) => event.type === 'message_update')
      expect(streamed?.message).toEqual({ role: 'assistant', usage: { output: 80 } })
      expect(streamed?.assistantMessageEvent).not.toHaveProperty('partial')
      expect(events.findIndex((event) => event.type === 'agent_end')).toBe(-1)

      await waitUntil(() => runtime.snapshot().contextUsage?.tokens === 40_700)
      expect(events.findIndex((event) => event.type === 'agent_end')).toBe(-1)
      await waitUntil(() => events.some((event) => event.type === 'agent_end'))
      expect(runtime.snapshot().contextUsage).toEqual({ tokens: 40_700, contextWindow: 100_000, percent: 40.7 })
    } finally {
      await runtime.stop()
    }
  })

  it('never over-counts context usage across a Prime tool loop with assistant message starts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-tool-loop-context-'))
    dirs.push(cwd)
    const executable = join(cwd, 'tool-loop-context-agent.cjs')
    // Prime counts a response's output once it is persisted. Odd turns
    // persist it a step after message_end, so that refresh answers stale,
    // and every third stats answer is delivered after later events.
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
const OUTPUT = 3000
const TOOL_RESULT = 800
let contextTokens = 40000
let statsRequests = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const real = (tokens) => send({ type: 'fake_real_context', tokens })
const steps = [() => {
  send({ type: 'agent_start' })
  send({ type: 'message_start', message: { role: 'user', content: 'go' } })
  contextTokens = 40100
  real(contextTokens)
  send({ type: 'message_end', message: { role: 'user', content: 'go' } })
}]
for (let turn = 0; turn < 20; turn += 1) {
  const stale = turn % 2 === 1
  steps.push(
    () => send({ type: 'message_start', message: { role: 'assistant' } }),
    () => {
      real(contextTokens + OUTPUT / 2)
      send({ type: 'message_update', message: { role: 'assistant', usage: { output: OUTPUT / 2 } }, assistantMessageEvent: { type: 'text_delta', delta: 'working' } })
    },
    () => {
      if (!stale) contextTokens += OUTPUT
      real(stale ? contextTokens + OUTPUT : contextTokens)
      send({ type: 'message_end', message: { role: 'assistant', usage: { output: OUTPUT } } })
    },
    () => {
      contextTokens += (stale ? OUTPUT : 0) + TOOL_RESULT
      real(contextTokens)
      send({ type: 'tool_execution_end', toolCallId: 'read-' + turn, toolName: 'Read', result: 'ok' })
      send({ type: 'message_end', message: { role: 'toolResult', content: 'ok' } })
      send({ type: 'turn_end' })
    },
  )
}
steps.push(() => send({ type: 'agent_end' }))
const next = () => { const step = steps.shift(); if (!step) return; step(); setTimeout(next, 15) }
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'tool-loop-context', isStreaming: false } })
  } else if (command.type === 'get_session_stats') {
    statsRequests += 1
    const data = { contextUsage: { tokens: contextTokens, contextWindow: 200000, percent: contextTokens / 2000 } }
    const respond = () => send({ id: command.id, type: 'response', command: 'get_session_stats', success: true, data })
    if (statsRequests % 3 === 0) setTimeout(respond, 40)
    else respond()
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: 'prompt', success: true })
    next()
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
      await runtime.command({ type: 'prompt', message: 'go' })
      await waitUntil(() => events.some((event) => event.type === 'agent_end'), 10_000)
      const settled = 40_100 + 20 * (3_000 + 800)
      await waitUntil(() => runtime.snapshot().contextUsage?.tokens === settled)
      expect(events.filter((event) => event.type === 'context_usage').at(-1)?.contextUsage).toEqual({
        tokens: settled,
        contextWindow: 200_000,
        percent: settled / 2_000,
      })

      let real: number | undefined
      let checked = 0
      for (const event of events) {
        if (event.type === 'fake_real_context') real = Number(event.tokens)
        else if (event.type === 'context_usage' && real !== undefined) {
          expect((event.contextUsage as { tokens: number }).tokens).toBeLessThanOrEqual(real)
          checked += 1
        }
      }
      expect(checked).toBeGreaterThan(20)
    } finally {
      await runtime.stop()
    }
  })

  it('does not double-count output persisted while a stats request waits in the harness', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-context-capture-'))
    dirs.push(cwd)
    const executable = join(cwd, 'capture-context-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline')
let requests = 0
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { sessionId: 'capture-context', isStreaming: false } })
  } else if (command.type === 'get_session_stats') {
    requests += 1
    if (requests === 2) {
      // The request has reached the harness, but capture its snapshot only
      // after the following provider response is persisted. No timer race.
      send({ type: 'message_start', message: { role: 'assistant' } })
      send({ type: 'message_end', message: { role: 'assistant', usage: { output: 3000 } } })
    }
    const tokens = requests === 1 ? 40100 : 43100
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens, contextWindow: 200000, percent: tokens / 2000 } } })
    // This next request is a barrier: it cannot be sent until the runtime has
    // applied the preceding response and drained its queued refresh.
    if (requests === 3) send({ type: 'agent_end' })
  } else if (command.type === 'prompt') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
    send({ type: 'agent_start' })
    send({ type: 'message_start', message: { role: 'user', content: 'go' } })
    send({ type: 'message_end', message: { role: 'user', content: 'go' } })
  } else if (command.type === 'abort') {
    send({ id: command.id, type: 'response', command: command.type, success: true })
  }
})
`)
    chmodSync(executable, 0o755)
    const events: Array<Record<string, unknown>> = []
    const runtime = new RpcRuntime(process.execPath, [executable], cwd, ({ event }) => events.push(event), () => undefined)
    try {
      await runtime.handshake()
      await runtime.command({ type: 'prompt', message: 'go' })
      await waitUntil(() => events.some((event) => event.type === 'agent_end'))
      await waitUntil(() => runtime.snapshot().contextUsage?.tokens === 43_100)
      const tokens = events.filter((event) => event.type === 'context_usage').map((event) => (event.contextUsage as { tokens: number }).tokens)
      expect(tokens.length).toBeGreaterThan(1)
      expect(Math.max(...tokens)).toBe(43_100)
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
    const delivered: RpcObject[] = []
    manager.setEventSink(({ event }) => delivered.push(event))
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })).rejects.toThrow(/mismatched response/)
    expect(delivered.filter((event) => event.type === 'transport_error')).toEqual([])
    expect(delivered).toContainEqual(expect.objectContaining({ type: 'transport_limit', kind: 'response' }))
    await expect(manager.command(runtime.runtimeId, { type: 'get_state' })).resolves.toMatchObject({ success: true })
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

  it('releases minted capabilities when workspace admission rejects before spawning', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const manager = managerFor(fake.executable)
    const environment = { PRIME_WORK_BROWSER_TOKEN: 'workspace-denied-token' }
    const ended = vi.fn()
    manager.setRuntimeEnvironmentProvider(() => environment)
    manager.setRuntimeEndListener(ended)
    manager.setWorkspaceUseProvider(async () => { throw new Error('Checkout is in progress') })

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Checkout is in progress')
    expect(ended).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledWith(environment, undefined)
    expect(manager.list()).toEqual([])
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
  it('starts a healthy runtime when its optional capability catalog is unavailable', async () => {
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }")
    const providers = new PrimeProviderService({ authPath: join(fake.cwd, 'auth.json'), modelsPath: join(fake.cwd, 'models.json') })
    vi.spyOn(providers, 'capabilities').mockRejectedValue(new Error('Catalog unavailable'))
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)
    const runtime = await manager.start({ cwd: fake.cwd })
    expect(manager.list()).toMatchObject([{ runtimeId: runtime.runtimeId }])
  })

  it('keeps existing capabilities when catalog refresh fails after successful controls', async () => {
    const state = "{ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'session-1', isStreaming: false, model: { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' } } }"
    const fake = fakeAgent("{ id: command.id, type: 'response', command: 'prompt', success: true }", state, 0, true)
    const providers = new PrimeProviderService({ authPath: join(fake.cwd, 'auth.json'), modelsPath: join(fake.cwd, 'models.json') })
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers)
    managers.push(manager)
    const runtime = await manager.start({ cwd: fake.cwd })
    const model = await providers.capabilities('openai-codex', 'gpt-5.4')
    if (!model) throw new Error('Missing fixture model')
    vi.spyOn(providers, 'requireAvailableModel').mockResolvedValue(model)
    vi.spyOn(providers, 'capabilities').mockRejectedValue(new Error('Catalog unavailable'))
    await expect(manager.command(runtime.runtimeId, { type: 'set_thinking_level', level: 'high' })).resolves.toMatchObject({ success: true })
    await expect(manager.command(runtime.runtimeId, { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.4' })).resolves.toMatchObject({ success: true })
    expect(manager.list()[0]?.availableThinkingLevels).toEqual(runtime.availableThinkingLevels)
    expect(manager.list()[0]?.imageInputSupported).toBe(runtime.imageInputSupported)
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
    expect(events.filter((envelope) => envelope.event.type === 'runtime_exit')).toMatchObject([{ event: { expected: false } }])
    expect(processExists(pid)).toBe(false)
  }, 12_000)


  it('cancels a queued write on timeout so the line never reaches the child and its budget is released', async () => {
    const heldWrites: Array<{ line: string; finish: (error?: Error | null) => void }> = []
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr,
      stdin: {
        writable: true,
        write: (line: string, finish: (error?: Error | null) => void) => { heldWrites.push({ line, finish }); return true },
        end: () => undefined,
        destroy: () => undefined,
      },
    }) as unknown as ChildProcessWithoutNullStreams
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
    const child = Object.assign(new EventEmitter(), {
      stdout, stderr,
      stdin: { writable: true, write: () => true, end: () => undefined, destroy: () => undefined },
    }) as unknown as ChildProcessWithoutNullStreams
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
send({ type: 'fake_ready' })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'sleepy') {
    setTimeout(() => {
      send({ id: command.id, type: 'response', command: 'sleepy', success: true })
      send({ type: 'fake_late_reply_sent' })
    }, 300)
  }
})
setInterval(() => {}, 1000)
`)
    chmodSync(executable, 0o755)
    const events: Array<{ event: { type?: unknown } }> = []
    const runtime = new RpcRuntime(executable, [], cwd, (envelope) => events.push(envelope as unknown as { event: { type?: unknown } }), () => undefined)
    try {
      const request = (runtime as unknown as { request(command: RpcObject, timeoutMs: number): Promise<RpcObject> }).request.bind(runtime)
      await waitUntil(() => events.some((envelope) => envelope.event.type === 'fake_ready'))
      await expect(request({ type: 'sleepy' }, 100)).rejects.toThrow(/timed out after delivery.*do not retry automatically/)
      await waitUntil(() => events.some((envelope) => envelope.event.type === 'fake_late_reply_sent'))
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

/**
 * A Rust-style Prime Agent: it exits on --extension like 0.10 does, answers
 * set_service_tier with 'Unknown command', and records the argv of every
 * spawn and every command it receives.
 */
function fakeRustPrime(): { cwd: string; executable: string; commands: () => RpcObject[]; spawns: () => string[][] } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rust-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-rust-prime.cjs')
  const log = join(cwd, 'commands.jsonl')
  const argvLog = join(cwd, 'argv.jsonl')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
if (process.argv[2] === '--version') { process.stdout.write('0.10.0\\n'); process.exit(0) }
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.includes('--extension')) {
  process.stderr.write('Error: Unknown option: --extension\\n')
  process.exit(1)
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const flag = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const model = flag('--model') ? { provider: flag('--provider'), id: flag('--model'), name: flag('--model') } : { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' }
// A 0.10-only model, in get_available_models' entry shape.
const opus = { provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', api: 'anthropic-messages', reasoning: true, input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { off: null, minimal: null, xhigh: 'xhigh', max: 'max' } }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
  const ok = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  if (command.type === 'get_state') ok({ sessionId: 'rust-session', isStreaming: false, isCompacting: false, model })
  else if (command.type === 'get_session_stats') ok({ contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } })
  else if (command.type === 'list_heartbeats') ok({ heartbeats: [] })
  else if (command.type === 'get_available_models') ok({ models: [opus] })
  else if (['prompt', 'abort', 'set_model', 'cycle_model'].includes(command.type)) ok(command.type === 'cycle_model' ? { model } : undefined)
  else send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command: ' + command.type })
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable, commands: () => readJsonLines<RpcObject>(log), spawns: () => readJsonLines<string[]>(argvLog) }
}

function readJsonLines<T>(path: string): T[] {
  try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as T) } catch { return [] }
}

const extensionEnvironment = { GOOEYPI_COLLABORATION_EXTENSION_PATH: '/app/extensions/omp-work-collaboration.ts' }

/** A Prime manager whose adapter follows `state.implementation`, which starts as TypeScript. */
function recoveringManager(executable: string) {
  const state = { implementation: 'typescript' as PrimeImplementation }
  const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), () => primeRpcAdapter(state.implementation))
  managers.push(manager)
  const environments: NodeJS.ProcessEnv[] = []
  manager.setRuntimeEnvironmentProvider((scope) => {
    const environment = { ...extensionEnvironment, GOOEYPI_TEST_IMPLEMENTATION: scope.implementation ?? 'typescript' }
    environments.push(environment)
    return environment
  })
  const ended = vi.fn()
  manager.setRuntimeEndListener(ended)
  return { manager, state, environments, ended }
}

describe('agent RPC start recovery', () => {
  it('retries a failed start once with the adapter and environment the recovery left behind', async () => {
    const fake = fakeRustPrime()
    const { manager, state, environments, ended } = recoveringManager(fake.executable)
    const recover = vi.fn(async () => { state.implementation = 'rust'; return true })
    manager.setStartRecovery(recover)

    await expect(manager.start({ cwd: fake.cwd })).resolves.toMatchObject({ harness: 'prime', sessionId: 'rust-session' })

    expect(recover).toHaveBeenCalledOnce()
    expect(recover.mock.calls[0]).toEqual([expect.objectContaining({ message: expect.stringContaining('Unknown option: --extension') }), PRIME_RPC_ADAPTER])
    expect(fake.spawns().map((argv) => argv.includes('--extension'))).toEqual([true, false])
    expect(environments.map((environment) => environment.GOOEYPI_TEST_IMPLEMENTATION)).toEqual(['typescript', 'rust'])
    // The failed start released its environment before the retry minted a new one.
    expect(ended).toHaveBeenCalledOnce()
    expect(ended.mock.calls[0][0]).toBe(environments[0])
  })

  it('rethrows the original error when the recovery declines', async () => {
    const fake = fakeRustPrime()
    const { manager } = recoveringManager(fake.executable)
    const recover = vi.fn(async () => false)
    manager.setStartRecovery(recover)

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Prime Agent RPC exited (1): Error: Unknown option: --extension')
    expect(recover).toHaveBeenCalledOnce()
    expect(fake.spawns()).toHaveLength(1)
  })

  it('never retries a retried start', async () => {
    const fake = fakeRustPrime()
    const { manager } = recoveringManager(fake.executable)
    const recover = vi.fn(async () => true)
    manager.setStartRecovery(recover)

    await expect(manager.startUnattended({ cwd: fake.cwd })).rejects.toThrow('Unknown option: --extension')
    expect(recover).toHaveBeenCalledOnce()
    expect(fake.spawns()).toHaveLength(2)
  })
})

describe('Prime start recovery', () => {
  const rejected = new Error('Prime Agent RPC exited (1): Error: Unknown option: --extension')

  it('re-detects Prime once and retries a TypeScript start that Rust Prime rejected', async () => {
    const fake = fakeRustPrime()
    const { manager, state } = recoveringManager(fake.executable)
    const redetect = vi.fn(async () => { state.implementation = 'rust'; return state.implementation })
    manager.setStartRecovery(primeStartRecovery(redetect))

    await expect(manager.start({ cwd: fake.cwd })).resolves.toMatchObject({ harness: 'prime', sessionId: 'rust-session' })
    expect(redetect).toHaveBeenCalledOnce()
    expect(fake.spawns().map((argv) => argv.includes('--extension'))).toEqual([true, false])
  })

  it('does not re-detect Prime for a start that failed for another reason', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-rpc-other-exit-'))
    dirs.push(cwd)
    const executable = join(cwd, 'no-models-agent.cjs')
    writeFileSync(executable, `#!/usr/bin/env node
process.stderr.write('Error: No models available. Check your installation or add models to models.json.\\n')
process.exit(1)
`)
    chmodSync(executable, 0o755)
    const { manager } = recoveringManager(executable)
    const redetect = vi.fn(async () => 'rust' as const)
    manager.setStartRecovery(primeStartRecovery(redetect))

    await expect(manager.start({ cwd })).rejects.toThrow('Prime Agent RPC exited (1): Error: No models available')
    expect(redetect).not.toHaveBeenCalled()
  })

  it('re-detects only for a rejected TypeScript Prime start', async () => {
    const redetect = vi.fn(async () => 'rust' as const)
    const recover = primeStartRecovery(redetect)

    await expect(recover(rejected, PRIME_RUST_RPC_ADAPTER)).resolves.toBe(false)
    await expect(recover(rejected, OMP_RPC_ADAPTER)).resolves.toBe(false)
    await expect(recover(rejected.message, PRIME_RPC_ADAPTER)).resolves.toBe(false)
    expect(redetect).not.toHaveBeenCalled()
    await expect(recover(rejected, PRIME_RPC_ADAPTER)).resolves.toBe(true)
    expect(redetect).toHaveBeenCalledOnce()
  })

  it('declines when Prime still classifies as TypeScript', async () => {
    await expect(primeStartRecovery(async () => 'typescript')(rejected, PRIME_RPC_ADAPTER)).resolves.toBe(false)
    await expect(primeStartRecovery(async () => undefined)(rejected, PRIME_RPC_ADAPTER)).resolves.toBe(false)
  })
})

describe('Rust Prime runtimes', () => {

  it('starts Rust Prime without --extension once the adapter source reports Rust', async () => {
    const fake = fakeRustPrime()
    let implementation: 'typescript' | 'rust' = 'typescript'
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), () => primeRpcAdapter(implementation))
    managers.push(manager)
    const implementations: Array<string | undefined> = []
    manager.setRuntimeEnvironmentProvider((scope) => { implementations.push(scope.implementation); return extensionEnvironment })

    await expect(manager.start({ cwd: fake.cwd })).rejects.toThrow('Prime Agent RPC exited (1): Error: Unknown option: --extension')
    implementation = 'rust'
    await expect(manager.start({ cwd: fake.cwd })).resolves.toMatchObject({ harness: 'prime', sessionId: 'rust-session' })

    expect(implementations).toEqual([undefined, 'rust'])
  })

  it('starts on a 0.10-only model, validated against the catalog Rust Prime itself reports', async () => {
    const fake = fakeRustPrime()
    const providers = new PrimeProviderService({ authPath: join(fake.cwd, 'auth.json'), modelsPath: join(fake.cwd, 'models.json'), executable: fake.executable, implementation: () => 'rust' })
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers, () => new Set(), PRIME_RUST_RPC_ADAPTER)
    managers.push(manager)

    const runtime = await manager.start({ cwd: fake.cwd, model: 'anthropic/claude-opus-5-5', thinking: 'xhigh' })

    expect(fake.spawns()).toEqual([
      ['--mode', 'rpc', '--no-session'],
      ['--mode', 'rpc', '--cwd', fake.cwd, '--provider', 'anthropic', '--model', 'claude-opus-5-5', '--thinking', 'xhigh'],
    ])
    expect(runtime).toMatchObject({
      model: { provider: 'anthropic', id: 'claude-opus-5-5' },
      availableThinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      imageInputSupported: true,
      fastModeSupported: false,
    })
    // A 0.7 model that Rust does not list is refused before anything is spawned.
    await expect(manager.start({ cwd: fake.cwd, model: 'anthropic/claude-opus-4-1' })).rejects.toThrow('Model was not found in the Prime Agent catalog')
    expect(fake.spawns()).toHaveLength(2)
  })

  it('refuses the commands 0.10 RPC cannot run before they reach the agent', async () => {
    const fake = fakeRustPrime()
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), PRIME_RUST_RPC_ADAPTER)
    managers.push(manager)
    const runtime = await manager.start({ cwd: fake.cwd })

    await expect(manager.command(runtime.runtimeId, { type: 'manage_heartbeat', activeSessionId: 'rust-session', jobId: 'heartbeat-1', action: 'pause' }))
      .rejects.toThrow(new UnsupportedRpcCommandError('manage_heartbeat', 'Rust Prime Agent'))
    await expect(manager.command(runtime.runtimeId, { type: 'extension_ui_response', id: 'ui-1', cancelled: true }))
      .rejects.toBeInstanceOf(UnsupportedRpcCommandError)
    await expect(manager.command(runtime.runtimeId, { type: 'list_heartbeats' })).resolves.toMatchObject({ data: { heartbeats: [] } })
    expect(fake.commands().map((command) => command.type)).not.toContain('manage_heartbeat')
    expect(fake.commands().map((command) => command.type)).not.toContain('extension_ui_response')
  })

  it('reports fast mode as unavailable and never sends a service tier', async () => {
    const fake = fakeRustPrime()
    const fastModel = {
      key: 'openai-codex/gpt-5.4', provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true,
      input: ['text'], contextWindow: 1_000, maxTokens: 100, availableThinkingLevels: ['off', 'high'], fastModeSupported: true, available: true,
    }
    const providers = { capabilities: async () => fastModel, requireAvailableModel: async () => fastModel } as unknown as PrimeProviderService
    const manager = new AgentRpcManager(fake.executable, async (cwd) => cwd, async (path) => path, providers, () => new Set(), PRIME_RUST_RPC_ADAPTER)
    managers.push(manager)

    const runtime = await manager.start({ cwd: fake.cwd, fast: true })

    expect(runtime).toMatchObject({ fastModeSupported: false, fastModeAvailable: false, serviceTier: 'default' })
    await manager.command(runtime.runtimeId, { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-5.4' })
    await manager.command(runtime.runtimeId, { type: 'cycle_model' })
    await expect(manager.command(runtime.runtimeId, { type: 'set_service_tier', serviceTier: 'priority' }))
      .rejects.toThrow('Service tier is not supported by the Prime Agent harness')
    expect(manager.list()[0]).toMatchObject({ fastModeSupported: false, fastModeAvailable: false })
    expect(fake.commands().map((command) => command.type)).not.toContain('set_service_tier')
  })
})

/**
 * A Prime Agent that, like the Rust build, reports its steering queue only in
 * get_state: it never emits session_action_update, reports an active turn
 * only while its scripted run is going, and delivers a queued steer as a user
 * message_start at the next turn boundary. Like Rust, it can send agent_end
 * before it stops reporting the run: the first `staleStateReads` get_state
 * answers after agent_end still say the run is going.
 */
function fakeQueueingPrime(turnMs = 300, staleStateReads = 0): { cwd: string; executable: string; commands: () => RpcObject[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-queueing-rpc-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-queueing-prime.cjs')
  const log = join(cwd, 'commands.jsonl')
  writeFileSync(executable, `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let streaming = false
let staleReads = 0
const steering = []
const actions = (running) => ({ queuedCount: steering.length, steering: [...steering], followUps: [], ...(running ? { active: { kind: 'turn', phase: 'running' } } : {}) })
const deliver = (text) => {
  const message = { role: 'user', content: [{ type: 'text', text }] }
  send({ type: 'message_start', message })
  send({ type: 'message_end', message })
}
const answer = (text) => {
  send({ type: 'message_start', message: { role: 'assistant', content: [] } })
  send({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: text } })
  send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })
  send({ type: 'turn_end' })
}
const run = (prompt) => {
  streaming = true
  send({ type: 'agent_start' })
  send({ type: 'turn_start' })
  deliver(prompt)
  setTimeout(() => {
    answer('first answer')
    while (steering.length) {
      send({ type: 'turn_start' })
      deliver(steering.shift())
      answer('steer answer')
    }
    streaming = false
    staleReads = ${staleStateReads}
    send({ type: 'agent_end', messages: [] })
  }, ${turnMs})
}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  require('node:fs').appendFileSync(${JSON.stringify(log)}, line + '\\n')
  const ok = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  if (command.type === 'get_state') {
    const running = streaming || staleReads > 0
    if (!streaming && staleReads > 0) staleReads -= 1
    ok({ sessionId: 'queueing', isStreaming: running, isCompacting: false, sessionActions: actions(running) })
  }
  else if (command.type === 'get_session_stats') ok({ contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } })
  else if (command.type === 'prompt') { ok(); run(command.message) }
  else if (command.type === 'steer') { steering.push(command.message); ok() }
  else if (command.type === 'abort') ok()
  else send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Unknown command: ' + command.type })
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable, commands: () => readJsonLines<RpcObject>(log) }
}

describe('session actions without harness session_action_update events', () => {
  const running = { kind: 'turn', phase: 'running' }
  const queueingManager = (executable: string, adapter: HarnessRpcAdapter, events: RpcObject[]): AgentRpcManager => {
    const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path, undefined, () => new Set(), adapter)
    managers.push(manager)
    manager.setEventSink(({ event }) => events.push(event))
    return manager
  }

  it('drops the finished turn from the snapshot so a new session replaces the idle runtime', async () => {
    const fake = fakeQueueingPrime()
    const events: RpcObject[] = []
    const manager = queueingManager(fake.executable, PRIME_RUST_RPC_ADAPTER, events)
    const first = await manager.start({ cwd: fake.cwd })

    await manager.command(first.runtimeId, { type: 'prompt', message: 'hello' })
    await waitUntil(() => manager.list()[0]?.sessionActions?.active !== undefined)
    await waitUntil(() => events.some((event) => event.type === 'agent_end'))
    await waitUntil(() => manager.list()[0]?.sessionActions?.active === undefined, 2_000)

    expect(manager.list()[0]).toMatchObject({ isStreaming: false, sessionActions: { queuedCount: 0, steering: [], followUps: [] } })
    // One synthetic update per change: the running turn, then its end.
    expect(events.filter((event) => event.type === 'session_action_update')).toEqual([
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } },
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [] } },
    ])
    const second = await manager.start({ cwd: fake.cwd })
    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([second.runtimeId])
  })

  const stateReadsAfterPrompt = (fake: { commands: () => RpcObject[] }): number => {
    const types = fake.commands().map((command) => command.type)
    return types.slice(types.lastIndexOf('prompt') + 1).filter((type) => type === 'get_state').length
  }
  const synthetic = (events: RpcObject[]) => events.filter((event) => event.type === 'session_action_update')

  it('keeps a run ended while get_state still reports it after agent_end', async () => {
    const fake = fakeQueueingPrime(100, 3)
    const events: RpcObject[] = []
    const manager = queueingManager(fake.executable, PRIME_RUST_RPC_ADAPTER, events)
    const first = await manager.start({ cwd: fake.cwd })

    await manager.command(first.runtimeId, { type: 'prompt', message: 'hello' })
    // The prompt's own refresh, the refresh at agent_end, then one more read
    // for each of the three answers that still report the run.
    await waitUntil(() => stateReadsAfterPrompt(fake) === 5, 1_500)
    await manager.command(first.runtimeId, { type: 'get_state' })

    expect(manager.list()[0]).toMatchObject({ isStreaming: false, sessionActions: { queuedCount: 0, steering: [], followUps: [] } })
    expect(manager.list()[0]?.sessionActions?.active).toBeUndefined()
    expect(stateReadsAfterPrompt(fake)).toBe(6)
    expect(synthetic(events)).toEqual([
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } },
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [] } },
    ])
    const second = await manager.start({ cwd: fake.cwd })
    expect(manager.list().map((runtime) => runtime.runtimeId)).toEqual([second.runtimeId])
  })

  it('drops the active turn as soon as agent_end arrives', async () => {
    const fake = fakeQueueingPrime(60_000)
    const events: RpcObject[] = []
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, {}, PRIME_RUST_RPC_ADAPTER)
    try {
      await runtime.handshake()
      await runtime.command({ type: 'prompt', message: 'hello' })
      await waitUntil(() => runtime.snapshot().sessionActions?.active !== undefined)
      ;(runtime as unknown as { handleFrame(frame: RpcObject): void }).handleFrame({ type: 'agent_end', messages: [] })

      expect(runtime.snapshot().sessionActions).toEqual({ queuedCount: 0, steering: [], followUps: [] })
      expect(events.slice(-2)).toEqual([
        { type: 'agent_end', messages: [] },
        { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [] } },
      ])
    } finally {
      await runtime.stop()
    }
  })

  it('believes get_state again once the next run starts', async () => {
    const fake = fakeQueueingPrime(100, 1_000)
    const events: RpcObject[] = []
    const manager = queueingManager(fake.executable, PRIME_RUST_RPC_ADAPTER, events)
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'first' })
    await waitUntil(() => events.some((event) => event.type === 'agent_end'))
    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'second' })

    await waitUntil(() => manager.list()[0]?.sessionActions?.active !== undefined, 1_000)
    expect(manager.list()[0]).toMatchObject({ isStreaming: true, sessionActions: { active: running } })
  })

  it('stops asking get_state soon after agent_end and still never revives the run', async () => {
    const fake = fakeQueueingPrime(100, 1_000)
    const events: RpcObject[] = []
    const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, { pollIntervalMs: 60_000 }, PRIME_RUST_RPC_ADAPTER)
    try {
      await runtime.handshake()
      await runtime.command({ type: 'prompt', message: 'hello' })
      await waitUntil(() => events.some((event) => event.type === 'agent_end'))
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_300))
      const reads = stateReadsAfterPrompt(fake)
      await new Promise((resolveWait) => setTimeout(resolveWait, 400))

      expect(stateReadsAfterPrompt(fake)).toBe(reads)
      expect(runtime.snapshot()).toMatchObject({ isStreaming: false, sessionActions: { queuedCount: 0, steering: [], followUps: [] } })
      expect(runtime.snapshot().sessionActions?.active).toBeUndefined()
    } finally {
      await runtime.stop()
    }
  })

  it('settles a delivered steer ahead of the user message that carries it', async () => {
    const fake = fakeQueueingPrime(400)
    const events: RpcObject[] = []
    const manager = queueingManager(fake.executable, PRIME_RUST_RPC_ADAPTER, events)
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'go' })
    const admitted = await manager.command(runtime.runtimeId, { type: 'steer', message: 'STEER-ME' })
    expect(admitted.sessionActions).toEqual({ queuedCount: 1, steering: ['STEER-ME'], followUps: [], active: running })
    await waitUntil(() => events.some((event) => event.type === 'agent_end'))

    const delivery = events.findIndex((event) => event.type === 'message_start' && JSON.stringify(event.message).includes('STEER-ME'))
    expect(delivery).toBeGreaterThan(0)
    expect(events[delivery - 1]).toEqual({ type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } })
  })

  it('leaves session actions to the harness events on TypeScript Prime', async () => {
    const fake = fakeQueueingPrime(300)
    const events: RpcObject[] = []
    const manager = queueingManager(fake.executable, PRIME_RPC_ADAPTER, events)
    const runtime = await manager.start({ cwd: fake.cwd })

    await manager.command(runtime.runtimeId, { type: 'prompt', message: 'hello' })
    await manager.command(runtime.runtimeId, { type: 'steer', message: 'STEER-ME' })
    await waitUntil(() => events.some((event) => event.type === 'agent_end'))
    // Whatever the runtime sent at agent_end is answered before this.
    await manager.command(runtime.runtimeId, { type: 'get_state' })

    expect(events.some((event) => event.type === 'session_action_update')).toBe(false)
    // The prompt's refresh, the steer's admission check and the call above: none at agent_end.
    expect(stateReadsAfterPrompt(fake)).toBe(3)
  })
})

describe('Rust Prime event normalization', () => {
  const running = { kind: 'turn' as const, phase: 'running' as const }
  const state = (sessionActions: SessionActionSnapshot): RuntimeInfo => ({ runtimeId: 'runtime', harness: 'prime', cwd: '/project', isStreaming: true, sessionActions })
  const queued = state({ queuedCount: 1, steering: ['change direction'], followUps: [], active: running })
  const delivered = {
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'change' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text', text: 'direction' }] },
  }

  it('puts the queue change ahead of a delivered steer', () => {
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(delivered, queued)).toEqual([
      { type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } },
      delivered,
    ])
  })

  it('passes every other message through untouched', () => {
    const prompt = { type: 'message_start', message: { role: 'user', content: 'first prompt' } }
    const assistant = { type: 'message_start', message: { role: 'assistant', content: [] } }
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(prompt, queued)).toBe(prompt)
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(assistant, queued)).toBe(assistant)
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(delivered, { ...queued, isStreaming: false })).toBe(delivered)
    expect(PRIME_RPC_ADAPTER.normalizeEvent(delivered, queued)).toBe(delivered)
  })

  // The agent_end Rust Prime 0.10 sends when the provider answers 529.
  const failedRun = (stopReason: string, errorMessage?: string) => ({
    type: 'agent_end',
    messages: [
      { role: 'custom', customType: 'harness_digest', content: '[harness-digest]', display: false },
      { role: 'user', content: [{ type: 'text', text: 'retry me' }] },
      { role: 'assistant', content: [], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
    ],
  })
  const overloaded = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

  it('follows a run that failed at the provider with an error event', () => {
    const event = failedRun('error', overloaded)
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(event, queued)).toEqual([event, { type: 'error', error: overloaded, synthetic: true }])
    const [, error] = PRIME_RUST_RPC_ADAPTER.normalizeEvent(failedRun('error', ` ${'x'.repeat(5_000)} `), queued) as RpcObject[]
    expect(error.error).toBe('x'.repeat(4_000))
  })

  it('ends every other run with its agent_end alone', () => {
    for (const event of [failedRun('aborted', 'Request was aborted'), failedRun('stop'), failedRun('error'), failedRun('error', '  '), { type: 'agent_end' }]) {
      expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(event, queued)).toBe(event)
    }
    const earlierFailure = { type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', errorMessage: overloaded }, { role: 'assistant', stopReason: 'stop' }] }
    expect(PRIME_RUST_RPC_ADAPTER.normalizeEvent(earlierFailure, queued)).toBe(earlierFailure)
    const typescript = failedRun('error', overloaded)
    expect(PRIME_RPC_ADAPTER.normalizeEvent(typescript, queued)).toBe(typescript)
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
