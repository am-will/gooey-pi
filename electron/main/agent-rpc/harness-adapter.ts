import type { HarnessId, PrimeContextUsage, PrimeImplementation, RuntimeInfo, SessionActionSnapshot, SessionUsage, SessionUsageTokens } from '../../../src/types/api'
import { RUST_PRIME_AGENT_NAME } from '../../../src/lib/prime-compat'
import { MAX_QUEUED_ACTIONS, consumeDeliveredPrompt } from '../../../src/lib/session-actions'
import { extensionInjections } from '../extension-manifest'
import { HARNESSES } from '../harness'
import { isRecord } from '../validation'
import { providerErrorDetail } from './limits'
import type { RpcObject } from './types'

/** Normalized start inputs the manager resolves before the harness turns them into argv. */
export interface HarnessStartArgsInput {
  cwd: string
  sessionPath?: string
  /** Provider from the resolved catalog descriptor; absent when no catalog resolved the model. */
  providerId?: string
  /** Catalog model id, or the raw renderer-provided model string when no catalog resolved it. */
  modelId?: string
  thinking?: string
  /** OMP-only approval override; ignored by harnesses without the flag. */
  approvalMode?: string
  environment: NodeJS.ProcessEnv
}

/** Harness-specific fields read from get_state data, normalized to Prime vocabulary. */
export interface HarnessStateReading {
  serviceTier?: 'default' | 'priority'
  contextUsage?: PrimeContextUsage
  sessionActions?: SessionActionSnapshot
}

/**
 * Per-harness strategy for the shared RPC runtime: argv construction,
 * handshake shape, command/event vocabulary translation, and fast-mode
 * mapping. Transport framing, correlation, limits, and the compaction
 * watchdog stay shared and unchanged.
 */
export interface HarnessRpcAdapter {
  readonly id: HarnessId
  /** Product-facing agent name used in error messages. */
  readonly agentName: string
  /** Protocol version to negotiate before the first get_state; undefined skips negotiation. */
  readonly negotiateProtocolVersion?: number
  /** Whether v2 base64 rpc_chunk frames may arrive and must be reassembled. */
  readonly chunkedFrames: boolean
  /**
   * True when the harness has no --cwd flag and derives its working directory
   * (and session bucket) from the process it was spawned as: the runtime must
   * spawn the child with the authorized cwd as its working directory.
   */
  readonly spawnsInCwd?: boolean
  /** The Prime build an alternative Prime adapter speaks; absent for TypeScript Prime and the other harnesses. */
  readonly implementation?: PrimeImplementation
  /**
   * False when the harness never emits session_action_update: the runtime
   * then forwards each queue change it reads from get_state as a synthetic
   * update and refreshes get_state when a run ends. Absent means true.
   */
  readonly sessionActionEvents?: boolean
  /**
   * The errors the harness fails a compact command with when there is
   * nothing to compact yet: the session is too short, or already ends in a
   * compaction. Pi, OMP and Rust Prime tell such a refusal from a failure
   * nowhere else.
   */
  readonly compactRefusal: RegExp
  buildStartArgs(input: HarnessStartArgsInput): string[]
  /** Renderer command vocabulary → harness wire vocabulary. Throws for commands the harness does not support. */
  translateCommand(command: RpcObject): RpcObject
  /**
   * Harness event → Prime event vocabulary, given the runtime state before the
   * event. One harness event may expand into several, which the runtime
   * handles in order; null swallows the event entirely.
   */
  normalizeEvent(event: RpcObject, state: Readonly<RuntimeInfo>): RpcObject | readonly RpcObject[] | null
  /** The wire command that applies a service-tier preference; absent when the harness has no service tier, which the runtime reports as unsupported. */
  buildServiceTierCommand?(serviceTier: 'default' | 'priority'): RpcObject
  /** Reads harness-specific state fields out of get_state data. */
  readState(data: RpcObject): HarnessStateReading
}

