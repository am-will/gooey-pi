import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER, PRIME_RUST_RPC_ADAPTER, type HarnessRpcAdapter } from '../../electron/main/agent-rpc'
import { isCompactRefusal } from '../../electron/main/agent-rpc/manual-compaction'
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
 * `send` in scope) and whose abort runs `abortScript` (with the compact
 * command as `compacting`); every other command answers the way the
 * runtime's handshake and refreshes expect.
 */
function fakeCompactingAgent(compactScript: string, abortScript: string): { cwd: string; executable: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-manual-compaction-'))
  dirs.push(cwd)
  const executable = join(cwd, 'fake-compacting-agent.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let compacting
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  const ok = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, ...(data ? { data } : {}) })
  if (command.type === 'compact') { compacting = command; ${compactScript} }
  else if (command.type === 'abort') { ${abortScript} }
  else if (command.type === 'negotiate_protocol') ok({ protocolVersion: command.protocolVersion })
  else if (command.type === 'get_state') ok({ sessionId: 'compacting', isStreaming: false, isCompacting: false })
  else if (command.type === 'get_session_stats') ok({ contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 } })
  else ok()
})
`)
  chmodSync(executable, 0o755)
  return { cwd, executable }
}

async function startRuntime(compactScript: string, adapter: HarnessRpcAdapter, events: RpcObject[], abortScript = 'ok()'): Promise<RpcRuntime> {
  const fake = fakeCompactingAgent(compactScript, abortScript)
  const runtime = new RpcRuntime(fake.executable, [], fake.cwd, ({ event }) => events.push(event), () => undefined, {}, {}, adapter)
  runtimes.push(runtime)
  await runtime.handshake()
  return runtime
}

const compactionEvents = (events: RpcObject[]): RpcObject[] => events.filter((event) => event.type === 'compaction_start' || event.type === 'compaction_end')

const RESULT = { summary: 'The story so far', firstKeptEntryId: 'kept-1', tokensBefore: 148 }
const PRIME_TOO_SHORT = 'Session is too short to compact — try again once it grows'

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

  it('answers a refusal because there is nothing to compact yet as a skipped compaction', async () => {
    // Pi 1.3 streams the refusal as a failed end, then fails the command.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'manual' })
      send({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorMessage: 'Compaction failed: Nothing to compact (session too small)' })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Nothing to compact (session too small)' })`, PI_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).resolves.toEqual({
      type: 'response', command: 'compact', success: true, data: { skipped: true, message: 'Nothing to compact (session too small)' },
    })

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorSeverity: 'warning', errorMessage: 'Nothing to compact (session too small)' },
    ])
  })

  it('skips a refused compaction whatever its harness streamed for it', async () => {
    const omp: RpcObject[] = []
    const ompRuntime = await startRuntime(`send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Already compacted' })`, OMP_RPC_ADAPTER, omp)
    await expect(ompRuntime.command({ type: 'compact' })).resolves.toMatchObject({ success: true, data: { skipped: true } })
    expect(compactionEvents(omp).at(-1)).toMatchObject({ synthetic: true, errorSeverity: 'warning', errorMessage: 'Already compacted' })

    const rust: RpcObject[] = []
    const rustRuntime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'requested' })
      send({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: ${JSON.stringify(PRIME_TOO_SHORT)} })`, PRIME_RUST_RPC_ADAPTER, rust)
    await expect(rustRuntime.command({ type: 'compact' })).resolves.toMatchObject({ success: true, data: { skipped: true } })
    expect(compactionEvents(rust).at(-1)).toEqual({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false, errorSeverity: 'warning', errorMessage: PRIME_TOO_SHORT })
  })

  it('trusts a streamed end that marks the refusal itself', async () => {
    // TypeScript Prime reports a skip as a warning on its end event.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, errorSeverity: 'warning', errorMessage: 'Nothing new since the last summary' })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: 'Nothing new since the last summary' })`, PRIME_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).resolves.toMatchObject({ success: true, data: { skipped: true, message: 'Nothing new since the last summary' } })
  })

  it('forwards at once the end of an automatic compaction the compact command interrupted', async () => {
    // Pi aborts a running threshold compaction before it starts the manual one.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_end', reason: 'threshold', aborted: true, willRetry: false })
      send({ type: 'compaction_start', reason: 'manual' })
      send({ type: 'compaction_end', reason: 'manual', result: ${JSON.stringify(RESULT)}, aborted: false, willRetry: false })
      ok(${JSON.stringify(RESULT)})`, PI_RPC_ADAPTER, events)
    const frames = runtime as unknown as { handleFrame(frame: RpcObject): void }
    frames.handleFrame({ type: 'compaction_start', reason: 'threshold' })

    await runtime.command({ type: 'compact' })

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'threshold' },
      { type: 'compaction_end', reason: 'threshold', aborted: true, willRetry: false },
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', result: RESULT, aborted: false, willRetry: false },
    ])
  })

  it('closes a compaction with its own end when a run starts before the command answers', async () => {
    // Rust Prime kicks its queue pump before it writes the end and the answer,
    // so a steer parked during the compaction can start its run in between.
    // Its bare end waits for the answer to say the compaction was skipped.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'requested' })
      send({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false })
      send({ type: 'agent_start' })
      send({ id: command.id, type: 'response', command: 'compact', success: false, error: ${JSON.stringify(PRIME_TOO_SHORT)} })`, PRIME_RUST_RPC_ADAPTER, events)

    await expect(runtime.command({ type: 'compact' })).resolves.toMatchObject({ success: true, data: { skipped: true } })

    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'requested' },
      { type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false, errorSeverity: 'warning', errorMessage: PRIME_TOO_SHORT },
    ])
    expect(events.some((event) => event.type === 'agent_start')).toBe(true)
  })

  it('forwards at once a streamed end that already reports its result', async () => {
    // Nothing in the answer can change a result, and the run a steer starts
    // right after must not appear to open before the compaction closed.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`
      send({ type: 'compaction_start', reason: 'manual' })
      send({ type: 'compaction_end', reason: 'manual', result: ${JSON.stringify(RESULT)}, aborted: false, willRetry: false })
      send({ type: 'agent_start' })
      ok(${JSON.stringify(RESULT)})`, PI_RPC_ADAPTER, events)

    await runtime.command({ type: 'compact' })

    expect(events.map((event) => event.type).filter((type) => type === 'agent_start' || type === 'compaction_start' || type === 'compaction_end'))
      .toEqual(['compaction_start', 'compaction_end', 'agent_start'])
  })

  it('forwards the end a harness streamed for a compaction its runtime stopped', async () => {
    // Pi cancels a running compaction on abort, streams an aborted end, then
    // fails the compact command.
    const events: RpcObject[] = []
    const runtime = await startRuntime(`send({ type: 'compaction_start', reason: 'manual' })`, PI_RPC_ADAPTER, events, `
      send({ type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false })
      send({ id: compacting.id, type: 'response', command: 'compact', success: false, error: 'Compaction cancelled' })
      ok()`)
    const answered = expect(runtime.command({ type: 'compact' })).rejects.toThrow('Compaction cancelled')
    await waitUntil(() => events.some((event) => event.type === 'compaction_start'))

    await runtime.stop()

    await answered
    expect(compactionEvents(events)).toEqual([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', reason: 'manual', aborted: true, willRetry: false },
    ])
  })

  it('completes the bare end a stopped runtime holds from the answer', async () => {
    const events: RpcObject[] = []
    const runtime = await startRuntime(`send({ type: 'compaction_start', reason: 'requested' })`, PRIME_RUST_RPC_ADAPTER, events, `
      send({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false })
      send({ id: compacting.id, type: 'response', command: 'compact', success: false, error: 'Compaction failed: aborted' })
      ok()`)
    const answered = expect(runtime.command({ type: 'compact' })).rejects.toThrow('Compaction failed: aborted')
    await waitUntil(() => events.some((event) => event.type === 'compaction_start'))

    await runtime.stop()

    await answered
    expect(compactionEvents(events).at(-1)).toEqual({ type: 'compaction_end', reason: 'requested', aborted: false, willRetry: false, errorMessage: 'Compaction failed: aborted' })
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

describe('compact refusals', () => {
  // The errors each harness fails a compact command with, as the installed
  // CLIs (Pi 1.3.0, OMP 18.12.3, Prime 0.10.0 and the bundled 0.7) answer.
  const cases: Array<[string, HarnessRpcAdapter, string[], string[]]> = [
    ['Pi', PI_RPC_ADAPTER,
      ['Nothing to compact (session too small)', 'Already compacted'],
      ['Compaction cancelled', 'Compaction failed: Nothing to compact (session too small)', 'No model selected']],
    ['OMP', OMP_RPC_ADAPTER,
      ['Nothing to compact (session too small)', 'Nothing to compact (session too small or already rolled over)', 'Already compacted'],
      ['Compaction already in progress', 'No configured compaction method can run manually.', 'Compaction cancelled']],
    ['Rust Prime', PRIME_RUST_RPC_ADAPTER,
      [PRIME_TOO_SHORT, 'Already compacted'],
      ['Compaction failed: Summarization failed', 'Session is too short']],
    ['TypeScript Prime', PRIME_RPC_ADAPTER,
      [PRIME_TOO_SHORT, 'Already compacted'],
      ['Compaction failed: Summarization failed', 'Already compacted twice']],
  ]

  it.each(cases)('recognizes %s refusals by their error alone', (_harness, adapter, refusals, failures) => {
    for (const error of refusals) expect(isCompactRefusal(adapter, undefined, error), error).toBe(true)
    for (const error of failures) expect(isCompactRefusal(adapter, undefined, error), error).toBe(false)
  })

  it('never takes a cancelled compaction for a refusal', () => {
    expect(isCompactRefusal(PI_RPC_ADAPTER, { type: 'compaction_end', aborted: true, errorSeverity: 'warning' }, 'Already compacted')).toBe(false)
  })
})
