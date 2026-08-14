import { describe, expect, it, vi } from 'vitest'
import { isThinkingLevel, validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'

const passthrough = async (path: string) => path

function validate(command: unknown, validateSessionPath: (path: string) => Promise<string> = passthrough) {
  return validateRpcCommand(command, validateSessionPath)
}

const pngData = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')
const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')
const gifData = Buffer.from('GIF89a....', 'ascii').toString('base64')
const webpData = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]).toString('base64')

describe('isThinkingLevel', () => {
  it('accepts Prime thinking levels and rejects anything else', () => {
    expect(isThinkingLevel('medium')).toBe(true)
    expect(isThinkingLevel('max')).toBe(true)
    expect(isThinkingLevel('auto')).toBe(false)
    expect(isThinkingLevel('')).toBe(false)
  })
})

describe('validateRpcCommand simple commands', () => {
  it('passes through argument-free commands and rejects extra keys', async () => {
    await expect(validate({ type: 'abort' })).resolves.toEqual({ type: 'abort' })
    await expect(validate({ type: 'get_commands' })).resolves.toEqual({ type: 'get_commands' })
    await expect(validate({ type: 'abort', force: true })).rejects.toThrow('command.force is not supported')
  })

  it('resolves the parent session of a new_session command through the path validator', async () => {
    const validateSessionPath = vi.fn(async (path: string) => `${path}/resolved`)
    await expect(validate({ type: 'new_session' })).resolves.toEqual({ type: 'new_session' })
    await expect(validate({ type: 'new_session', parentSession: '/sessions/a' }, validateSessionPath)).resolves.toEqual({ type: 'new_session', parentSession: '/sessions/a/resolved' })
    expect(validateSessionPath).toHaveBeenCalledWith('/sessions/a')
    await expect(validate({ type: 'new_session', parentSession: 7 })).rejects.toThrow('parentSession must be a string')
    await expect(validate({ type: 'get_state', parentSession: '/sessions/a' })).rejects.toThrow('command.parentSession is not supported')
  })

  it('rejects a non-object command, a missing type, and an unexposed type', async () => {
    await expect(validate('abort')).rejects.toThrow('command must be an object')
    await expect(validate({})).rejects.toThrow('command.type must be a string')
    await expect(validate({ type: '' })).rejects.toThrow('command.type is too short')
    await expect(validate({ type: 'shutdown' })).rejects.toThrow('RPC command shutdown is not exposed to the renderer')
  })
})

describe('validateRpcCommand prompts', () => {
  it('accepts prompt, steer, and follow_up messages', async () => {
    for (const type of ['prompt', 'steer', 'follow_up']) {
      await expect(validate({ type, message: 'hello' })).resolves.toEqual({ type, message: 'hello' })
    }
    await expect(validate({ type: 'prompt', message: '' })).rejects.toThrow('message is too short')
    await expect(validate({ type: 'prompt' })).rejects.toThrow('message must be a string')
    await expect(validate({ type: 'prompt', message: 'hi', unexpected: 1 })).rejects.toThrow('command.unexpected is not supported')
  })

  it('allows a streaming behavior only on prompt', async () => {
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'steer' })).resolves.toEqual({ type: 'prompt', message: 'hi', streamingBehavior: 'steer' })
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'followUp' })).resolves.toEqual({ type: 'prompt', message: 'hi', streamingBehavior: 'followUp' })
    await expect(validate({ type: 'prompt', message: 'hi', streamingBehavior: 'queue' })).rejects.toThrow('Invalid streamingBehavior')
    await expect(validate({ type: 'steer', message: 'hi', streamingBehavior: 'steer' })).rejects.toThrow('streamingBehavior is only valid for prompt')
  })

  it('accepts every supported image type and normalizes the attachment shape', async () => {
    const images = [
      { type: 'image', data: pngData, mimeType: 'image/png' },
      { type: 'image', data: jpegData, mimeType: 'IMAGE/JPEG' },
      { type: 'image', data: gifData, mimeType: 'image/gif' },
      { type: 'image', data: webpData, mimeType: 'image/webp' },
    ]
    await expect(validate({ type: 'prompt', message: 'look', images })).resolves.toEqual({ type: 'prompt', message: 'look', images })
  })

  it('rejects malformed image collections', async () => {
    const image = { type: 'image', data: pngData, mimeType: 'image/png' }
    await expect(validate({ type: 'prompt', message: 'look', images: image })).rejects.toThrow('images must be an array with at most 8 items')
    await expect(validate({ type: 'prompt', message: 'look', images: Array.from({ length: 9 }, () => image) })).rejects.toThrow('images must be an array with at most 8 items')
    await expect(validate({ type: 'prompt', message: 'look', images: ['png'] })).rejects.toThrow('images[0] must be an object')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, extra: true }] })).rejects.toThrow('images[0].extra is not supported')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, type: 'file' }] })).rejects.toThrow('images[0].type must be image')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, mimeType: 'image/tiff' }] })).rejects.toThrow('Unsupported image type')
    await expect(validate({ type: 'prompt', message: 'look', images: [{ ...image, data: '' }] })).rejects.toThrow('images[0].data is too short')
  })

  it('rejects non-canonical base64 and payloads that do not match their MIME type', async () => {
    const image = (data: string, mimeType = 'image/png') => ({ type: 'prompt', message: 'look', images: [{ type: 'image', data, mimeType }] })
    await expect(validate(image('AAA'))).rejects.toThrow('canonical base64')
    await expect(validate(image('////'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image('QR=='))).rejects.toThrow('canonical base64')
    await expect(validate(image(gifData, 'image/png'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/jpeg'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/gif'))).rejects.toThrow('does not match its MIME type')
    await expect(validate(image(pngData, 'image/webp'))).rejects.toThrow('does not match its MIME type')
  })
})

