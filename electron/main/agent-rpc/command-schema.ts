import { PRIME_THINKING_LEVELS, type PrimeThinkingLevel } from '../../../src/types/api'
import { isOneOf, isRecord, rejectUnknownKeys, requireBoolean, requireId, requireRecord, requireString } from '../validation'
import { rpcRequestFrameBytes } from './limits'
import { RPC_WRITE_FRAME_LIMIT_BYTES } from '../jsonl-limits'
import type { AgentRpcCommand } from '../../../src/types/agent-command'

/** Main services retain the broader protocol vocabulary below. */
export const RENDERER_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'abort', 'prompt', 'steer', 'follow_up', 'compact', 'set_model', 'set_thinking_level',
  'set_service_tier', 'set_session_name', 'extension_ui_response',
])
export function isRendererCommandType(value: unknown): value is AgentRpcCommand['type'] {
  return typeof value === 'string' && RENDERER_COMMAND_TYPES.has(value)
}
export function assertRendererCommand(raw: unknown): void {
  if (!isRecord(raw)) throw new TypeError('command must be an object')
  if (!isRendererCommandType(raw.type)) throw new TypeError('RPC command is not exposed to the renderer')
}

export const SIMPLE_COMMAND_TYPES = [
  'abort', 'new_session', 'get_state', 'cycle_model', 'get_available_models', 'cycle_thinking_level',
  'abort_retry', 'get_session_stats', 'clone', 'get_fork_messages', 'get_last_assistant_text',
  'get_messages', 'agent_messages_status', 'agent_messages_pause', 'agent_messages_resume',
  'agent_messages_clear', 'list_heartbeats', 'get_heartbeat', 'get_commands',
] as const

function validateImageData(data: string, mimeType: string): void {
  if (data.length % 4 !== 0 || !/^[a-z\d+/]*={0,2}$/i.test(data)) throw new TypeError('Image data must be canonical base64')
  const decoded = Buffer.from(data, 'base64')
  if (!decoded.length || decoded.toString('base64') !== data) throw new TypeError('Image data must be canonical base64')
  const matches = mimeType.toLowerCase() === 'image/png'
    ? decoded.length >= 8 && decoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType.toLowerCase() === 'image/jpeg'
      ? decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff
      : mimeType.toLowerCase() === 'image/gif'
        ? decoded.length >= 6 && (decoded.subarray(0, 6).toString('ascii') === 'GIF87a' || decoded.subarray(0, 6).toString('ascii') === 'GIF89a')
        : decoded.length >= 12 && decoded.subarray(0, 4).toString('ascii') === 'RIFF' && decoded.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!matches) throw new TypeError('Image data does not match its MIME type')
}

export function isThinkingLevel(value: string): value is PrimeThinkingLevel { return isOneOf(PRIME_THINKING_LEVELS, value) }

function validateImages(value: unknown): Array<{ type: 'image'; data: string; mimeType: string }> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('images must be an array with at most 8 items')
  return value.map((raw, index) => {
    const image = requireRecord(raw, `images[${index}]`)
    rejectUnknownKeys(image, ['type', 'data', 'mimeType'], `images[${index}]`)
    if (image.type !== 'image') throw new TypeError(`images[${index}].type must be image`)
    const mimeType = requireString(image.mimeType, `images[${index}].mimeType`, { min: 1, max: 100 })
    if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) throw new TypeError('Unsupported image type')
    const data = requireString(image.data, `images[${index}].data`, { min: 1, max: RPC_WRITE_FRAME_LIMIT_BYTES })
    validateImageData(data, mimeType)
    return { type: 'image' as const, data, mimeType }
  })
}

