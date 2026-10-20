import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { PrimeContextUsage, PrimeEventEnvelope, PrimeModelDescriptor, PrimeServiceTier, RuntimeInfo, SessionActionSnapshot } from '../../../src/types/api'
import { emptySessionActionSnapshot, parseSessionActionSnapshot, sameSessionActions } from '../../../src/lib/session-actions'
import { killProcessTree, prepareExecutableSpawn, safeChildEnvironment, waitForProcessExit } from '../process-utils'
import { canonicalSessionPath } from '../session-paths'
import { errorMessage, isRecord } from '../validation'
import { redactedStderrTail } from '../lib/process-detail'
import { DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING, RpcChunkAssembler, type RpcChunkAssemblyTiming } from './chunk-assembly'
import { AgentEventForwarder } from './events'
import { PRIME_RPC_ADAPTER, parseContextUsage, parseSessionUsage, type HarnessRpcAdapter } from './harness-adapter'
import { LiveContextUsageTracker, withLiveContextUsage } from './context-usage'
import { FramedRpcTransport, type QueuedRpcWrite } from './transport'
import { boundedErrorDetail } from './limits'
import type { RpcObject } from './types'

interface PendingRequest {
  resolve(value: RpcObject): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  bytes: number
  command: string
}

export interface CompactionWatchdogTimings {
  /** How often to poll get_state for the compacting flag while the runtime is active. */
  pollIntervalMs: number
  /** How long to wait for the agent's own compaction_end after a poll reports the compaction over. */
  endGraceMs: number
  /** How long after the last agent activity polling keeps running on an idle runtime. */
  idleWindowMs: number
}

const DEFAULT_COMPACTION_WATCHDOG_TIMINGS: CompactionWatchdogTimings = {
  pollIntervalMs: 2_000,
  endGraceMs: 4_000,
  idleWindowMs: 30_000,
}

interface ContextUsageRefreshRequest {
  generation: number
  sessionId?: string
  activityTokens?: number
}

export class RpcRuntime {
  readonly runtimeId = randomUUID()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly uncertainDeliveries = new Set<string>()
  private pendingBytes = 0
  private transportFailed = false
  private receivedFrame = false
  private readonly child: ChildProcessWithoutNullStreams
  private readonly transport: FramedRpcTransport
  private stopPromise: Promise<boolean> | null = null
  private readonly eventForwarder: AgentEventForwarder
  private stopped = false
  private info: RuntimeInfo
  private requestedServiceTier: PrimeServiceTier = 'default'
  private contextUsageRefresh: Promise<void> | null = null
  private contextUsageRefreshRequest: ContextUsageRefreshRequest | null = null
  private readonly liveContextUsage = new LiveContextUsageTracker()
  private authoritativeContextUsage: PrimeContextUsage | undefined
  private contextUsageActivityBaseline = 0
  private contextUsageGeneration = 0
  private contextUsageEmitTimer: NodeJS.Timeout | null = null
  private lastContextUsageEmitAt = 0
  private continuationPending = false
  // Provider auto-retry backoff: agent_end has fired but the agent will
  // continue the same turn, so the runtime must keep reporting busy. Kept
  // outside info so get_state refreshes (which report isStreaming false
  // during the backoff) cannot clear it.
  private retryPending = false
  // Compaction watchdog: some Prime Agent event paths buffer compaction_start
  // until the surrounding RPC command settles, so the desktop would learn
  // about a compaction only after it finished. get_state responses are never
  // buffered, so polling the compacting flag while the runtime is active lets
  // the desktop synthesize the missing lifecycle events; real events take
  // precedence and duplicates are swallowed.
  private readonly watchdogTimings: CompactionWatchdogTimings
  private compactionEpisode: 'none' | 'real' | 'synthetic' = 'none'
  private compactionEndFallback: NodeJS.Timeout | null = null
  private compactionPollTimer: NodeJS.Timeout | null = null
  private compactionPollInFlight = false
  private watchdogDisposed = false
  private lastActivityAt = Date.now()
  private lastRealCompactionEventAt = 0
  private readonly chunks: RpcChunkAssembler

