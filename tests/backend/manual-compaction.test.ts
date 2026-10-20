import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RUST_RPC_ADAPTER, type HarnessRpcAdapter } from '../../electron/main/agent-rpc'
import { RpcRuntime } from '../../electron/main/agent-rpc/runtime'
import type { RpcObject } from '../../electron/main/agent-rpc/types'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
const runtimes: RpcRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A harness whose compact command runs `compactScript` (with `command` and
 * `send` in scope); every other command answers the way the runtime's
 * handshake and refreshes expect.
 */
function fakeCompactingAgent(compactScript: string): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-manual-compaction-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-compacting-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  const ok = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  if (command.type === 'compact') { ${compactScript} }
  else if (command.type === 'negotiate_protocol') ok({ protocolVersion: command.protocolVersion })
  else if (command.type === 'get_state') ok({ sessionId: 'compacting', isStreaming: false, isCompacting: false })
  else if (command.type === 'get_session_stats') ok({ contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 } })
  else ok()
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

async function startRuntime(compactScript: string, adapter: HarnessRpcAdapter, events: RpcObject[]): Promise<RpcRuntime> {
  const fake = fakeCompactingAgent(compactScript)
  const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, {}, adapter)
  runtimes.push(runtime)
  await runtime.handshake()
  return runtime
}

const compactionEvents = (events: RpcObject[]): RpcObject[] => events.filter((event) => event.type === 'compaction_start' || event.type === 'compaction_end')

const RESULT = { summary: 'The story so far', firstKeptEntryId: 'kept-1', tokensBefore: 148 }

describe('manual compaction lifecycle', () => {
  it('publishes the compaction a compact command answered with when the harness streamed none', async () => {
    // OMP 18 answers a manual compact with the result alone: no lifecycle events.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`ok(${JSON.stringify(RESULT)})`, OMP_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact', customInstructions: 'keep the plan' })).resolves.toMatchObject({ success: true, data: RESULT })

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'manual', customInstructions: 'keep the plan', synthetic: true },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, customInstructions: 'keep the plan', result: RESULT, synthetic: true },
    ])
    expect(runtime.snapshot().isCompacting).toBe(false)
  })

  it('forwards the lifecycle a harness streamed for its compact command exactly once', async () => {
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'manual' })
      send({ type: 'compaction_end', reason: 'manual', result: ${JSON.stringify(RESULT)}, aborted: false, willRetry: false })
      ok(${JSON.stringify(RESULT)})`, PI_RPC_ADAPTER, events)

    await runtime.command({ type: 'compact' })
    // Past any late frame, to prove nothing is synthesized after the real pair.
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result: RESULT, aborted: false, willRetry: false },
    ])
  })

  it('publishes a failed compaction for a compact command that failed without streaming one', async () => {
    const events: RpcObject[] = []
    const runtime = await startRuntime(`send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Summarizer unavailable' })`, OMP_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).rejects.toThrow('Summarizer unavailable')

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'manual', synthetic: true },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorMessage: 'Summarizer unavailable', synthetic: true },
    ])
  })

  it('completes a bare streamed end with the error its compact command failed with', async () => {
    // Rust Prime 0.10 streams the same bare end for every unsuccessful compaction.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'requested' })
      send({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Compaction failed: Summarization failed' })`, PRIME_RUST_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).rejects.toThrow('Compaction failed: Summarization failed')

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'requested' },
      { type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false, errorMessage: 'Compaction failed: Summarization failed' },
    ])
  })

  it('keeps the outcome a streamed end already reports', async () => {
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'manual' })
      send({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Compaction cancelled' })`, PI_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).rejects.toThrow('Compaction cancelled')

    expect(compactionEvents(events).at(-1)).toEqual({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false })
  })

  it('closes a running compaction the watchdog announced with the answered result', async () => {
    const events: RpcObject[] = []
    const runtime = await startRuntime(`setTimeout(() => ok(${JSON.stringify(RESULT)}), 50)`, OMP_RPC_ADAPTER, events)
    const pending = runtime.command({ type: 'compact' })
    const observe = runtime as unknown as { observePolledCompaction(isCompacting: boolean): void }
    observe.observePolledCompaction(true)
    await pending
    await waitUntil(() => events.some((event) => event.type === 'compaction_end'))

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', synthetic: true },
      expect.objectContaining({ type: 'compaction_end', result: RESULT }),
    ])
  })
})
