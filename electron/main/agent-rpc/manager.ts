import type { PrimeEventEnvelope, PrimeModelDescriptor, RuntimeInfo } from '../../../src/types/api'
import { assertNoMcpAuthenticationCommand } from '../../../src/lib/mcp-policy'
import { parseSessionActionSnapshot, streamingBehaviorForIntent } from '../../../src/lib/session-actions'
import { resolveExecutable, type ExecutableSource } from '../process-utils'
import { canonicalSessionPath } from '../session-paths'
import { isPathWithin, isRecord, rejectUnknownKeys, requireId, requireRecord, requireString } from '../validation'
import { isThinkingLevel, validateRpcCommand } from './command-schema'
import { PRIME_RPC_ADAPTER, type HarnessRpcAdapter } from './harness-adapter'
import { RpcRuntime } from './runtime'
import type { RpcObject } from './types'
import type { WorkspaceUseLease, WorkspaceUseOwner } from '../repository-use-gate'

/**
 * Structural slice of the provider catalog the manager needs; PrimeProviderService
 * satisfies it today and a future OMP model catalog can be injected in its place.
 */
export interface ProviderCatalog {
  requireAvailableModel(rawKey: unknown, disabledProviders?: ReadonlySet<string>, disabledModels?: ReadonlySet<string>): Promise<PrimeModelDescriptor>
  capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined>
}

export class AgentRpcManager {
  private readonly runtimes = new Map<string, RpcRuntime>()
  private readonly startingRuntimes = new Set<string>()
  private readonly retiringRuntimes = new Set<string>()
  private readonly runtimeEnvironmentRevisions = new Map<string, number>()
  private runtimeEnvironmentRevision = 0
  private disabledModels: () => ReadonlySet<string> = () => new Set()
  private eventSink: (envelope: PrimeEventEnvelope) => void = () => undefined
  private runtimeEnvironmentProvider: (scope: { cwd: string; sessionPath?: string; interactive: boolean }) => NodeJS.ProcessEnv = () => ({})
  private runtimeStartListener: (environment: NodeJS.ProcessEnv, info: RuntimeInfo) => void = () => undefined
  private runtimeEndListener: (environment: NodeJS.ProcessEnv, info?: RuntimeInfo) => void = () => undefined
  private runtimeAdmission: Promise<void> = Promise.resolve()
  private beginWorkspaceUse: (
    cwd: string,
    owner: WorkspaceUseOwner,
    retireIfIdle: () => Promise<boolean>,
  ) => Promise<WorkspaceUseLease> = async () => ({ release: () => undefined })
  private closed = false

  constructor(
    private readonly executable: ExecutableSource,
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly validateSessionPath: (path: string) => Promise<string>,
    private readonly providers?: ProviderCatalog,
    private readonly disabledProviders: () => ReadonlySet<string> = () => new Set(),
    private readonly adapter: HarnessRpcAdapter = PRIME_RPC_ADAPTER,
    /** Approval-mode override consumed only by harness arg builders that support it (OMP). */
    private readonly approvalMode: () => string | undefined = () => undefined,
  ) {}

  setEventSink(sink: (envelope: PrimeEventEnvelope) => void): void { this.eventSink = sink }

  setDisabledModelsProvider(provider: () => ReadonlySet<string>): void { this.disabledModels = provider }

  setWorkspaceUseProvider(provider: (
    cwd: string,
    owner: WorkspaceUseOwner,
    retireIfIdle: () => Promise<boolean>,
  ) => Promise<WorkspaceUseLease>): void {
    this.beginWorkspaceUse = provider
  }

  setRuntimeEnvironmentProvider(provider: (scope: { cwd: string; sessionPath?: string; interactive: boolean }) => NodeJS.ProcessEnv): void {
    this.runtimeEnvironmentProvider = provider
  }

  /** Called once per successfully started runtime with the environment it was spawned with, so capability bridges can bind their claims to the runtime's session. */
  setRuntimeStartListener(listener: (environment: NodeJS.ProcessEnv, info: RuntimeInfo) => void): void {
    this.runtimeStartListener = listener
  }

