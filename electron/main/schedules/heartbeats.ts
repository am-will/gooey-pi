import { assertNoMcpAuthenticationCommand } from '../../../src/lib/mcp-policy'
import { RUST_PRIME_AGENT_NAME, RUST_PRIME_HEARTBEAT_PAUSE_DETAIL } from '../../../src/lib/prime-compat'
import type { NativeHeartbeatRecord, PrimeImplementation } from '../../../src/types/api'
import { UnsupportedRpcCommandError, type AgentRpcManager } from '../agent-rpc'
import { resolveExecutable, runProcess, type ExecutableSource } from '../process-utils'
import { isRecord, requireId } from '../validation'

function normalizeHeartbeat(value: unknown, runtimeId?: string): NativeHeartbeatRecord | null {
  const wrapper = isRecord(value) && isRecord(value.job) ? value.job : value
  if (!isRecord(wrapper) || (wrapper.source !== 'heartbeat' && wrapper.source !== 'rlm_heartbeat')) return null
  if (wrapper.status !== 'active' && wrapper.status !== 'paused') return null
  if (typeof wrapper.id !== 'string' || typeof wrapper.prompt !== 'string' || typeof wrapper.sessionId !== 'string'
    || typeof wrapper.sessionFile !== 'string' || typeof wrapper.activeSessionId !== 'string') return null
  let schedule = ''
  if (typeof wrapper.schedule === 'string') schedule = wrapper.schedule
  else if (isRecord(wrapper.schedule) && typeof wrapper.schedule.expression === 'string') schedule = wrapper.schedule.expression
  return {
    id: wrapper.id.slice(0, 256),
    source: wrapper.source,
    status: wrapper.status,
    prompt: wrapper.prompt.slice(0, 1024 * 1024),
    schedule: schedule.slice(0, 2_048),
    sessionId: wrapper.sessionId.slice(0, 256),
    sessionFile: wrapper.sessionFile.slice(0, 4_096),
    activeSessionId: wrapper.activeSessionId.slice(0, 256),
    deliveryMode: wrapper.deliveryMode === 'steer' || wrapper.deliveryMode === 'follow_up' ? wrapper.deliveryMode : undefined,
    nextRunAt: typeof wrapper.nextRunAt === 'string' && Number.isFinite(Date.parse(wrapper.nextRunAt)) ? wrapper.nextRunAt : undefined,
    lastRunAt: typeof wrapper.lastRunAt === 'string' && Number.isFinite(Date.parse(wrapper.lastRunAt)) ? wrapper.lastRunAt : undefined,
    label: typeof wrapper.label === 'string' ? wrapper.label.slice(0, 200) : undefined,
    runtimeId,
  }
}

type HeartbeatAction = 'pause' | 'resume' | 'stop'

/** A runtime whose harness has no heartbeat commands answers nothing; any other failure is real. */
function unlessUnsupported(error: unknown): undefined {
  if (error instanceof UnsupportedRpcCommandError) return undefined
  throw error
}

/**
 * Why GooeyPi could not act on a native heartbeat itself. TypeScript Prime
 * manages a job through the RPC of the session that owns it. Rust Prime's
 * in-process RPC has no heartbeat commands: only its background service
 * pauses or resumes a job, and GooeyPi stops one through the CLI.
 */
function heartbeatActionUnavailable(action: HeartbeatAction, implementation: PrimeImplementation | undefined): Error {
  if (implementation !== 'rust') return new Error('Open the owning Prime session before pausing or resuming this native heartbeat')
  if (action === 'stop') return new Error(`${RUST_PRIME_AGENT_NAME} could not stop this native heartbeat. Check that its background service is running and try again.`)
  return new Error(RUST_PRIME_HEARTBEAT_PAUSE_DETAIL)
}

export class HeartbeatService {
  constructor(
    private readonly agents: AgentRpcManager,
    private readonly primeAgentPath: ExecutableSource,
    private readonly primeImplementation: () => PrimeImplementation | undefined = () => undefined,
  ) {}