export function parseContextUsage(raw: unknown): PrimeContextUsage | null {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.contextWindow) || Number(raw.contextWindow) <= 0) return null
  const tokens = raw.tokens === null ? null : Number.isSafeInteger(raw.tokens) && Number(raw.tokens) >= 0 ? Number(raw.tokens) : undefined
  const percent = raw.percent === null ? null : typeof raw.percent === 'number' && Number.isFinite(raw.percent) && raw.percent >= 0 ? raw.percent : undefined
  if (tokens === undefined || percent === undefined) return null
  return { tokens, contextWindow: Number(raw.contextWindow), percent }
}

const SESSION_TOKEN_FIELDS: Array<keyof SessionUsageTokens> = ['input', 'output', 'cacheRead', 'cacheWrite', 'total']

function parseSessionUsageTokens(raw: unknown): SessionUsageTokens | undefined {
  if (!isRecord(raw)) return undefined
  const tokens: Partial<SessionUsageTokens> = {}
  for (const field of SESSION_TOKEN_FIELDS) {
    const value = raw[field]
    if (!Number.isSafeInteger(value) || Number(value) < 0) return undefined
    tokens[field] = Number(value)
  }
  return tokens as SessionUsageTokens
}

/**
 * Reads the cost/token totals out of get_session_stats data. A missing or
 * malformed cost becomes null (older harness builds omit it); malformed token
 * fields drop the breakdown. Returns null only when neither is present.
 */
export function parseSessionUsage(raw: unknown): SessionUsage | null {
  if (!isRecord(raw)) return null
  const cost = typeof raw.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0 ? raw.cost : null
  const tokens = parseSessionUsageTokens(raw.tokens)
  if (cost === null && tokens === undefined) return null
  return tokens ? { cost, tokens } : { cost }
}

const unsafeArgValue = (value: string): boolean => value.startsWith('-') || /[\r\n]/.test(value)

const stripStreamingBehavior = (command: RpcObject): RpcObject => {
  if (command.type !== 'prompt' || command.streamingBehavior === undefined) return command
  // Pi and OMP drop streamingBehavior pending compatibility verification.
  const { streamingBehavior: _, ...rest } = command
  return rest
}

/** Thrown for a renderer command the harness cannot run; callers may fall back to another path. */
export class UnsupportedRpcCommandError extends Error {
  constructor(readonly command: string, harnessLabel: string) {
    super(`RPC command ${command} is not supported by the ${harnessLabel} harness`)
    this.name = 'UnsupportedRpcCommandError'
  }
}

/** A command translator that refuses the `unsupported` commands and passes every other command through. */
function rejectCommands(unsupported: ReadonlySet<string>, harnessLabel: string): (command: RpcObject) => RpcObject {
  return (command) => {
    const type = String(command.type)
    if (unsupported.has(type)) throw new UnsupportedRpcCommandError(type, harnessLabel)
    return command
  }
}

/** Prime argv; GooeyPi's capability extensions are injected only when the build can load them. */
function primeStartArgs(input: HarnessStartArgsInput, loadExtensions: boolean): string[] {
  const args = ['--mode', 'rpc', '--cwd', input.cwd]
  if (input.sessionPath) args.push('--resume', input.sessionPath)
  if (input.modelId !== undefined) {
    if (unsafeArgValue(input.modelId)) throw new TypeError('Invalid model')
    if (input.providerId) args.push('--provider', input.providerId)
    args.push('--model', input.modelId)
  }
  if (input.thinking) args.push('--thinking', input.thinking)
  for (const skillPath of [input.environment.PRIME_WORK_SCHEDULE_SKILL_PATH, input.environment.PRIME_WORK_BROWSER_SKILL_PATH, input.environment.GOOEYPI_COMPUTER_USE_SKILL_PATH]) {
    if (skillPath && !unsafeArgValue(skillPath)) args.push('--skill', skillPath)
  }
  if (!loadExtensions) return args
  for (const injection of extensionInjections('prime')) {
    const extensionPath = input.environment[injection.environmentVariable]
    if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
  }
  return args
}