describe('validateRpcCommand settings commands', () => {
  it('validates set_model', async () => {
    await expect(validate({ type: 'set_model', provider: 'openai', modelId: 'gpt-5' })).resolves.toEqual({ type: 'set_model', provider: 'openai', modelId: 'gpt-5' })
    await expect(validate({ type: 'set_model', provider: '', modelId: 'gpt-5' })).rejects.toThrow('provider is too short')
    await expect(validate({ type: 'set_model', provider: 'openai' })).rejects.toThrow('modelId must be a string')
  })

  it('validates set_thinking_level', async () => {
    await expect(validate({ type: 'set_thinking_level', level: 'high' })).resolves.toEqual({ type: 'set_thinking_level', level: 'high' })
    await expect(validate({ type: 'set_thinking_level', level: 'auto' })).rejects.toThrow('Invalid thinking level')
  })

  it('validates set_service_tier', async () => {
    await expect(validate({ type: 'set_service_tier', serviceTier: 'priority' })).resolves.toEqual({ type: 'set_service_tier', serviceTier: 'priority' })
    await expect(validate({ type: 'set_service_tier', serviceTier: 'flex' })).rejects.toThrow('Invalid service tier')
  })

  it('validates the steering and follow-up queue modes', async () => {
    await expect(validate({ type: 'set_steering_mode', mode: 'all' })).resolves.toEqual({ type: 'set_steering_mode', mode: 'all' })
    await expect(validate({ type: 'set_follow_up_mode', mode: 'one-at-a-time' })).resolves.toEqual({ type: 'set_follow_up_mode', mode: 'one-at-a-time' })
    await expect(validate({ type: 'set_follow_up_mode', mode: 'none' })).rejects.toThrow('Invalid queue mode')
  })

  it('validates compaction and retry toggles', async () => {
    await expect(validate({ type: 'compact' })).resolves.toEqual({ type: 'compact' })
    await expect(validate({ type: 'compact', customInstructions: 'keep the plan' })).resolves.toEqual({ type: 'compact', customInstructions: 'keep the plan' })
    await expect(validate({ type: 'compact', customInstructions: 'x'.repeat(32_001) })).rejects.toThrow('customInstructions is too long')
    await expect(validate({ type: 'set_auto_compaction', enabled: false })).resolves.toEqual({ type: 'set_auto_compaction', enabled: false })
    await expect(validate({ type: 'set_auto_retry', enabled: true })).resolves.toEqual({ type: 'set_auto_retry', enabled: true })
    await expect(validate({ type: 'set_auto_retry', enabled: 'yes' })).rejects.toThrow('enabled must be a boolean')
  })
})