  async list(): Promise<NativeHeartbeatRecord[]> {
    const byId = new Map<string, NativeHeartbeatRecord>()
    const runtimes = this.agents.list()
    await Promise.all(runtimes.map(async (runtime) => {
      try {
        const response = await this.agents.command(runtime.runtimeId, { type: 'list_heartbeats' })
        if (!isRecord(response.data) || !Array.isArray(response.data.heartbeats)) return
        for (const value of response.data.heartbeats) {
          const heartbeat = normalizeHeartbeat(value, runtime.runtimeId)
          if (heartbeat && !byId.has(heartbeat.id)) byId.set(heartbeat.id, heartbeat)
        }
      } catch { /* CLI fallback below can recover resident-worker jobs */ }
    }))
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    if (primeAgentPath) {
      try {
        const result = await runProcess(primeAgentPath, ['schedule', 'list', '--all', '--json'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
        if (result.code === 0 && !result.timedOut && !result.outputExceeded) {
          const parsed: unknown = JSON.parse(result.stdout)
          if (isRecord(parsed) && Array.isArray(parsed.jobs)) {
            for (const value of parsed.jobs.slice(0, 2_000)) {
              const heartbeat = normalizeHeartbeat(value)
              if (heartbeat && !byId.has(heartbeat.id)) byId.set(heartbeat.id, heartbeat)
            }
          }
        }
      } catch { /* a live-runtime catalog remains useful */ }
    }
    return [...byId.values()].sort((left, right) => (left.nextRunAt ?? 'z').localeCompare(right.nextRunAt ?? 'z'))
  }

  async manage(idValue: unknown, actionValue: unknown): Promise<NativeHeartbeatRecord | null> {
    const id = requireId(idValue, 'heartbeat id')
    if (actionValue !== 'pause' && actionValue !== 'resume' && actionValue !== 'stop') throw new TypeError('Invalid heartbeat action')
    const heartbeat = (await this.list()).find((candidate) => candidate.id === id)
    if (!heartbeat) throw new Error('Heartbeat was not found')
    if (actionValue === 'resume') assertNoMcpAuthenticationCommand(heartbeat.prompt, 'prime')
    const primeAgentPath = resolveExecutable(this.primeAgentPath)
    const runtime = heartbeat.runtimeId
      ? this.agents.list().find((candidate) => candidate.runtimeId === heartbeat.runtimeId)
      : this.agents.getForSession(heartbeat.sessionFile)
    // A runtime that cannot run manage_heartbeat (Rust Prime) leaves the job
    // to the CLI, exactly as if no runtime owned it.
    const response = runtime && await this.agents.command(runtime.runtimeId, {
      type: 'manage_heartbeat', activeSessionId: heartbeat.activeSessionId, jobId: heartbeat.id, action: actionValue,
    }).catch(unlessUnsupported)
    if (runtime && response) {
      const updated = isRecord(response.data) && response.data.heartbeat !== undefined
        ? normalizeHeartbeat(response.data.heartbeat, runtime.runtimeId)
        : null
      if (actionValue === 'stop') return this.confirmStopped(id)
      if (updated) return updated
      return { ...heartbeat, status: actionValue === 'pause' ? 'paused' : 'active' }
    }
    if (actionValue === 'stop' && primeAgentPath) {
      const result = await runProcess(primeAgentPath, ['schedule', 'cancel', heartbeat.id], { timeoutMs: 30_000, maxBytes: 1024 * 1024 })
      if (result.code === 0 && !result.timedOut && !result.outputExceeded) return this.confirmStopped(id)
    }
    throw heartbeatActionUnavailable(actionValue, this.primeImplementation())
  }

  /**
   * A stop is a deletion, not a stale status update. Returning null makes
   * every caller drop the row immediately; the follow-up catalog read is the
   * authoritative orphan check.
   */
  private async confirmStopped(id: string): Promise<null> {
    if ((await this.list()).some((candidate) => candidate.id === id)) throw new Error('Heartbeat stop did not remove the job')
    return null
  }
}