/** TypeScript and Rust Prime refuse a compact command with the same two errors. */
const PRIME_COMPACT_REFUSAL = /^(?:Already compacted$|Session is too short to compact\b)/

export const PRIME_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'prime',
  agentName: HARNESSES.prime.agentName,
  chunkedFrames: false,
  compactRefusal: PRIME_COMPACT_REFUSAL,
  buildStartArgs: (input) => primeStartArgs(input, true),
  translateCommand: (command) => command,
  normalizeEvent: (event) => event,
  buildServiceTierCommand: (serviceTier) => ({ type: 'set_service_tier', serviceTier }),
  readState: (data) => data.serviceTier === 'default' || data.serviceTier === 'priority' ? { serviceTier: data.serviceTier } : {},
}

/**
 * Commands Rust Prime's in-process RPC refuses: messaging and heartbeat
 * changes need its daemon, observe finds no active session, and it has no
 * extension UI protocol. list_heartbeats still answers (with no jobs).
 */
const PRIME_RUST_UNSUPPORTED_COMMANDS = new Set([
  'send_message', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume', 'agent_messages_clear',
  'set_heartbeat', 'update_heartbeat', 'manage_heartbeat', 'observe', 'extension_ui_response',
])

/** A user message's text, joined the way Rust Prime builds a queue preview. */
function userMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== 'user') return undefined
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return undefined
  return message.content.flatMap((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join(' ')
}

/** The provider error that ended a run, from the run's last assistant message; undefined unless that message failed. */
function providerRunError(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index]
    if (isRecord(message) && message.role === 'assistant') return providerErrorDetail(message)
  }
  return undefined
}

/**
 * Rust Prime's in-process RPC neither retries a failed provider call nor
 * reports the failure: the run just ends. An error event after its agent_end
 * marks the turn failed. A queued steer or follow-up arrives as a user
 * message_start in the running turn, with no word about the queue; the
 * synthetic update ahead of it lets the renderer settle the pending prompt
 * before the answer to it streams.
 */
function normalizeRustPrimeEvent(event: RpcObject, state: Readonly<RuntimeInfo>): RpcObject | readonly RpcObject[] {
  if (event.type === 'agent_end') {
    const error = providerRunError(event.messages)
    return error ? [event, { type: 'error', error, synthetic: true }] : event
  }
  if (event.type === 'message_start' && state.isStreaming && state.sessionActions) {
    const text = userMessageText(event.message)
    const actions = text === undefined ? null : consumeDeliveredPrompt(state.sessionActions, text)
    if (actions) return [{ type: 'session_action_update', actions, synthetic: true }, event]
  }
  return event
}

/**
 * Rust Prime Agent (the 0.9.9 betas and 0.10+) keeps the TypeScript RPC
 * envelope, vocabulary and --skill flag, but exits on --extension as an
 * unknown option, so GooeyPi's TypeScript capability extensions are never
 * passed. Its in-process RPC has no service tier: set_service_tier is an
 * unknown command and get_state reports none, so fast mode is unavailable.
 * It never emits session_action_update; its queue is visible only in
 * get_state.
 */
export const PRIME_RUST_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'prime',
  agentName: HARNESSES.prime.agentName,
  implementation: 'rust',
  chunkedFrames: false,
  sessionActionEvents: false,
  compactRefusal: PRIME_COMPACT_REFUSAL,
  buildStartArgs: (input) => primeStartArgs(input, false),
  translateCommand: rejectCommands(PRIME_RUST_UNSUPPORTED_COMMANDS, RUST_PRIME_AGENT_NAME),
  normalizeEvent: normalizeRustPrimeEvent,
  readState: () => ({}),
}

/**
 * Called once when a start fails, with the adapter that start used. True
 * means the cause was repaired and the start is worth one more attempt.
 */