  constructor(
    executable: string,
    args: string[],
    cwd: string,
    onEvent: (envelope: PrimeEventEnvelope) => void,
    private readonly onExit: (runtime: RpcRuntime) => void,
    extraEnvironment: NodeJS.ProcessEnv = {},
    watchdogTimings: Partial<CompactionWatchdogTimings> = {},
    readonly adapter: HarnessRpcAdapter = PRIME_RPC_ADAPTER,
    chunkAssemblyTiming: RpcChunkAssemblyTiming = DEFAULT_RPC_CHUNK_ASSEMBLY_TIMING,
  ) {
    this.watchdogTimings = { ...DEFAULT_COMPACTION_WATCHDOG_TIMINGS, ...watchdogTimings }
    this.chunks = new RpcChunkAssembler({
      agentName: this.adapter.agentName,
      deliver: (frame) => this.handleFrame(frame),
      emit: (event) => this.emit(event),
      active: () => !this.stopped && !this.transportFailed,
    }, chunkAssemblyTiming)
    this.info = { runtimeId: this.runtimeId, harness: this.adapter.id, cwd, isStreaming: false, isCompacting: false, sessionActions: emptySessionActionSnapshot(), ...(this.adapter.buildServiceTierCommand ? {} : { fastModeAvailable: false }) }
    this.eventForwarder = new AgentEventForwarder(this.runtimeId, onEvent)
    // Every harness child is spawned with the authorized cwd as its working
    // directory. Adapters that declare spawnsInCwd (pi has no --cwd flag and
    // buckets its sessions by the process working directory) depend on this.
    const invocation = prepareExecutableSpawn(executable, args, safeChildEnvironment(extraEnvironment))
    this.child = spawn(invocation.file, invocation.args, { cwd, env: invocation.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.transport = new FramedRpcTransport(
      this.child,
      (line) => this.handleLine(line),
      (error) => this.failTransport(error),
      () => !this.stopped,
    )
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.once('error', (error) => this.fail(error))
    this.child.once('close', (code, signal) => {
      this.disposeCompactionWatchdog()
      this.disposeContextUsage()
      const detail = code !== 0 && code !== null && !this.stopped && !this.receivedFrame ? redactedStderrTail(this.transport.stderrTail()) : ''
      this.fail(new Error(`${this.adapter.agentName} RPC exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`))
      this.emit({ type: 'runtime_exit', code, signal, expected: this.stopped })
      this.onExit(this)
    })
    this.scheduleCompactionPoll()
  }

  /** Frozen shallow copy: nested state is replaced wholesale on update, and the IPC boundary clones for the renderer. */
  snapshot(): RuntimeInfo {
    return Object.freeze(this.continuationPending || this.retryPending ? { ...this.info, isStreaming: true } : { ...this.info })
  }

  async handshake(): Promise<RuntimeInfo> {
    // Harnesses with a versioned protocol must agree on the version before any
    // other request; unsolicited frames (ready, available_commands_update) may
    // arrive before or after this and are simply forwarded.
    if (this.adapter.negotiateProtocolVersion !== undefined) {
      try {
        await this.request({ type: 'negotiate_protocol', protocolVersion: this.adapter.negotiateProtocolVersion }, 60_000)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`${this.adapter.agentName} does not support RPC protocol v${this.adapter.negotiateProtocolVersion} (${reason}). Update the ${this.adapter.agentName} CLI and try again.`)
      }
    }
    await this.refreshState()
    const contextDeadline = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref()
    })
    await Promise.race([this.refreshContextUsage(), contextDeadline])
    return this.snapshot()
  }

  applyCapabilities(model: PrimeModelDescriptor | undefined): void {
    this.info.availableThinkingLevels = model?.availableThinkingLevels ?? ['off']
    this.info.fastModeSupported = Boolean(this.adapter.buildServiceTierCommand) && (model?.fastModeSupported ?? false)
    this.info.imageInputSupported = model ? model.input.includes('image') : undefined
    if (!this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
    }
  }

  async setServiceTier(serviceTier: 'default' | 'priority', probe = false): Promise<boolean> {
    const buildServiceTierCommand = this.adapter.buildServiceTierCommand
    if (!buildServiceTierCommand) {
      // The harness has no service-tier command at all; nothing goes on the
      // wire, and a direct request fails with a per-harness error.
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
      this.info.fastModeAvailable = false
      if (probe) return false
      throw new Error(`Service tier is not supported by the ${this.adapter.agentName} harness`)
    }
    if (serviceTier === 'priority' && !this.info.fastModeSupported) {
      this.requestedServiceTier = 'default'
      this.info.serviceTier = 'default'
      return false
    }
    try {
      await this.request(buildServiceTierCommand(serviceTier), 10_000)
      this.requestedServiceTier = serviceTier
      this.info.serviceTier = serviceTier
      this.info.fastModeAvailable = true
      return true
    } catch (error) {
      this.info.fastModeAvailable = false
      this.info.serviceTier = 'default'
      if (!probe) throw error
      return false
    }
  }

  serviceTierPreference(): 'default' | 'priority' { return this.requestedServiceTier === 'priority' ? 'priority' : 'default' }

  async command(command: RpcObject): Promise<RpcObject> {
    this.lastActivityAt = Date.now()
    if (command.type === 'extension_ui_response') {
      await this.transport.enqueue(`${JSON.stringify(command)}\n`).done
      return { type: 'response', command: 'extension_ui_response', success: true }
    }
    const timeout = command.type === 'compact' ? 10 * 60_000 : 60_000
    const response = await this.request(command, timeout)
    if (command.type === 'get_state') this.updateFromState(response.data)
    if (response.success === true && ['set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level'].includes(String(command.type))) {
      await this.refreshState()
      void this.refreshContextUsage()
    } else if (response.success === true && command.type === 'prompt') {
      // get_state discovers the new session file promptly. Its mid-stream
      // context snapshot does not include the active assistant message, so a
      // usage refresh waits for message/tool boundaries below.
      void this.refreshState().catch(() => undefined)
    } else if (response.success === true && ['new_session', 'switch_session', 'clone', 'fork', 'branch'].includes(String(command.type))) {
      void this.refreshState().then(() => this.refreshContextUsage()).catch(() => undefined)
    }
    return response
  }

  stop(): Promise<boolean> {
    if (!this.stopPromise) {
      // Stop accepting partial frames before the abort round-trip: the child
      // may keep writing while that request is in flight.
      this.chunks.close()
      this.stopPromise = this.performStop()
    }
    return this.stopPromise
  }

  private async performStop(): Promise<boolean> {
    this.disposeCompactionWatchdog()
    this.chunks.dispose()
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending) {
      try { await this.request({ type: 'abort' }, 5_000) } catch { /* close stdin and escalate below */ }
    }
    this.stopped = true
    this.transport.endInput()
    if (await this.waitForExit(750)) return true
    return this.killTree()
  }

  private killTree(): Promise<boolean> {
    if (!this.child.pid) return this.waitForExit(3_500)
    return killProcessTree(this.child.pid, {
      ladder: [{ signal: 'SIGTERM', waitMs: 2_000 }, { signal: 'SIGKILL', waitMs: 1_500 }],
      hasExited: () => this.child.exitCode !== null || this.child.signalCode !== null,
      waitForExit: (timeoutMs) => this.waitForExit(timeoutMs),
      signalDirect: (signal) => this.child.kill(signal),
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return waitForProcessExit(this.child, timeoutMs)
  }

  private failTransport(reason: unknown): void {
    if (this.transportFailed) return
    this.transportFailed = true
    const error = reason instanceof Error ? reason : new Error(errorMessage(reason))
    this.emit({ type: 'transport_error', error: errorMessage(error) })
    this.transport.pauseOutput()
    this.fail(error)
    this.stopPromise ??= this.performTransportStop()
  }

  private performTransportStop(): Promise<boolean> {
    this.disposeCompactionWatchdog()
    this.stopped = true
    this.transport.destroyInput()
    return this.killTree()
  }

  private scheduleCompactionPoll(): void {
    if (this.watchdogDisposed || this.compactionPollTimer) return
    this.compactionPollTimer = setTimeout(() => {
      this.compactionPollTimer = null
      void this.pollCompactionState().finally(() => this.scheduleCompactionPoll())
    }, this.watchdogTimings.pollIntervalMs)
    this.compactionPollTimer.unref()
  }

  private async pollCompactionState(): Promise<void> {
    if (this.watchdogDisposed || this.compactionPollInFlight || !this.shouldPollCompaction()) return
    this.compactionPollInFlight = true
    const requestedAt = Date.now()
    try {
      const response = await this.request({ type: 'get_state' }, 5_000)
      const raw = isRecord(response.data) ? response.data : null
      // A poll issued before the latest real compaction event answers with
      // stale state; only responses newer than that event are trusted.
      if (!this.watchdogDisposed && raw && typeof raw.isCompacting === 'boolean' && requestedAt > this.lastRealCompactionEventAt) {
        this.observePolledCompaction(raw.isCompacting)
      }
    } catch { /* transient poll failures are ignored; the next tick retries */ }
    finally { this.compactionPollInFlight = false }
  }

  private shouldPollCompaction(): boolean {
    if (!this.transport.writable()) return false
    if (this.info.isStreaming || this.info.isCompacting || this.retryPending || this.continuationPending) return true
    return Date.now() - this.lastActivityAt < this.watchdogTimings.idleWindowMs
  }

  private observePolledCompaction(isCompacting: boolean): void {
    if (isCompacting) {
      this.info.isCompacting = true
      this.clearCompactionEndFallback()
      if (this.compactionEpisode === 'none') {
        this.compactionEpisode = 'synthetic'
        this.emit({ type: 'compaction_start', synthetic: true })
      }
      return
    }
    this.info.isCompacting = false
    if (this.compactionEpisode === 'none' || this.compactionEndFallback) return
    // The agent stopped compacting but its own compaction_end has not arrived;
    // give the real event a grace window before closing the row ourselves.
    this.compactionEndFallback = setTimeout(() => {
      this.compactionEndFallback = null
      if (this.watchdogDisposed || this.compactionEpisode === 'none') return
      this.compactionEpisode = 'none'
      this.emit({ type: 'compaction_end', synthetic: true, aborted: false, willRetry: false })
      void this.refreshContextUsage()
    }, this.watchdogTimings.endGraceMs)
    this.compactionEndFallback.unref()
  }

  private clearCompactionEndFallback(): void {
    if (!this.compactionEndFallback) return
    clearTimeout(this.compactionEndFallback)
    this.compactionEndFallback = null
  }

  private disposeCompactionWatchdog(): void {
    this.watchdogDisposed = true
    if (this.compactionPollTimer) {
      clearTimeout(this.compactionPollTimer)
      this.compactionPollTimer = null
    }
    this.clearCompactionEndFallback()
  }

  private request(command: RpcObject, timeoutMs: number): Promise<RpcObject> {
    if (!this.transport.writable()) return Promise.reject(new Error('Runtime is not available'))
    if (this.pending.size >= 32) return Promise.reject(new Error('Too many pending RPC requests'))
    const commandType = String(command.type)
    const id = randomUUID()
    const line = `${JSON.stringify({ ...command, id })}\n`
    const bytes = Buffer.byteLength(line)
    if (this.pendingBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error('RPC in-flight byte budget exceeded'))
    this.pendingBytes += bytes
    return new Promise((resolveRequest, reject) => {
      let write: QueuedRpcWrite | null = null
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        if (write?.cancel() !== 'flushed') {
          // The line never reached the child: the command cannot execute, so
          // a retry is safe.
          pending.reject(new Error(`RPC command ${commandType} timed out before it was sent`))
          return
        }
        // The line reached the child, which may still execute the command. A
        // late response must be consumed silently rather than reported as an
        // orphan, and the caller must not retry automatically.
        this.rememberUncertainDelivery(id)
        pending.reject(new Error(`RPC command ${commandType} timed out after delivery; the agent may still run it — do not retry automatically`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve: resolveRequest, reject, timer, bytes, command: commandType })
      const failWrite = (error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingBytes -= pending.bytes
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
      write = this.transport.enqueue(line)
      void write.done.catch(failWrite)
    })
  }

  private handleLine(line: string): void {
    let value: unknown
    try { value = JSON.parse(line) } catch {
      this.chunks.dispose()
      this.emit({ type: 'transport_error', error: `${this.adapter.agentName} emitted malformed JSON` })
      return
    }
    this.handleFrame(value)
  }

  private handleFrame(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    this.receivedFrame = true
    if (raw.type !== 'response') this.lastActivityAt = Date.now()
    if (raw.type === 'response' && typeof raw.id === 'string') {
      const pending = this.pending.get(raw.id)
      if (!pending) {
        // A late answer to a request that timed out after its write flushed
        // is consumed, not surfaced as an orphan.
        if (this.uncertainDeliveries.delete(raw.id)) return
        this.emit({ type: 'orphan_response', command: raw.command })
        return
      }
      clearTimeout(pending.timer)
      this.pendingBytes -= pending.bytes
      this.pending.delete(raw.id)
      if (raw.command !== pending.command) {
        pending.reject(new Error(`${this.adapter.agentName} returned a mismatched response for ${pending.command}`))
        this.emit({ type: 'transport_error', error: `${this.adapter.agentName} returned a mismatched RPC response` })
        return
      }
      if (raw.success !== true) {
        const detail = boundedErrorDetail(raw.error) ?? `RPC command ${pending.command} failed`
        pending.reject(new Error(detail))
        return
      }
      pending.resolve(raw)
      return
    }
    if (this.adapter.chunkedFrames && raw.type === 'rpc_chunk') {
      this.chunks.accept(raw)
      return
    }
    const normalized = this.adapter.normalizeEvent(raw, this.info)
    if (!normalized) return
    for (const value of Array.isArray(normalized) ? normalized : [normalized]) this.handleEvent(value)
  }

  /** Runs one normalized event through the streaming, compaction and session-action state, then forwards it. */
  private handleEvent(value: RpcObject): void {
    const liveUsageUpdate = this.liveContextUsage.handleEvent(value)
    if (liveUsageUpdate.reset) {
      this.contextUsageActivityBaseline = 0
      this.contextUsageGeneration += 1
    }
    if (value.type === 'session_action_update') {
      const actions = parseSessionActionSnapshot(value.actions)
      if (actions) this.info.sessionActions = actions
    }
    if (value.type === 'agent_start') {
      this.continuationPending = false
      this.retryPending = false
      this.info.isStreaming = true
      this.info.isCompacting = false
      if (this.compactionEpisode !== 'none') {
        // The compaction's end event never arrived (or was lost); close the
        // renderer's running row before the new turn opens.
        this.compactionEpisode = 'none'
        this.clearCompactionEndFallback()
        this.emit({ type: 'compaction_end', synthetic: true, aborted: false, willRetry: true })
      }
    } else if (value.type === 'agent_end') {
      // Without session action events, only get_state reports that the
      // finished run no longer holds an active turn.
      if (this.adapter.sessionActionEvents === false) void this.refreshState().catch(() => undefined)
      // retryPending is cleared only by agent_start or auto_retry_end, never
      // by agent_end: a failed run's agent_end is followed by auto_retry_start
      // when the agent will continue the turn after backoff.
      this.continuationPending = false
      this.info.isStreaming = false
      this.info.isCompacting = false
      this.bakeLiveContextUsage()
    } else if (value.type === 'compaction_start') {
      this.info.isCompacting = true
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      // A late real start after the watchdog already announced this compaction
      // would open a duplicate row in the renderer; the real end still flows.
      if (this.compactionEpisode === 'synthetic') return
      this.compactionEpisode = 'real'
    } else if (value.type === 'compaction_end') {
      this.continuationPending = value.willRetry === true
      this.info.isCompacting = false
      this.lastRealCompactionEventAt = Date.now()
      this.clearCompactionEndFallback()
      this.compactionEpisode = 'none'
    } else if (value.type === 'auto_retry_start') this.retryPending = true
    else if (value.type === 'auto_retry_end') this.retryPending = false
    this.emit(value)
    if (liveUsageUpdate.changed || liveUsageUpdate.reset) this.publishLiveContextUsage(value.type === 'message_end')
    if (value.type === 'message_end'
      || value.type === 'tool_execution_end'
      || value.type === 'turn_end'
      || value.type === 'agent_end') {
      void this.refreshContextUsage(this.liveContextUsage.tokens)
    } else if (value.type === 'compaction_end') void this.refreshContextUsage()
  }

  private refreshContextUsage(activityTokens?: number): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const request: ContextUsageRefreshRequest = {
      generation: this.contextUsageGeneration,
      sessionId: this.info.sessionId,
      ...(activityTokens === undefined ? {} : { activityTokens }),
    }
    const queued = this.contextUsageRefreshRequest
    if (!queued || queued.generation !== request.generation || queued.sessionId !== request.sessionId) {
      this.contextUsageRefreshRequest = request
    } else if (activityTokens !== undefined) {
      queued.activityTokens = Math.max(queued.activityTokens ?? 0, activityTokens)
    }
    this.contextUsageRefresh ??= this.drainContextUsageRefreshes()
    return this.contextUsageRefresh
  }

  private async drainContextUsageRefreshes(): Promise<void> {
    try {
      while (!this.stopped && this.contextUsageRefreshRequest) {
        const request = this.contextUsageRefreshRequest
        this.contextUsageRefreshRequest = null
        await this.performContextUsageRefresh(request)
      }
    } finally {
      // Clearing inside the drain closes the old single-flight race: a request
      // queued by agent_end while an earlier stats RPC is in flight is observed
      // by the loop before this promise can become idle.
      this.contextUsageRefresh = null
    }
  }

  private async performContextUsageRefresh(request: ContextUsageRefreshRequest): Promise<void> {
    try {
      const response = await this.request({ type: 'get_session_stats' }, 10_000)
      const usage = isRecord(response.data) ? parseContextUsage(response.data.contextUsage) : null
      const sessionUsage = parseSessionUsage(response.data)
      if (request.generation !== this.contextUsageGeneration || request.sessionId !== this.info.sessionId) return
      if (sessionUsage && !this.stopped) {
        this.info.sessionUsage = sessionUsage
        this.emit({ type: 'session_usage', sessionUsage })
      }
      if (usage) this.applyAuthoritativeContextUsage(usage, request.activityTokens)
    } catch { /* older Prime Agent versions may not expose session stats */ }
  }

  private applyAuthoritativeContextUsage(usage: PrimeContextUsage, activityTokens?: number): void {
    if (activityTokens !== undefined) {
      const previous = this.authoritativeContextUsage
      const activityDelta = Math.max(0, activityTokens - this.contextUsageActivityBaseline)
      // A message_end event is forwarded just before persistence. If a very
      // fast stats response still reflects the preceding message, keep its
      // activity live and let the guaranteed trailing refresh absorb it.
      const includesActivity = activityDelta === 0
        || previous === undefined
        || previous?.tokens === null
        || usage.tokens === null
        || (previous?.tokens !== undefined && usage.tokens >= previous.tokens + activityDelta)
      if (includesActivity) this.contextUsageActivityBaseline = Math.max(this.contextUsageActivityBaseline, activityTokens)
    }
    this.authoritativeContextUsage = usage
    this.publishLiveContextUsage(true)
  }

  private bakeLiveContextUsage(): void {
    if (!this.authoritativeContextUsage) return
    this.authoritativeContextUsage = withLiveContextUsage(
      this.authoritativeContextUsage,
      this.liveContextUsage.tokens,
      this.contextUsageActivityBaseline,
    )
    this.contextUsageActivityBaseline = this.liveContextUsage.tokens
    this.publishLiveContextUsage(true)
  }

  private publishLiveContextUsage(immediate = false): void {
    const snapshot = this.authoritativeContextUsage
    if (!snapshot) return
    const usage = withLiveContextUsage(snapshot, this.liveContextUsage.tokens, this.contextUsageActivityBaseline)
    const current = this.info.contextUsage
    const changed = !current
      || current.tokens !== usage.tokens
      || current.contextWindow !== usage.contextWindow
      || current.percent !== usage.percent
    this.info.contextUsage = usage
    if (!changed) return

    const elapsed = Date.now() - this.lastContextUsageEmitAt
    if (immediate || elapsed >= 100) {
      this.emitContextUsageNow()
      return
    }
    if (this.contextUsageEmitTimer) return
    this.contextUsageEmitTimer = setTimeout(() => {
      this.contextUsageEmitTimer = null
      this.emitContextUsageNow()
    }, 100 - elapsed)
    this.contextUsageEmitTimer.unref()
  }

  private emitContextUsageNow(): void {
    if (this.contextUsageEmitTimer) {
      clearTimeout(this.contextUsageEmitTimer)
      this.contextUsageEmitTimer = null
    }
    const usage = this.info.contextUsage
    if (!usage || this.stopped) return
    this.lastContextUsageEmitAt = Date.now()
    this.emit({ type: 'context_usage', contextUsage: usage })
  }

  private disposeContextUsage(): void {
    if (this.contextUsageEmitTimer) clearTimeout(this.contextUsageEmitTimer)
    this.contextUsageEmitTimer = null
    this.contextUsageRefreshRequest = null
  }

  private updateFromState(raw: unknown): void {
    if (!isRecord(raw)) return
    if (typeof raw.sessionId === 'string') {
      if (this.info.sessionId !== undefined && raw.sessionId !== this.info.sessionId) {
        this.liveContextUsage.reset()
        this.contextUsageActivityBaseline = 0
        this.contextUsageGeneration += 1
        this.authoritativeContextUsage = undefined
        delete this.info.contextUsage
        delete this.info.sessionUsage
      }
      this.info.sessionId = raw.sessionId
    }
    // Canonicalize once at the boundary (cached): every later comparison
    // against catalog and validator paths uses the canonical form.
    if (typeof raw.sessionFile === 'string') this.info.sessionFile = canonicalSessionPath(raw.sessionFile)
    if (typeof raw.isStreaming === 'boolean') this.info.isStreaming = raw.isStreaming
    if (typeof raw.isCompacting === 'boolean') this.info.isCompacting = raw.isCompacting
    if (typeof raw.thinkingLevel === 'string') this.info.thinkingLevel = raw.thinkingLevel
    const reading = this.adapter.readState(raw)
    if (reading.serviceTier) {
      this.info.serviceTier = reading.serviceTier
      this.info.fastModeAvailable = true
      this.requestedServiceTier = reading.serviceTier
    }
    if (reading.contextUsage) {
      // Harnesses that report usage inside get_state feed the same authoritative
      // path as the get_session_stats refresh.
      this.applyAuthoritativeContextUsage(reading.contextUsage)
    }
    const sessionActions = parseSessionActionSnapshot(raw.sessionActions) ?? reading.sessionActions ?? null
    if (sessionActions) this.applyStateSessionActions(sessionActions)
    if (isRecord(raw.model)) {
      this.info.model = {
        provider: typeof raw.model.provider === 'string' ? raw.model.provider : undefined,
        id: typeof raw.model.id === 'string' ? raw.model.id : undefined,
        name: typeof raw.model.name === 'string' ? raw.model.name : undefined,
      }
    } else if (raw.model === null) this.info.model = null
  }

  private async refreshState(): Promise<void> {
    const state = await this.request({ type: 'get_state' }, 60_000)
    this.updateFromState(state.data)
  }

  /** A harness without session action events reports its queue only in get_state, so each change found there is forwarded as a synthetic update. */
  private applyStateSessionActions(actions: SessionActionSnapshot): void {
    const changed = !sameSessionActions(this.info.sessionActions, actions)
    this.info.sessionActions = actions
    if (changed && this.adapter.sessionActionEvents === false) this.emit({ type: 'session_action_update', actions, synthetic: true })
  }

  private emit(event: RpcObject): void { this.eventForwarder.emit(event) }

  private rememberUncertainDelivery(id: string): void {
    this.uncertainDeliveries.add(id)
    if (this.uncertainDeliveries.size <= 64) return
    const oldest = this.uncertainDeliveries.values().next().value
    if (oldest !== undefined) this.uncertainDeliveries.delete(oldest)
  }

  private fail(error: Error): void {
    this.chunks.close()
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.uncertainDeliveries.clear()
    this.pendingBytes = 0
  }
}