  /** Called once when ownership of a spawned environment ends, including starts that fail before a runtime can be created. */
  setRuntimeEndListener(listener: (environment: NodeJS.ProcessEnv, info?: RuntimeInfo) => void): void {
    this.runtimeEndListener = listener
  }

  beginShutdown(): void { this.closed = true }

  async start(raw: unknown): Promise<RuntimeInfo> {
    return this.startWithMode(raw, true)
  }

  /** Internal scheduler entrypoint: unattended children must never expose UI-blocking tools. */
  async startUnattended(raw: unknown): Promise<RuntimeInfo> {
    return this.startWithMode(raw, false)
  }

  private async startWithMode(raw: unknown, interactive: boolean): Promise<RuntimeInfo> {
    this.requireOpen()
    const executable = resolveExecutable(this.executable)
    if (!executable) throw new Error(`${this.adapter.agentName} executable was not found`)
    const options = requireRecord(raw, 'options')
    rejectUnknownKeys(options, ['cwd', 'sessionPath', 'model', 'thinking', 'fast'], 'options')
    const cwd = await this.authorizeCwd(requireString(options.cwd, 'cwd', { min: 1, max: 4096 }))
    this.requireOpen()
    const sessionPath = options.sessionPath === undefined
      ? undefined
      : await this.validateSessionPath(requireString(options.sessionPath, 'sessionPath', { max: 4096 }))
    let selectedModel: PrimeModelDescriptor | undefined
    let modelId: string | undefined
    if (options.model !== undefined) {
      selectedModel = this.providers
        ? await this.providers.requireAvailableModel(options.model, this.disabledProviders(), this.disabledModels())
        : undefined
      modelId = selectedModel?.id ?? requireString(options.model, 'model', { min: 1, max: 256, trim: true })
    }
    let thinking: string | undefined
    if (options.thinking !== undefined) {
      thinking = requireString(options.thinking, 'thinking', { min: 1, max: 16, trim: true })
      if (!isThinkingLevel(thinking)) throw new TypeError('Invalid thinking level')
      if (selectedModel && !selectedModel.availableThinkingLevels.includes(thinking)) throw new TypeError(`${selectedModel.name} does not support ${thinking} reasoning`)
    }
    if (options.fast !== undefined && typeof options.fast !== 'boolean') throw new TypeError('fast must be a boolean')
    this.requireOpen()
    const runtimeEnvironmentRevision = this.runtimeEnvironmentRevision
    const runtimeEnvironment = this.runtimeEnvironmentProvider({ cwd, sessionPath, interactive })
    let runtime: RpcRuntime | undefined
    let workspaceUse!: WorkspaceUseLease
    workspaceUse = await this.beginWorkspaceUse(
      cwd,
      { kind: 'agent', harness: this.adapter.id, runtimeId: `starting-${Date.now()}` },
      async () => {
        if (!runtime) return false
        const retired = await this.retireForCheckout(runtime)
        if (retired) workspaceUse.release()
        return retired
      },
    )
    let environmentEnded = false
    const notifyRuntimeEnd = (info?: RuntimeInfo): void => {
      if (environmentEnded) return
      environmentEnded = true
      workspaceUse.release()
      try { this.runtimeEndListener(runtimeEnvironment, info) } catch { /* capability cleanup must never fail runtime cleanup */ }
    }
    try {
      const args = this.adapter.buildStartArgs({
        cwd,
        sessionPath,
        providerId: selectedModel?.provider,
        modelId,
        thinking,
        approvalMode: this.approvalMode(),
        environment: runtimeEnvironment,
      })
      runtime = await this.admitRuntime(() => {
        const created = new RpcRuntime(
          executable,
          args,
          cwd,
          (event) => this.eventSink(event),
          (closed) => {
            this.startingRuntimes.delete(closed.runtimeId)
            this.runtimes.delete(closed.runtimeId)
            this.retiringRuntimes.delete(closed.runtimeId)
            this.runtimeEnvironmentRevisions.delete(closed.runtimeId)
            notifyRuntimeEnd(closed.snapshot())
          },
          runtimeEnvironment,
          {},
          this.adapter,
        )
        // Record the environment generation before admission resolves so a
        // concurrent settings refresh cannot mistake this child for a new one.
        this.runtimeEnvironmentRevisions.set(created.runtimeId, runtimeEnvironmentRevision)
        return created
      })
      if (runtimeEnvironmentRevision < this.runtimeEnvironmentRevision) void this.retireWhenIdle(runtime)
      await runtime.handshake()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported && options.fast === true) await runtime.setServiceTier('priority', true)
      try { this.runtimeStartListener(runtimeEnvironment, runtime.snapshot()) } catch { /* capability binding must never fail a start */ }
      this.startingRuntimes.delete(runtime.runtimeId)
      return runtime.snapshot()
    } catch (error) {
      if (runtime) {
        // Release the runtime slot explicitly: the close-event cleanup may never
        // fire if the child cannot be reaped, and a failed start must not remain
        // in the resident-process catalog.
        this.startingRuntimes.delete(runtime.runtimeId)
        this.runtimes.delete(runtime.runtimeId)
        this.runtimeEnvironmentRevisions.delete(runtime.runtimeId)
        await runtime.stop().catch(() => false)
      }
      // Admission/constructor failures have no close event; failed handshakes
      // can also leave an unreapable child. The once guard joins all paths.
      notifyRuntimeEnd(runtime?.snapshot())
      throw error
    }
  }

  /**
   * Retire children launched with stale capability settings. Idle runtimes are
   * stopped now; busy runtimes are polled until their current turn settles.
   */
  async requestRuntimeEnvironmentRefresh(): Promise<void> {
    this.runtimeEnvironmentRevision += 1
    await Promise.all([...this.runtimes.values()].map((runtime) => this.retireWhenIdle(runtime)))
  }

  async command(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    try {
      return await this.dispatchCommand(runtimeId, rawCommand)
    } catch (error) {
      // Delivery failures for user-visible commands (steer, prompt, follow_up)
      // are otherwise only surfaced as a transient renderer toast; keep a
      // durable trace in the main-process log for diagnosis.
      const type = isRecord(rawCommand) && typeof rawCommand.type === 'string' ? rawCommand.type : 'invalid'
      console.error(`[agent-rpc] ${new Date().toISOString()} command ${type} failed:`, error instanceof Error ? error.message : error)
      throw error
    }
  }

  private async dispatchCommand(runtimeId: unknown, rawCommand: unknown): Promise<RpcObject> {
    this.requireOpen()
    const runtime = this.requireRuntime(runtimeId)
    if (this.retiringRuntimes.has(runtime.runtimeId)) throw new Error('Runtime is being retired for a branch checkout')
    const command = await validateRpcCommand(rawCommand, this.validateSessionPath)
    this.requireOpen()
    const policyPrompt = command.type === 'prompt' || command.type === 'steer' || command.type === 'follow_up'
      ? command.message
      : command.type === 'set_heartbeat' ? command.prompt : undefined
    if (typeof policyPrompt === 'string') assertNoMcpAuthenticationCommand(policyPrompt, this.adapter.id)
    // Validation is harness-independent; the harness vocabulary applies after
    // it. set_service_tier passes through untranslated because the fast-mode
    // interception below routes it via runtime.setServiceTier instead.
    const translated = this.adapter.translateCommand(command)
    if (command.type === 'set_model' && this.providers) {
      await this.providers.requireAvailableModel(`${String(command.provider)}/${String(command.modelId)}`, this.disabledProviders(), this.disabledModels())
    }
    if (command.type === 'set_service_tier') {
      const serviceTier = command.serviceTier === 'priority' ? 'priority' : 'default'
      const supported = await runtime.setServiceTier(serviceTier)
      if (!supported) throw new Error('Fast mode is not supported by the selected model')
      return { type: 'response', command: 'set_service_tier', success: true }
    }
    if (Array.isArray(command.images) && command.images.length > 0 && runtime.snapshot().imageInputSupported === false) {
      throw new Error('The active model does not accept images. Switch to a vision-capable model, or ask the agent to analyze the image with the inspect_image tool.')
    }
    const response = await runtime.command(translated)
    if (command.type === 'steer' || command.type === 'follow_up') {
      // OMP reports only queuedMessageCount, while Prime reports the full
      // scheduler snapshot. Refresh after admission so both shapes reach the
      // renderer before a queued row can appear to vanish.
      try {
        const state = await runtime.command({ type: 'get_state' })
        const explicitActions = isRecord(state.data) ? parseSessionActionSnapshot(state.data.sessionActions) : null
        const sessionActions = explicitActions ?? runtime.snapshot().sessionActions
        // Zero without an active-turn marker is not proof that a steer was read.
        if (explicitActions || (this.adapter.id === 'omp' && sessionActions && sessionActions.queuedCount > 0)) {
          return { ...response, sessionActions }
        }
      } catch { /* action events remain the fallback */ }
      return response
    }
    if (command.type === 'set_model' || command.type === 'cycle_model') {
      const preference = runtime.serviceTierPreference()
      await this.decorate(runtime)
      if (runtime.snapshot().fastModeSupported) await runtime.setServiceTier(preference, true)
    } else if (command.type === 'set_thinking_level' || command.type === 'cycle_thinking_level') await this.decorate(runtime)
    return response
  }

  async runPromptToCompletion(runtimeId: unknown, messageValue: unknown, timeoutMs = 30 * 60_000): Promise<RuntimeInfo> {
    const id = requireId(runtimeId, 'runtimeId')
    const message = requireString(messageValue, 'message', { min: 1, max: 1024 * 1024 })
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60_000) throw new TypeError('Invalid scheduled run timeout')
    const runtime = this.requireRuntime(id)
    const startedAt = Date.now()
    let observedBusy = runtime.snapshot().isStreaming
    await this.command(id, {
      type: 'prompt',
      message,
      streamingBehavior: streamingBehaviorForIntent('queue'),
    })
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, 200)
        timer.unref()
      })
      this.requireOpen()
      if (!this.runtimes.has(id)) throw new Error('Scheduled runtime exited before the prompt completed')
      try { await runtime.command({ type: 'get_state' }) } catch { /* the event snapshot may still be authoritative */ }
      const snapshot = runtime.snapshot()
      if (snapshot.isStreaming || snapshot.isCompacting) observedBusy = true
      if (!snapshot.isStreaming && !snapshot.isCompacting && (observedBusy || Date.now() - startedAt >= 750)) return snapshot
    }
    try { await runtime.command({ type: 'abort' }) } catch { /* timeout remains authoritative */ }
    throw new Error('Scheduled run timed out')
  }

  async stop(runtimeId: unknown): Promise<boolean> {
    const id = requireId(runtimeId, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) return false
    return runtime.stop()
  }

  list(): RuntimeInfo[] { return [...this.runtimes.values()].map((runtime) => runtime.snapshot()) }

  /** Cheap ownership probe for IPC routing; requireRuntime keeps the authoritative not-found error. */
  has(runtimeId: string): boolean { return this.runtimes.has(runtimeId) }

  getForSession(filePath: string): RuntimeInfo | undefined {
    const wanted = canonicalSessionPath(filePath)
    return this.list().find((runtime) => runtime.sessionFile && canonicalSessionPath(runtime.sessionFile) === wanted)
  }

  async stopForSession(filePath: string): Promise<void> {
    const wanted = canonicalSessionPath(filePath)
    const matches = [...this.runtimes.values()].filter((runtime) => {
      const path = runtime.snapshot().sessionFile
      return path !== undefined && canonicalSessionPath(path) === wanted
    })
    await Promise.all(matches.map((runtime) => runtime.stop()))
  }

  async stopForProjectRoots(roots: string[]): Promise<void> {
    const matches = [...this.runtimes.values()].filter((runtime) => roots.some((root) => isPathWithin(root, runtime.snapshot().cwd)))
    await Promise.all(matches.map((runtime) => runtime.stop()))
  }

  async renameForSession(filePath: string, title: string): Promise<boolean> {
    this.requireOpen()
    const wanted = canonicalSessionPath(filePath)
    const runtime = [...this.runtimes.values()].find((candidate) => {
      const path = candidate.snapshot().sessionFile
      return path !== undefined && canonicalSessionPath(path) === wanted
    })
    if (!runtime) return false
    const response = await runtime.command({ type: 'set_session_name', name: title })
    return response.success === true
  }

  async stopAll(): Promise<void> {
    this.beginShutdown()
    const runtimes = [...this.runtimes.values()]
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
  }

  private async retireWhenIdle(runtime: RpcRuntime): Promise<void> {
    const wantedRevision = this.runtimeEnvironmentRevision
    if (!this.runtimes.has(runtime.runtimeId)
      || (this.runtimeEnvironmentRevisions.get(runtime.runtimeId) ?? wantedRevision) >= wantedRevision) return
    if (this.isIdle(runtime)) {
      await runtime.stop()
      return
    }
    const timer = setTimeout(() => { void this.retireWhenIdle(runtime) }, 250)
    timer.unref()
  }

  private async retireForCheckout(runtime: RpcRuntime): Promise<boolean> {
    const decision = await this.withRuntimeAdmission(async () => {
      if (!this.runtimes.has(runtime.runtimeId)) return 'gone'
      if (!this.isIdle(runtime)) return 'busy'
      this.retiringRuntimes.add(runtime.runtimeId)
      return 'retiring'
    })
    if (decision === 'gone') return true
    if (decision === 'busy') return false
    try {
      const stopped = await runtime.stop()
      if (stopped && this.runtimes.get(runtime.runtimeId) === runtime) this.runtimes.delete(runtime.runtimeId)
      return stopped
    } finally {
      this.retiringRuntimes.delete(runtime.runtimeId)
    }
  }

  private isIdle(runtime: RpcRuntime): boolean {
    if (this.startingRuntimes.has(runtime.runtimeId)) return false
    if (this.retiringRuntimes.has(runtime.runtimeId)) return false
    const snapshot = runtime.snapshot()
    const actions = snapshot.sessionActions
    return !snapshot.isStreaming && !snapshot.isCompacting && !actions?.active
      && (actions?.queuedCount ?? 0) === 0
  }

  private requireOpen(): void {
    if (this.closed) throw new Error(`${this.adapter.agentName} manager is shutting down`)
  }

  private async admitRuntime(createRuntime: () => RpcRuntime): Promise<RpcRuntime> {
    return this.withRuntimeAdmission(async () => {
      this.requireOpen()
      // A new session replaces the oldest safely idle child instead of
      // accumulating resident processes. Busy, queued, compacting, and
      // still-starting runtimes remain alive, with no numeric concurrency cap.
      const idle = [...this.runtimes.values()].find((runtime) => this.isIdle(runtime))
      if (idle) {
        const stopped = await idle.stop()
        if (stopped && this.runtimes.get(idle.runtimeId) === idle) this.runtimes.delete(idle.runtimeId)
      }
      this.requireOpen()
      const runtime = createRuntime()
      this.runtimes.set(runtime.runtimeId, runtime)
      this.startingRuntimes.add(runtime.runtimeId)
      return runtime
    })
  }

  private async withRuntimeAdmission<T>(action: () => Promise<T>): Promise<T> {
    let releaseAdmission!: () => void
    const previousAdmission = this.runtimeAdmission
    this.runtimeAdmission = new Promise<void>((resolveAdmission) => { releaseAdmission = resolveAdmission })
    await previousAdmission
    try {
      return await action()
    } finally {
      releaseAdmission()
    }
  }

  private async decorate(runtime: RpcRuntime): Promise<void> {
    if (!this.providers) return
    const snapshot = runtime.snapshot()
    runtime.applyCapabilities(await this.providers.capabilities(snapshot.model?.provider, snapshot.model?.id))
  }

  private requireRuntime(value: unknown): RpcRuntime {
    const id = requireId(value, 'runtimeId')
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new Error('Runtime was not found')
    return runtime
  }
}
