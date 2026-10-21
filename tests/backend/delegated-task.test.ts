import { describe, expect, it, vi } from 'vitest'
import { type PromptedRuntimeRequest, startPromptedRuntime } from '../../electron/main/delegated-task'
import type { PrimeModelDescriptor, PrimeThinkingLevel, RuntimeInfo } from '../../src/types/api'

function model(key: string, name: string, levels: PrimeThinkingLevel[]): PrimeModelDescriptor {
  const separator = key.indexOf('/')
  return {
    key, provider: key.slice(0, separator), id: key.slice(separator + 1), name,
    reasoning: levels.length > 0, input: ['text'], contextWindow: 128_000, maxTokens: 16_000,
    availableThinkingLevels: levels, fastModeSupported: true, available: true,
  }
}

const started: RuntimeInfo = { runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/project', isStreaming: false, availableThinkingLevels: ['off', 'low', 'high'] }
const listed: RuntimeInfo = { ...started, isStreaming: true, sessionId: 'session-1', sessionFile: '/tmp/project/session.jsonl' }

function fakeManager(options: { listed?: RuntimeInfo[]; command?: (runtimeId: unknown, command: unknown) => Promise<Record<string, unknown>> } = {}) {
  const calls: string[] = []
  const start = vi.fn(async (_raw: unknown): Promise<RuntimeInfo> => { calls.push('start'); return started })
  const command = vi.fn(async (runtimeId: unknown, raw: unknown): Promise<Record<string, unknown>> => {
    calls.push(`command:${(raw as { type: string }).type}`)
    return options.command ? options.command(runtimeId, raw) : {}
  })
  const stop = vi.fn(async (_runtimeId: unknown): Promise<boolean> => { calls.push('stop'); return true })
  const list = vi.fn((): RuntimeInfo[] => options.listed ?? [listed])
  return { manager: { start, command, stop, list }, calls }
}

const request = (overrides: Partial<PromptedRuntimeRequest> = {}): PromptedRuntimeRequest => ({
  cwd: '/tmp/project',
  prompt: 'Implement the feature',
  missingSessionMessage: 'The harness did not create a visible session.',
  ...overrides,
})

describe('startPromptedRuntime', () => {
  it('starts the selected model, queues the prompt and returns the re-read runtime', async () => {
    const { manager, calls } = fakeManager()
    const sonnet = model('anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5', ['off', 'low', 'medium', 'high'])
    const result = await startPromptedRuntime(manager, request({ model: sonnet, reasoningQuery: 'deep', title: 'Feature', fast: false }))

    expect(manager.start).toHaveBeenCalledWith({ cwd: '/tmp/project', model: 'anthropic/claude-sonnet-4-5', thinking: 'high', fast: false })
    expect(manager.command.mock.calls).toEqual([
      ['runtime-1', { type: 'prompt', message: 'Implement the feature', streamingBehavior: 'followUp' }],
      ['runtime-1', { type: 'set_session_name', name: 'Feature' }],
      ['runtime-1', { type: 'get_state' }],
    ])
    expect(calls).toEqual(['start', 'command:prompt', 'command:set_session_name', 'command:get_state'])
    expect(manager.stop).not.toHaveBeenCalled()
    expect(result).toEqual({ runtime: listed, reasoning: 'high' })
  })

  it('omits undefined start options and skips optional commands', async () => {
    const { manager } = fakeManager()
    const result = await startPromptedRuntime(manager, request())

    expect(manager.start).toHaveBeenCalledWith({ cwd: '/tmp/project' })
    expect(manager.command.mock.calls.map(([, command]) => (command as { type: string }).type)).toEqual(['prompt', 'get_state'])
    expect(result).toEqual({ runtime: listed })
    expect(result).not.toHaveProperty('reasoning')
  })

  it('falls back to set_thinking_level on the default model using the runtime levels', async () => {
    const { manager } = fakeManager()
    const result = await startPromptedRuntime(manager, request({ reasoningQuery: 'medium' }))

    expect(manager.start).toHaveBeenCalledWith({ cwd: '/tmp/project' })
    expect(manager.command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'set_thinking_level', level: 'high' })
    expect(manager.command).toHaveBeenNthCalledWith(2, 'runtime-1', { type: 'prompt', message: 'Implement the feature', streamingBehavior: 'followUp' })
    expect(result.reasoning).toBe('high')
  })

  it('treats a failed set_session_name as best effort', async () => {
    const { manager } = fakeManager({
      command: async (_runtimeId, raw) => {
        if ((raw as { type: string }).type === 'set_session_name') throw new Error('rename unsupported')
        return {}
      },
    })
    await expect(startPromptedRuntime(manager, request({ title: 'Feature' }))).resolves.toEqual({ runtime: listed })
    expect(manager.stop).not.toHaveBeenCalled()
  })

  it('abandons the runtime (onAbandon before stop) and rethrows when a command fails', async () => {
    const failure = new Error('prompt rejected')
    const { manager, calls } = fakeManager({
      command: async (_runtimeId, raw) => {
        if ((raw as { type: string }).type === 'prompt') throw failure
        return {}
      },
    })
    manager.stop.mockImplementationOnce(async () => { calls.push('stop'); throw new Error('already gone') })
    const onAbandon = vi.fn((runtimeId: string) => { calls.push(`abandon:${runtimeId}`) })

    await expect(startPromptedRuntime(manager, request({ onAbandon }))).rejects.toBe(failure)
    expect(calls).toEqual(['start', 'command:prompt', 'abandon:runtime-1', 'stop'])
    expect(manager.stop).toHaveBeenCalledWith('runtime-1')
    expect(manager.list).not.toHaveBeenCalled()
  })

  it('abandons the runtime when the harness reports no session file', async () => {
    const { manager, calls } = fakeManager({ listed: [{ ...started, isStreaming: true }] })
    const onAbandon = vi.fn((runtimeId: string) => { calls.push(`abandon:${runtimeId}`) })

    await expect(startPromptedRuntime(manager, request({ onAbandon }))).rejects.toThrow('The harness did not create a visible session.')
    expect(calls).toEqual(['start', 'command:prompt', 'command:get_state', 'abandon:runtime-1', 'stop'])
  })

  it('falls back to the start snapshot when the runtime is no longer listed', async () => {
    const { manager } = fakeManager({ listed: [] })
    await expect(startPromptedRuntime(manager, request())).rejects.toThrow('The harness did not create a visible session.')
    expect(manager.stop).toHaveBeenCalledWith('runtime-1')
  })

  it('does not start a runtime when the selected model cannot take the reasoning request', async () => {
    const { manager } = fakeManager()
    const plain = model('local/plain', 'Plain', [])
    await expect(startPromptedRuntime(manager, request({ model: plain, reasoningQuery: 'high' }))).rejects.toThrow(/reasoning levels/)
    expect(manager.start).not.toHaveBeenCalled()
  })
})