export async function validateRpcCommand(raw: unknown, validateSessionPath: (path: string) => Promise<string>) {
  const command = requireRecord(raw, 'command')
  if (rpcRequestFrameBytes(command) > RPC_WRITE_FRAME_LIMIT_BYTES) throw new TypeError('command is too large for the RPC transport')
  const type = requireString(command.type, 'command.type', { min: 1, max: 64 })
  if (isOneOf(SIMPLE_COMMAND_TYPES, type)) {
    rejectUnknownKeys(command, type === 'new_session' ? ['type', 'parentSession'] : ['type'], 'command')
    if (type === 'new_session' && command.parentSession !== undefined) {
      return { type, parentSession: await validateSessionPath(requireString(command.parentSession, 'parentSession', { max: 4096 })) } as const
    }
    return { type } as const
  }
  if (type === 'prompt' || type === 'steer' || type === 'follow_up') {
    rejectUnknownKeys(command, ['type', 'message', 'images', 'streamingBehavior'], 'command')
    const message = requireString(command.message, 'message', { min: 1, max: 1024 * 1024 })
    const images = validateImages(command.images)
    if (type === 'prompt') {
      const streamingBehavior = command.streamingBehavior
      if (streamingBehavior !== undefined && streamingBehavior !== 'steer' && streamingBehavior !== 'followUp') throw new TypeError('Invalid streamingBehavior')
      return { type, message, ...(images ? { images } : {}), ...(streamingBehavior === undefined ? {} : { streamingBehavior } as const) } as const
    }
    if (command.streamingBehavior !== undefined) throw new TypeError('streamingBehavior is only valid for prompt')
    return { type, message, ...(images ? { images } : {}) } as const
  }
  if (type === 'set_model') {
    rejectUnknownKeys(command, ['type', 'provider', 'modelId'], 'command')
    return { type, provider: requireString(command.provider, 'provider', { min: 1, max: 128 }), modelId: requireString(command.modelId, 'modelId', { min: 1, max: 256 }) } as const
  }
  if (type === 'set_thinking_level') {
    rejectUnknownKeys(command, ['type', 'level'], 'command')
    const level = requireString(command.level, 'level', { max: 16 })
    if (!isThinkingLevel(level)) throw new TypeError('Invalid thinking level')
    return { type, level } as const
  }
  if (type === 'set_service_tier') {
    rejectUnknownKeys(command, ['type', 'serviceTier'], 'command')
    if (command.serviceTier !== 'default' && command.serviceTier !== 'priority') throw new TypeError('Invalid service tier')
    return { type, serviceTier: command.serviceTier } as const
  }
  if (type === 'set_steering_mode' || type === 'set_follow_up_mode') {
    rejectUnknownKeys(command, ['type', 'mode'], 'command')
    if (command.mode !== 'all' && command.mode !== 'one-at-a-time') throw new TypeError('Invalid queue mode')
    return { type, mode: command.mode } as const
  }
  if (type === 'compact') {
    rejectUnknownKeys(command, ['type', 'customInstructions'], 'command')
    return command.customInstructions === undefined ? { type } as const : { type, customInstructions: requireString(command.customInstructions, 'customInstructions', { max: 32_000 }) } as const
  }
  if (type === 'set_auto_compaction' || type === 'set_auto_retry') {
    rejectUnknownKeys(command, ['type', 'enabled'], 'command')
    return { type, enabled: requireBoolean(command.enabled, 'enabled') } as const
  }
  if (type === 'switch_session') {
    rejectUnknownKeys(command, ['type', 'sessionPath'], 'command')
    return { type, sessionPath: await validateSessionPath(requireString(command.sessionPath, 'sessionPath', { max: 4096 })) } as const
  }
  if (type === 'fork') {
    rejectUnknownKeys(command, ['type', 'entryId'], 'command')
    return { type, entryId: requireId(command.entryId, 'entryId') } as const
  }
  if (type === 'set_session_name') {
    rejectUnknownKeys(command, ['type', 'name'], 'command')
    return { type, name: requireString(command.name, 'name', { min: 1, max: 200, trim: true }) } as const
  }
  if (type === 'send_message') {
    rejectUnknownKeys(command, ['type', 'targetActiveSessionId', 'message'], 'command')
    return { type, targetActiveSessionId: requireId(command.targetActiveSessionId, 'targetActiveSessionId'), message: requireString(command.message, 'message', { min: 1, max: 1024 * 1024 }) } as const
  }
  if (type === 'set_heartbeat') {
    rejectUnknownKeys(command, ['type', 'schedule', 'prompt', 'deliveryMode'], 'command')
    const schedule = requireString(command.schedule, 'schedule', { min: 1, max: 500, trim: true })
    const prompt = requireString(command.prompt, 'prompt', { min: 1, max: 1024 * 1024 })
    const deliveryMode = command.deliveryMode
    if (deliveryMode !== undefined && deliveryMode !== 'steer' && deliveryMode !== 'follow_up') throw new TypeError('Invalid deliveryMode')
    return { type, schedule, prompt, ...(deliveryMode === undefined ? {} : { deliveryMode } as const) } as const
  }
  if (type === 'update_heartbeat') {
    rejectUnknownKeys(command, ['type', 'action'], 'command')
    if (command.action !== 'pause' && command.action !== 'resume' && command.action !== 'clear') throw new TypeError('Invalid heartbeat action')
    return { type, action: command.action } as const
  }
  if (type === 'manage_heartbeat') {
    rejectUnknownKeys(command, ['type', 'activeSessionId', 'jobId', 'action'], 'command')
    if (command.action !== 'pause' && command.action !== 'resume' && command.action !== 'stop') throw new TypeError('Invalid heartbeat management action')
    return { type, activeSessionId: requireId(command.activeSessionId, 'activeSessionId'), jobId: requireId(command.jobId, 'jobId'), action: command.action } as const
  }
  if (type === 'observe' || type === 'unobserve') {
    rejectUnknownKeys(command, ['type', 'activeSessionId'], 'command')
    return { type, activeSessionId: requireId(command.activeSessionId, 'activeSessionId') } as const
  }
  if (type === 'extension_ui_response') {
    const id = requireId(command.id, 'id')
    if (command.cancelled === true) { rejectUnknownKeys(command, ['type', 'id', 'cancelled'], 'command'); return { type, id, cancelled: true } as const }
    if (typeof command.confirmed === 'boolean') { rejectUnknownKeys(command, ['type', 'id', 'confirmed'], 'command'); return { type, id, confirmed: command.confirmed } as const }
    rejectUnknownKeys(command, ['type', 'id', 'value'], 'command')
    return { type, id, value: requireString(command.value, 'value', { max: 1024 * 1024 }) } as const
  }
  throw new TypeError(`RPC command ${type} is not exposed to the renderer`)
}

export type ValidatedRpcCommand = Awaited<ReturnType<typeof validateRpcCommand>>
