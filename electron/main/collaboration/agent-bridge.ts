import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { HarnessId, PrimeModelDescriptor, RuntimeInfo, SessionRecord, TranscriptMessage } from '../../../src/types/api'
import type { AgentRpcManager } from '../agent-rpc'
import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import type { ModelCatalogProvider } from '../model-catalog'
import { availableModels, rankedModelMatches, resolveModel, resolveReasoning } from '../model-selection'
import { requireBoolean, requireId, requireInteger, requireString } from '../validation'
import { encodeGooeyPiAgentMessage } from './message-envelope'

const MAX_LISTED_SESSIONS = 100
const MAX_MESSAGES = 40
const MAX_CONTEXT_TOKENS = 30_000
const TOKEN_ESTIMATE_CHARS = 4
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * TOKEN_ESTIMATE_CHARS
const MAX_SEND_CHARS = 64 * 1024
const MAX_CREATE_PROMPT_CHARS = 1_000_000
const MAX_WAIT_MS = 30_000
const WAIT_TRANSCRIPT_POLL_MS = 1_000
const WAIT_RUNTIME_POLL_MS = 250
const MAX_ACTIVE_WAITS_PER_TOKEN = 2

async function delayUntil(targetTime: number): Promise<void> {
  while (true) {
    const remaining = targetTime - Date.now()
    if (remaining <= 0) return
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(resolveDelay, remaining)
      timer.unref()
    })
  }
}

interface CollaborationSessionService {
  list(projectPath?: unknown, includeArchived?: unknown, force?: unknown): Promise<SessionRecord[]>
  read(filePath: unknown): Promise<TranscriptMessage[]>
}

interface CollaborationTarget {
  session: SessionRecord
  service: CollaborationSessionService
  manager: AgentRpcManager
}

export interface AgentCollaborationBridgeOptions {
  extensionPath: string
  sessions: Record<HarnessId, CollaborationSessionService>
  agents: Record<HarnessId, AgentRpcManager>
  catalogs: Record<HarnessId, ModelCatalogProvider>
  disabledProviders: Record<HarnessId, () => ReadonlySet<string>>
  disabledModels: Record<HarnessId, () => ReadonlySet<string>>
}

interface CollaborationMessage {
  id: string
  role: TranscriptMessage['role']
  agentName?: string
  text: string
}

interface CollaborationSnapshot {
  session: Pick<SessionRecord, 'id' | 'harness' | 'title' | 'status' | 'updatedAt'>
  cursor: string
  live: boolean
  estimated_tokens: number
  token_limit: number
  truncated: boolean
  messages: CollaborationMessage[]
}

function messageText(message: TranscriptMessage): string {
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'agent') return ''
  return message.parts.map((part) => {
    if (part.type === 'text' || part.type === 'agentMessage') return part.text
    if (part.type === 'thinking') return `[thinking]\n${part.text}`
    if (part.type === 'image') return '[image omitted]'
    return ''
  }).filter(Boolean).join('\n')
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = '\n[...message truncated...]\n'
  if (maxChars <= marker.length) return value.slice(-maxChars)
  const available = maxChars - marker.length
  const headChars = Math.ceil(available / 2)
  return `${value.slice(0, headChars)}${marker}${value.slice(-(available - headChars))}`
}

function boundedMessages(transcript: TranscriptMessage[]): {
  messages: CollaborationMessage[]
  estimatedTokens: number
  truncated: boolean
} {
  let remaining = MAX_CONTEXT_CHARS
  const messages: CollaborationMessage[] = []
  let truncated = false
  let includedMessages = 0
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const message = transcript[index]
    const raw = messageText(message)
    if (!raw) continue
    if (includedMessages >= MAX_MESSAGES || remaining <= 0) {
      truncated = true
      break
    }
    const text = truncateMiddle(raw, remaining)
    if (text.length < raw.length) truncated = true
    remaining -= text.length
    messages.push({ id: message.id, role: message.role, agentName: message.agentName, text })
    includedMessages += 1
    if (text.length < raw.length) break
  }
  return {
    messages: messages.reverse(),
    estimatedTokens: Math.ceil((MAX_CONTEXT_CHARS - remaining) / TOKEN_ESTIMATE_CHARS),
    truncated,
  }
}