export type StartRecovery = (error: unknown, adapter: HarnessRpcAdapter) => Promise<boolean>

/** The adapter for the discovered Prime build; an unclassified Prime keeps the TypeScript argv. */
export function primeRpcAdapter(implementation: PrimeImplementation | undefined): HarnessRpcAdapter {
  return implementation === 'rust' ? PRIME_RUST_RPC_ADAPTER : PRIME_RPC_ADAPTER
}

/** Rust Prime's exit for TypeScript argv, as the runtime's pre-frame stderr tail reports it. */
const RUST_PRIME_REJECTED_EXTENSION = /\bUnknown option: --extension\b/

/**
 * Start recovery for the Prime manager. Rust Prime rejecting a TypeScript
 * start means the install changed under GooeyPi, typically through
 * `prime-agent update`, or was misclassified. Prime is re-detected once, and
 * the start is retried only when it now classifies as Rust.
 */
export function primeStartRecovery(redetect: () => Promise<PrimeImplementation | undefined>): StartRecovery {
  return async (error, adapter) => {
    if (adapter.id !== 'prime' || adapter.implementation === 'rust') return false
    if (!(error instanceof Error) || !RUST_PRIME_REJECTED_EXTENSION.test(error.message)) return false
    return await redetect() === 'rust'
  }
}

const OMP_UNSUPPORTED_COMMANDS = new Set([
  'send_message', 'clone', 'set_heartbeat', 'update_heartbeat', 'manage_heartbeat', 'observe', 'unobserve',
  'list_heartbeats', 'get_heartbeat', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear',
])

const rejectOmpCommands = rejectCommands(OMP_UNSUPPORTED_COMMANDS, 'OMP')
// pi keeps Prime's vocabulary (fork/get_fork_messages pass through
// untranslated) but lacks the same Prime-only daemon/heartbeat family OMP
// rejects, clone included.
const rejectPiCommands = rejectCommands(OMP_UNSUPPORTED_COMMANDS, 'Pi')

const OMP_APPROVAL_MODES = new Set(['always-ask', 'write', 'yolo'])