describe('validateRpcCommand session commands', () => {
  it('resolves a switch_session path through the validator', async () => {
    const validateSessionPath = vi.fn(async (path: string) => `${path}/resolved`)
    await expect(validate({ type: 'switch_session', sessionPath: '/sessions/b' }, validateSessionPath)).resolves.toEqual({ type: 'switch_session', sessionPath: '/sessions/b/resolved' })
    await expect(validate({ type: 'switch_session', sessionPath: 'x'.repeat(4097) })).rejects.toThrow('sessionPath is too long')
  })

  it('rejects a rejected session path', async () => {
    const validateSessionPath = vi.fn(async () => { throw new TypeError('sessionPath is not inside a project') })
    await expect(validate({ type: 'switch_session', sessionPath: '/etc/passwd' }, validateSessionPath)).rejects.toThrow('sessionPath is not inside a project')
  })

  it('validates fork and set_session_name', async () => {
    await expect(validate({ type: 'fork', entryId: 'entry-1' })).resolves.toEqual({ type: 'fork', entryId: 'entry-1' })
    await expect(validate({ type: 'fork', entryId: 'entry 1' })).rejects.toThrow('entryId contains invalid characters')
    await expect(validate({ type: 'set_session_name', name: '  Release prep  ' })).resolves.toEqual({ type: 'set_session_name', name: 'Release prep' })
    await expect(validate({ type: 'set_session_name', name: '   ' })).rejects.toThrow('name is too short')
  })

  it('validates cross-session messaging and observation', async () => {
    await expect(validate({ type: 'send_message', targetActiveSessionId: 'session-2', message: 'ping' })).resolves.toEqual({ type: 'send_message', targetActiveSessionId: 'session-2', message: 'ping' })
    await expect(validate({ type: 'send_message', targetActiveSessionId: 'session-2', message: '' })).rejects.toThrow('message is too short')
    await expect(validate({ type: 'observe', activeSessionId: 'session-2' })).resolves.toEqual({ type: 'observe', activeSessionId: 'session-2' })
    await expect(validate({ type: 'unobserve', activeSessionId: 'session-2' })).resolves.toEqual({ type: 'unobserve', activeSessionId: 'session-2' })
    await expect(validate({ type: 'observe', activeSessionId: '' })).rejects.toThrow('activeSessionId is too short')
  })
})

describe('validateRpcCommand heartbeat commands', () => {
  it('validates set_heartbeat with an optional delivery mode', async () => {
    await expect(validate({ type: 'set_heartbeat', schedule: ' every hour ', prompt: 'check CI' })).resolves.toEqual({ type: 'set_heartbeat', schedule: 'every hour', prompt: 'check CI' })
    await expect(validate({ type: 'set_heartbeat', schedule: 'every hour', prompt: 'check CI', deliveryMode: 'follow_up' })).resolves.toEqual({ type: 'set_heartbeat', schedule: 'every hour', prompt: 'check CI', deliveryMode: 'follow_up' })
    await expect(validate({ type: 'set_heartbeat', schedule: 'every hour', prompt: 'check CI', deliveryMode: 'followUp' })).rejects.toThrow('Invalid deliveryMode')
    await expect(validate({ type: 'set_heartbeat', schedule: '   ', prompt: 'check CI' })).rejects.toThrow('schedule is too short')
  })

  it('validates heartbeat updates and management', async () => {
    await expect(validate({ type: 'update_heartbeat', action: 'pause' })).resolves.toEqual({ type: 'update_heartbeat', action: 'pause' })
    await expect(validate({ type: 'update_heartbeat', action: 'stop' })).rejects.toThrow('Invalid heartbeat action')
    await expect(validate({ type: 'manage_heartbeat', activeSessionId: 'session-3', jobId: 'job-1', action: 'stop' })).resolves.toEqual({ type: 'manage_heartbeat', activeSessionId: 'session-3', jobId: 'job-1', action: 'stop' })
    await expect(validate({ type: 'manage_heartbeat', activeSessionId: 'session-3', jobId: 'job-1', action: 'clear' })).rejects.toThrow('Invalid heartbeat management action')
    await expect(validate({ type: 'manage_heartbeat', activeSessionId: 'session-3', action: 'stop' })).rejects.toThrow('jobId must be a string')
  })
})

describe('validateRpcCommand extension UI responses', () => {
  it('accepts cancellations, confirmations, and values as mutually exclusive shapes', async () => {
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', cancelled: true })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', confirmed: false })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', confirmed: false })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', value: 'answer' })).resolves.toEqual({ type: 'extension_ui_response', id: 'ui-1', value: 'answer' })
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: true, value: 'answer' })).rejects.toThrow('command.value is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', confirmed: true, cancelled: false })).rejects.toThrow('command.cancelled is not supported')
    await expect(validate({ type: 'extension_ui_response', id: 'ui-1', cancelled: false })).rejects.toThrow('command.cancelled is not supported')
    await expect(validate({ type: 'extension_ui_response', value: 'answer' })).rejects.toThrow('id must be a string')
  })
})
