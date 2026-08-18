import type { HarnessId, PrimeContextUsage } from '../../../src/types/api'
import { HARNESSES } from '../harness'
import { isRecord } from '../validation'
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
  /**
   * Subcommand of the harness CLI that reads and writes the harness's own
   * agent configuration (`<cli> <command> get|set <key>`), or absent when the
   * harness has no such surface — which the model-role settings report as
   * unsupported instead of rendering an empty form. Declared here so one
   * per-harness record answers what a harness supports.
   */
  readonly agentConfigCommand?: string
  buildStartArgs(input: HarnessStartArgsInput): string[]
  /** Renderer command vocabulary → harness wire vocabulary. Throws for commands the harness does not support. */
  translateCommand(command: RpcObject): RpcObject
  /** Harness event → Prime event vocabulary; null swallows the event entirely. */
  normalizeEvent(event: RpcObject): RpcObject | null
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

const unsafeArgValue = (value: string): boolean => value.startsWith('-') || /[\r\n]/.test(value)

export const PRIME_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'prime',
  agentName: HARNESSES.prime.agentName,
  chunkedFrames: false,
  // No agentConfigCommand: Prime Agent has no model-role or advisor concept —
  // the vendored prime-agent package contains no such setting — so the
  // model-role settings section is not offered for this harness.
  buildStartArgs: (input) => {
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
    for (const extensionPath of [
      input.environment.PRIME_WORK_BROWSER_EXTENSION_PATH,
      input.environment.PRIME_WORK_ASK_USER_EXTENSION_PATH,
      input.environment.GOOEYPI_COLLABORATION_EXTENSION_PATH,
    ]) {
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (command) => command,
  normalizeEvent: (event) => event,
  buildServiceTierCommand: (serviceTier) => ({ type: 'set_service_tier', serviceTier }),
  readState: (data) => data.serviceTier === 'default' || data.serviceTier === 'priority' ? { serviceTier: data.serviceTier } : {},
}

const OMP_UNSUPPORTED_COMMANDS = new Set([
  'send_message', 'clone', 'set_heartbeat', 'update_heartbeat', 'manage_heartbeat', 'observe', 'unobserve',
  'list_heartbeats', 'get_heartbeat', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear',
])

const OMP_APPROVAL_MODES = new Set(['always-ask', 'write', 'yolo'])

export const OMP_RPC_ADAPTER: HarnessRpcAdapter = {
  id: 'omp',
  agentName: HARNESSES.omp.agentName,
  negotiateProtocolVersion: 2,
  chunkedFrames: true,
  // `omp config get|set <key>` is a first-class CLI surface (verified against
  // omp 17.2.9): `modelRoles` is a whole-record setting and `advisor.*` are
  // individual leaves.
  agentConfigCommand: 'config',
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
    for (const extensionPath of [
      input.environment.PRIME_WORK_SCHEDULE_EXTENSION_PATH,
      input.environment.PRIME_WORK_BROWSER_EXTENSION_PATH,
      input.environment.PRIME_WORK_ASK_USER_EXTENSION_PATH,
      input.environment.GOOEYPI_COLLABORATION_EXTENSION_PATH,
    ]) {
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (command) => {
    const type = String(command.type)
    if (OMP_UNSUPPORTED_COMMANDS.has(type)) throw new Error(`RPC command ${type} is not supported by the OMP harness`)
    if (type === 'fork') return { ...command, type: 'branch' }
    if (type === 'get_fork_messages') return { ...command, type: 'get_branch_messages' }
    return command
  },
  normalizeEvent: (event) => {
    if (event.type === 'auto_compaction_start') return { ...event, type: 'compaction_start' }
    if (event.type === 'auto_compaction_end') return { ...event, type: 'compaction_end' }
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
  // No agentConfigCommand: pi's own config CLI was not verified against a live
  // pi during this work, and an unverified surface must not be driven blind.
  // Declaring it here is the only change needed once it is checked.
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
    for (const extensionPath of [
      input.environment.GOOEYPI_PI_FAST_MODE_EXTENSION_PATH,
      input.environment.PRIME_WORK_SCHEDULE_EXTENSION_PATH,
      input.environment.PRIME_WORK_BROWSER_EXTENSION_PATH,
      input.environment.PRIME_WORK_ASK_USER_EXTENSION_PATH,
      input.environment.GOOEYPI_COLLABORATION_EXTENSION_PATH,
    ]) {
      if (extensionPath && !unsafeArgValue(extensionPath)) args.push('--extension', extensionPath)
    }
    return args
  },
  translateCommand: (command) => {
    const type = String(command.type)
    // pi keeps Prime's vocabulary (fork/get_fork_messages pass through
    // untranslated) but lacks the same Prime-only daemon/heartbeat family OMP
    // rejects, clone included.
    if (OMP_UNSUPPORTED_COMMANDS.has(type)) throw new Error(`RPC command ${type} is not supported by the Pi harness`)
    return command
  },
  normalizeEvent: (event) => event,
  // Pi has no native tier command. Its prompt RPC invokes the bundled private
  // slash command, whose provider hook applies service_tier to supported models.
  buildServiceTierCommand: (serviceTier) => ({ type: 'prompt', message: `/gooeypi-fast-mode ${serviceTier}` }),
  // pi's get_state carries no serviceTier, fastModeEnabled, or contextUsage;
  // context usage flows through the shared get_session_stats path.
  readState: () => ({}),
}