export const OMP_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'omp',
  agentName: HARNESSES.omp.agentName,
  negotiateProtocolVersion: 2,
  chunkedFrames: true,
  // OMP's ManualCompactionNoOpError messages.
  compactRefusal: /^(?:Already compacted|Nothing to compact \(session too small(?: or already rolled over)?\))$/,
  buildStartArgs: (input) => {
    const args = ['--mode', 'rpc', '--cwd', input.cwd]
    if (input.sessionPath) args.push('--resume', input.sessionPath)
    if (input.modelId !== undefined) {
      // OMP takes a single provider/id selector; a raw model string with no
      // resolved provider descriptor is passed through as-is.
      const model = input.providerId ? `${input.providerId}/${input.modelId}` : input.modelId
      if (unsafeArgValue(model)) throw new TypeError('Invalid model')
      args.push('--model', model)
    }
    if (input.thinking) args.push('--thinking', input.thinking)
    if (input.approvalMode !== undefined) {
      if (!OMP_APPROVAL_MODES.has(input.approvalMode)) throw new TypeError('Invalid approval mode')
      args.push('--approval-mode', input.approvalMode)
    }
    const computerUseSkillPath = input.environment.GOOEYPI_COMPUTER_USE_SKILL_PATH
    if (computerUseSkillPath && !unsafeArgValue(computerUseSkillPath)) args.push('--append-system-prompt', computerUseSkillPath)
    // OMP has no --skill flag: app capabilities are injected as explicit,
    // self-contained extensions while normal OMP skills remain discovery-based.
    for (const injection of extensionInjections('omp')) {
      const extensionPath = input.environment[injection.environmentVariable]
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (raw) => {
    const command = rejectOmpCommands(raw)
    if (command.type === 'fork') return { ...command, type: 'branch' }
    if (command.type === 'get_fork_messages') return { ...command, type: 'get_branch_messages' }
    return stripStreamingBehavior(command)
  },
  normalizeEvent: (event) => {
    if (event.type === 'auto_compaction_start') return { ...event, type: 'compaction_start' }
    if (event.type === 'auto_compaction_end') {
      // OMP flags a benign no-op with skipped, which Prime reports as a
      // warning, and ends a shake pass that rewrote history in place without
      // a result, which would otherwise read as a failure.
      const end = { ...event, type: 'compaction_end' }
      if (event.skipped === true) return { ...end, errorSeverity: 'warning' }
      const completedInPlace = !isRecord(event.result) && event.aborted !== true && event.errorMessage === undefined
      return completedInPlace ? { ...end, completed: true } : end
    }
    // A non-terminal agent_end is a turn boundary inside a continuing run; it
    // must not finalize streaming rows in the renderer.
    if (event.type === 'agent_end' && event.isTerminal === false) return null
    return event
  },
  buildServiceTierCommand: (serviceTier) => ({ type: 'set_fast_mode', enabled: serviceTier === 'priority' }),
  readState: (data) => {
    const reading: HarnessStateReading = {}
    if (typeof data.fastModeEnabled === 'boolean') reading.serviceTier = data.fastModeEnabled ? 'priority' : 'default'
    const usage = parseContextUsage(data.contextUsage)
    if (usage) reading.contextUsage = usage
    if (Number.isSafeInteger(data.queuedMessageCount) && Number(data.queuedMessageCount) >= 0 && Number(data.queuedMessageCount) <= MAX_QUEUED_ACTIONS) {
      reading.sessionActions = {
        queuedCount: Number(data.queuedMessageCount),
        steering: [],
        followUps: [],
      }
    }
    return reading
  },
}

/**
 * Base pi speaks Prime's request/response envelope, command vocabulary, and
 * event names with no handshake extras: no ready frame, no protocol
 * negotiation, no chunked frames. The Prime-only daemon/heartbeat family is
 * missing; fast mode is supplied by GooeyPi's bundled compatibility extension.
 */
export const PI_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'pi',
  agentName: HARNESSES.pi.agentName,
  chunkedFrames: false,
  // pi has no --cwd flag: the session bucket derives from the child process
  // working directory, which the runtime sets to the authorized cwd.
  spawnsInCwd: true,
  compactRefusal: /^(?:Already compacted|Nothing to compact \(session too small\))$/,
  buildStartArgs: (input) => {
    const args = ['--mode', 'rpc']
    // pi's --resume is an interactive selector; an exact session file rides --session.
    if (input.sessionPath) args.push('--session', input.sessionPath)
    if (input.modelId !== undefined) {
      if (unsafeArgValue(input.modelId)) throw new TypeError('Invalid model')
      if (input.providerId) args.push('--provider', input.providerId)
      args.push('--model', input.modelId)
    }
    if (input.thinking) args.push('--thinking', input.thinking)
    const computerUseSkillPath = input.environment.GOOEYPI_COMPUTER_USE_SKILL_PATH
    if (computerUseSkillPath && !unsafeArgValue(computerUseSkillPath)) args.push('--skill', computerUseSkillPath)
    // App capabilities are injected as explicit, self-contained extensions
    // (the same decision as OMP); pi's --skill flag stays unused.
    for (const injection of extensionInjections('pi')) {
      const extensionPath = input.environment[injection.environmentVariable]
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (command) => stripStreamingBehavior(rejectPiCommands(command)),
  normalizeEvent: (event) => event,
  // Pi has no native tier command. Its prompt RPC invokes the bundled private
  // slash command, whose provider hook applies service_tier to supported models.
  buildServiceTierCommand: (serviceTier) => ({ type: 'prompt', message: `/gooeypi-fast-mode ${serviceTier}` }),
  // pi's get_state carries no serviceTier, fastModeEnabled, or contextUsage;
  // context usage flows through the shared get_session_stats path.
  readState: () => ({}),
}