function cursorFor(session: SessionRecord, messages: CollaborationMessage[], live: boolean): string {
  const tail = messages.at(-1)
  return createHash('sha256').update(JSON.stringify([
    session.id, session.harness, session.status, session.updatedAt, session.eventRevision,
    live, tail?.id, tail?.text.slice(-2_048),
  ])).digest('base64url').slice(0, 32)
}

/**
 * App-owned session collaboration for all harnesses. Session files remain
 * read-only: reads use each harness's bounded SessionService, while writes are
 * delivered through a live runtime owned by this GooeyPi process (waking an
 * authorized saved target through the normal manager when needed).
 */
export class AgentCollaborationBridge extends CapabilityBridge {
  protected readonly rateLimit = 120
  protected readonly rateLimitError = 'Session collaboration rate limit exceeded; slow down and retry shortly'
  private readonly waking = new Map<string, Promise<RuntimeInfo>>()
  private readonly deliveries = new Map<string, Promise<void>>()
  private readonly sourcesByToken = new Map<string, CollaborationTarget>()
  private readonly activeWaitsByToken = new Map<string, number>()
  private readonly activeWaitTargets = new Set<string>()
  private readonly activeCreations = new Set<string>()
  private readonly pendingRuntimeTokens = new Map<string, string>()

  constructor(private readonly options: AgentCollaborationBridgeOptions) { super() }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      GOOEYPI_COLLABORATION_URL: url,
      GOOEYPI_COLLABORATION_TOKEN: token,
      GOOEYPI_COLLABORATION_EXTENSION_PATH: this.options.extensionPath,
    }
  }

  bindSession(token: string | undefined, sessionFile: string | undefined, runtimeId?: string): void {
    if (!token) return
    if (runtimeId && !sessionFile) this.pendingRuntimeTokens.set(runtimeId, token)
    if (!sessionFile) return
    const claim = this.claimForToken(token)
    if (claim && !claim.sessionPath) claim.sessionPath = sessionFile
    if (runtimeId) this.pendingRuntimeTokens.delete(runtimeId)
  }

  private bindRuntimeSession(runtimeId: string, sessionFile: string): void {
    const token = this.pendingRuntimeTokens.get(runtimeId)
    if (token) this.bindSession(token, sessionFile, runtimeId)
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    const source = await this.sourceFor(claim)
    if (method === 'list') return this.listPeers(source)
    if (method === 'models') return this.listModels(source, params.query)
    if (method === 'create') return this.withCreationAdmission(claim, () => this.create(source, params))
    const targetId = requireId(params.target_session_id, 'target_session_id')
    if (method === 'wait') return this.withWaitAdmission(claim, targetId, async () => {
      const target = await this.targetFor(source, targetId)
      return this.wait(target, params.after_cursor, params.timeout_ms)
    })
    const target = await this.targetFor(source, targetId)
    if (method === 'read') return this.snapshot(target)
    if (method === 'send') return this.withDeliveryLock(target, () => this.send(source, target, params.message))
    throw new TypeError(`Unsupported collaboration method ${method}`)
  }

  private async sourceFor(claim: CapabilityClaim): Promise<CollaborationTarget> {
    if (!claim.harness || !claim.sessionPath) throw new Error('Session collaboration is not available yet for this thread; try again in a moment')
    const cached = this.sourcesByToken.get(claim.token)
    if (cached) return cached
    const sessions = await this.options.sessions[claim.harness].list(undefined, true, true)
    const sessionPath = resolve(claim.sessionPath)
    const session = sessions.find((candidate) => resolve(candidate.filePath) === sessionPath)
    if (!session) throw new Error('The current collaboration session was not found')
    if (session.depth !== 0) throw new Error('Session collaboration is available only to top-level sessions')
    const source = { session, service: this.options.sessions[claim.harness], manager: this.options.agents[claim.harness] }
    this.sourcesByToken.set(claim.token, source)
    return source
  }

  private async peersFor(source: CollaborationTarget): Promise<CollaborationTarget[]> {
    const peers: CollaborationTarget[] = []
    // Project grants are harness-scoped. A Prime session can collaborate with
    // Prime peers (and likewise for OMP/pi), but its token never grants access
    // to another harness's session catalog even when the cwd text matches.
    const harness = source.session.harness
    const service = this.options.sessions[harness]
    const sessions = await service.list(source.session.projectPath, false, true)
    for (const session of sessions) {
      if (session.id === source.session.id) continue
      if (session.depth !== 0) continue
      if (resolve(session.projectPath) !== resolve(source.session.projectPath)) continue
      peers.push({ session, service, manager: this.options.agents[harness] })
    }
    return peers.sort((left, right) => Date.parse(right.session.updatedAt) - Date.parse(left.session.updatedAt))
  }

  private async listPeers(source: CollaborationTarget): Promise<Array<Record<string, unknown>>> {
    return (await this.peersFor(source)).slice(0, MAX_LISTED_SESSIONS).map(({ session, manager }) => ({
      id: session.id,
      harness: session.harness,
      title: session.title,
      status: session.status,
      updated_at: session.updatedAt,
      live: Boolean(manager.getForSession(session.filePath)),
    }))
  }

  private async modelsFor(source: CollaborationTarget): Promise<PrimeModelDescriptor[]> {
    const harness = source.session.harness
    return availableModels(this.options.catalogs[harness], this.options.disabledProviders[harness](), this.options.disabledModels[harness]())
  }

  private async listModels(source: CollaborationTarget, rawQuery: unknown): Promise<Record<string, unknown>> {
    const query = rawQuery === undefined ? '' : requireString(rawQuery, 'query', { max: 256, trim: true })
    const available = await this.modelsFor(source)
    const matches = query ? rankedModelMatches(query, available) : available
    const models = matches.slice(0, 100).map((model) => ({
      key: model.key,
      name: model.name,
      provider: model.provider,
      reasoning_levels: model.availableThinkingLevels,
    }))
    return { models, matched: matches.length, returned: models.length, truncated: matches.length > models.length }
  }

  private async create(source: CollaborationTarget, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = requireString(params.prompt, 'prompt', { min: 1, max: MAX_CREATE_PROMPT_CHARS, trim: true })
    const title = params.title === undefined ? undefined : requireString(params.title, 'title', { min: 1, max: 200, trim: true })
    const modelQuery = params.model === undefined ? undefined : requireString(params.model, 'model', { min: 1, max: 512, trim: true })
    const reasoningQuery = params.reasoning === undefined ? undefined : requireString(params.reasoning, 'reasoning', { min: 1, max: 64, trim: true })
    const fast = params.fast === undefined ? undefined : requireBoolean(params.fast, 'fast')
    const selectedModel = modelQuery ? resolveModel(modelQuery, await this.modelsFor(source)) : undefined
    const selectedReasoning = selectedModel && reasoningQuery
      ? resolveReasoning(reasoningQuery, selectedModel.availableThinkingLevels)
      : undefined
    const manager = source.manager
    const runtime = await manager.start({
      cwd: source.session.projectPath,
      ...(selectedModel ? { model: selectedModel.key } : {}),
      ...(selectedReasoning ? { thinking: selectedReasoning } : {}),
      ...(fast !== undefined ? { fast } : {}),
    })
    let appliedReasoning = selectedReasoning
    try {
      if (!selectedModel && reasoningQuery) {
        appliedReasoning = resolveReasoning(reasoningQuery, runtime.availableThinkingLevels ?? [])
        await manager.command(runtime.runtimeId, { type: 'set_thinking_level', level: appliedReasoning })
      }
      await manager.command(runtime.runtimeId, { type: 'prompt', message: prompt })
      if (title) await manager.command(runtime.runtimeId, { type: 'set_session_name', name: title }).catch(() => undefined)
      await manager.command(runtime.runtimeId, { type: 'get_state' })
    } catch (error) {
      this.pendingRuntimeTokens.delete(runtime.runtimeId)
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw error
    }
    const current = manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? runtime
    if (!current.sessionFile) {
      this.pendingRuntimeTokens.delete(runtime.runtimeId)
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw new Error('The harness accepted the prompt but did not create a visible session. The session was not reported as created.')
    }
    this.bindRuntimeSession(current.runtimeId, current.sessionFile)
    const sessionPath = resolve(current.sessionFile)
    const created = (await source.service.list(source.session.projectPath, false, true))
      .find((candidate) => candidate.depth === 0 && resolve(candidate.filePath) === sessionPath)
    if (!created) {
      this.pendingRuntimeTokens.delete(runtime.runtimeId)
      await manager.stop(runtime.runtimeId).catch(() => false)
      throw new Error('The harness created a runtime but its session is not yet readable from GooeyPi')
    }
    return {
      created: true,
      session: {
        id: created.id,
        harness: created.harness,
        title: created.title,
        status: created.status,
        updated_at: created.updatedAt,
        live: true,
      },
      runtime_id: current.runtimeId,
      ...(selectedModel ? { model: { key: selectedModel.key, name: selectedModel.name, provider: selectedModel.provider } } : {}),
      ...(appliedReasoning ? { reasoning: appliedReasoning } : {}),
      ...(fast !== undefined ? {
        fast_mode: {
          requested: fast,
          enabled: current.serviceTier === 'priority',
          available: current.fastModeAvailable ?? current.fastModeSupported ?? false,
        },
      } : {}),
    }
  }

  private async targetFor(source: CollaborationTarget, targetId: string): Promise<CollaborationTarget> {
    const matches = (await this.peersFor(source)).filter(({ session }) => session.id === targetId)
    if (matches.length === 0) throw new Error('The target session was not found in this working directory')
    if (matches.length > 1) throw new Error('The target session id is ambiguous in this catalog')
    return matches[0]
  }

  private async snapshot(target: CollaborationTarget): Promise<CollaborationSnapshot> {
    const context = boundedMessages(await target.service.read(target.session.filePath))
    // The target was authorized through a forced catalog scan. Polling waits
    // use the service cache so a 30-second wait never rescans every session
    // file four times per second.
    const refreshed = (await target.service.list(target.session.projectPath, true, false))
      .find((candidate) => candidate.id === target.session.id) ?? target.session
    target.session = refreshed
    const live = Boolean(target.manager.getForSession(refreshed.filePath))
    return {
      session: { id: refreshed.id, harness: refreshed.harness, title: refreshed.title, status: refreshed.status, updatedAt: refreshed.updatedAt },
      cursor: cursorFor(refreshed, context.messages, live),
      live,
      estimated_tokens: context.estimatedTokens,
      token_limit: MAX_CONTEXT_TOKENS,
      truncated: context.truncated,
      messages: context.messages,
    }
  }

  private async send(source: CollaborationTarget, target: CollaborationTarget, rawMessage: unknown): Promise<Record<string, unknown>> {
    const message = requireString(rawMessage, 'message', { min: 1, max: MAX_SEND_CHARS, trim: true })
    const existing = target.manager.getForSession(target.session.filePath)
    const runtime = existing ?? await this.wake(target)
    const before = await this.snapshot(target)
    const attribution = encodeGooeyPiAgentMessage({
      fromSessionId: source.session.id,
      text: message,
    })
    const busy = runtime.isStreaming || runtime.isCompacting || runtime.sessionActions?.active
    await target.manager.command(runtime.runtimeId, { type: busy ? 'follow_up' : 'prompt', message: attribution })
    return { delivered: true, target_session_id: target.session.id, awakened: !existing, queued: Boolean(busy), cursor_before: before.cursor }
  }

  private async wake(target: CollaborationTarget): Promise<RuntimeInfo> {
    const key = `${target.session.harness}:${resolve(target.session.filePath)}`
    const existing = this.waking.get(key)
    if (existing) return existing
    const pending = target.manager.start({ cwd: target.session.projectPath, sessionPath: target.session.filePath })
    this.waking.set(key, pending)
    try { return await pending }
    finally { if (this.waking.get(key) === pending) this.waking.delete(key) }
  }

  private async withDeliveryLock<T>(target: CollaborationTarget, action: () => Promise<T>): Promise<T> {
    const key = `${target.session.harness}:${resolve(target.session.filePath)}`
    const previous = this.deliveries.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
    this.deliveries.set(key, current)
    await previous.catch(() => undefined)
    try { return await action() }
    finally {
      release()
      if (this.deliveries.get(key) === current) this.deliveries.delete(key)
    }
  }

  private async withWaitAdmission<T>(claim: CapabilityClaim, targetId: string, action: () => Promise<T>): Promise<T> {
    const waitKey = `${claim.token}:${claim.harness}:${targetId}`
    const active = this.activeWaitsByToken.get(claim.token) ?? 0
    if (active >= MAX_ACTIVE_WAITS_PER_TOKEN) throw new Error('Too many session waits are active for this runtime')
    if (this.activeWaitTargets.has(waitKey)) throw new Error('A wait for this target session is already active')
    this.activeWaitsByToken.set(claim.token, active + 1)
    this.activeWaitTargets.add(waitKey)
    try { return await action() }
    finally {
      this.activeWaitTargets.delete(waitKey)
      const remaining = (this.activeWaitsByToken.get(claim.token) ?? 1) - 1
      if (remaining > 0) this.activeWaitsByToken.set(claim.token, remaining)
      else this.activeWaitsByToken.delete(claim.token)
    }
  }

  private async withCreationAdmission<T>(claim: CapabilityClaim, action: () => Promise<T>): Promise<T> {
    if (this.activeCreations.has(claim.token)) throw new Error('A session creation is already active for this runtime')
    this.activeCreations.add(claim.token)
    try { return await action() }
    finally { this.activeCreations.delete(claim.token) }
  }

  private async wait(target: CollaborationTarget, rawCursor: unknown, rawTimeout: unknown): Promise<CollaborationSnapshot & { timed_out: boolean }> {
    const afterCursor = rawCursor === undefined ? undefined : requireString(rawCursor, 'after_cursor', { min: 1, max: 128, trim: true })
    const timeoutMs = rawTimeout === undefined ? 15_000 : requireInteger(rawTimeout, 'timeout_ms', 0, MAX_WAIT_MS)
    const startedAt = Date.now()
    const deadline = startedAt + timeoutMs
    let snapshot = await this.snapshot(target)
    while (Date.now() < deadline) {
      const runtime = target.manager.getForSession(target.session.filePath)
      const idle = !runtime || (!runtime.isStreaming && !runtime.isCompacting && !runtime.sessionActions?.active && (runtime.sessionActions?.queuedCount ?? 0) === 0)
      if (idle && (afterCursor === undefined || snapshot.cursor !== afterCursor)) return { ...snapshot, timed_out: false }
      // Busy runtimes need only a cheap in-memory state probe. Transcript
      // reads resume at a bounded cadence once the target is idle/offline.
      // Re-arm an early timer wake until the intended poll instant so a short
      // wait cannot perform multiple transcript reads at its deadline.
      const nextPollAt = Math.min(deadline, Date.now() + (idle ? WAIT_TRANSCRIPT_POLL_MS : WAIT_RUNTIME_POLL_MS))
      await delayUntil(nextPollAt)
      if (idle) snapshot = await this.snapshot(target)
    }
    return { ...snapshot, timed_out: true }
  }
}
