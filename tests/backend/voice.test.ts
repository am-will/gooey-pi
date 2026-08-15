import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../electron/main/store'
import { VoiceService, voiceSecretStorageStatus, type VoiceServiceOptions } from '../../electron/main/voice'
import type { HarnessId, RuntimeInfo } from '../../src/types/api'

const directories: string[] = []

function project(harness: HarnessId = 'prime', inferred = false) {
  return {
    id: `${harness}-project`, harness, name: `${harness} project`, path: `/tmp/${harness}`,
    folders: [`/tmp/${harness}`], primaryFolder: `/tmp/${harness}`, pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 0, inferred,
  }
}

function model(key: string, name: string, levels: Array<'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>, available = true) {
  const separator = key.indexOf('/')
  return {
    key, provider: key.slice(0, separator), id: key.slice(separator + 1), name,
    reasoning: levels.length > 0, input: ['text'] as const, contextWindow: 128_000, maxTokens: 16_000,
    availableThinkingLevels: levels, fastModeSupported: false, available,
  }
}

function makeService(overrides: Partial<VoiceServiceOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-voice-test-'))
  directories.push(directory)
  const command = vi.fn(async () => ({}))
  const stop = vi.fn(async () => true)
  const start = vi.fn(async (): Promise<RuntimeInfo> => ({ runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/prime', isStreaming: false }))
  const list = vi.fn(() => [{ runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/prime', isStreaming: true, sessionId: 'session-1', sessionFile: '/tmp/session.jsonl' }])
  const agent = { start, command, stop, list }
  const catalog = async (_force = false, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()) => ({
    primeVersion: 'test', refreshedAt: '2026-01-01T00:00:00.000Z',
    providers: [
      { id: 'openai-codex', name: 'OpenAI Codex', authMethod: 'oauth' as const, configured: true, modelCount: 3, availableModelCount: 2, enabled: !disabledProviders.has('openai-codex') },
      { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key' as const, configured: true, modelCount: 2, availableModelCount: 1, enabled: !disabledProviders.has('anthropic') },
    ],
    models: [
      model('openai-codex/gpt-5.6-sol', 'GPT-5.6 Sol', ['low', 'medium', 'high', 'max']),
      model('openai-codex/gpt-5.6-luna', 'GPT-5.6 Luna', ['low', 'high']),
      model('openai-codex/gpt-hidden', 'GPT Hidden', ['high'], false),
      model('anthropic/claude-sonnet-4-6', 'Claude Sonnet 4.6', ['off', 'max']),
      model('anthropic/claude-opus-hidden', 'Claude Opus Hidden', ['high'], false),
    ].map((entry) => ({ ...entry, enabled: !disabledModels.has(entry.key) })),
  })
  const primeCatalog = vi.fn(catalog)
  const ompCatalog = vi.fn(catalog)
  const options: VoiceServiceOptions = {
    secretPath: join(directory, 'voice-secrets.json'),
    secretCodec: {
      status: () => ({ available: true }),
      encrypt: (value) => Buffer.from(`encrypted:${value}`),
      decrypt: (value) => value.toString().replace(/^encrypted:/, ''),
    },
    settings: defaultSettings,
    projects: {
      prime: { list: vi.fn(async () => [project('prime')]) },
      omp: { list: vi.fn(async () => [project('omp')]) },
      pi: { list: vi.fn(async () => [project('pi')]) },
    } as unknown as VoiceServiceOptions['projects'],
    agents: { prime: agent, omp: agent, pi: agent } as unknown as VoiceServiceOptions['agents'],
    catalogs: {
      prime: { catalog: primeCatalog },
      omp: { catalog: ompCatalog },
      pi: { catalog: vi.fn(catalog) },
    } as unknown as VoiceServiceOptions['catalogs'],
    runProcess: vi.fn(),
    environment: {},
    ...overrides,
  }
  return { service: new VoiceService(options), agent, options }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('VoiceService', () => {
  it('rejects Linux basic-text storage with actionable setup guidance', () => {
    expect(voiceSecretStorageStatus('linux', true, 'basic_text')).toEqual({
      available: false,
      message: 'GooeyPi will not save voice API keys because this Linux desktop is using unprotected basic-text storage. Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.',
    })
    expect(voiceSecretStorageStatus('linux', true, 'gnome_libsecret')).toEqual({ available: true })
    expect(voiceSecretStorageStatus('win32', true)).toEqual({ available: true })
  })

  it('stores encrypted API keys and only returns credential status', async () => {
    const { service } = makeService()
    expect(await service.credentialStatus()).toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: {},
      storage: { available: true },
    })
    expect(await service.saveApiKey('openai', 'sk-secret-value')).toEqual({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'saved' },
      storage: { available: true },
    })
    expect(JSON.stringify(await service.credentialStatus())).not.toContain('sk-secret-value')
  })

  it('does not decrypt or use a saved key while secure storage is unavailable', async () => {
    let storageAvailable = true
    const decrypt = vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
    const message = 'Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.'
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer sk-session-value' })
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({
      secretCodec: {
        status: () => storageAvailable ? { available: true } : { available: false, message },
        encrypt: (value) => Buffer.from(`encrypted:${value}`),
        decrypt,
      },
      fetch: fetchMock as typeof fetch,
    })
    await service.saveApiKey('openai', 'sk-secret-value')
    storageAvailable = false

    await expect(service.credentialStatus()).resolves.toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'saved' },
      storage: { available: false, message },
    })
    await expect(service.createRealtimeCall({ mode: 'conversation', sdp: 'v=0\r\no=offer-value', harness: 'prime' })).rejects.toThrow(message)
    expect(decrypt).not.toHaveBeenCalled()

    await expect(service.saveApiKey('openai', 'sk-session-value')).resolves.toEqual({
      configured: { openai: true, groq: false, deepgram: false, 'self-hosted': false },
      source: { openai: 'session' },
      storage: { available: false, message },
    })
    await expect(service.createRealtimeCall({ mode: 'conversation', sdp: 'v=0\r\no=offer-value', harness: 'prime' })).resolves.toContain('o=answer')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('keeps a fallback key only in memory when secure storage is unavailable', async () => {
    const message = 'Install and unlock GNOME Keyring (libsecret) or KWallet, then restart GooeyPi.'
    const encrypt = vi.fn((value: string) => Buffer.from(`encrypted:${value}`))
    const { service, options } = makeService({
      secretCodec: {
        status: () => ({ available: false, message }),
        encrypt,
        decrypt: (value) => value.toString().replace(/^encrypted:/, ''),
      },
    })

    const status = await service.saveApiKey('groq', 'gsk-session-secret')
    expect(status).toEqual({
      configured: { openai: false, groq: true, deepgram: false, 'self-hosted': false },
      source: { groq: 'session' },
      storage: { available: false, message },
    })
    expect(JSON.stringify(status)).not.toContain('gsk-session-secret')
    expect(encrypt).not.toHaveBeenCalled()
    expect(existsSync(options.secretPath)).toBe(false)

    const restartedService = new VoiceService(options)
    await expect(restartedService.credentialStatus()).resolves.toEqual({
      configured: { openai: false, groq: false, deepgram: false, 'self-hosted': false },
      source: {},
      storage: { available: false, message },
    })
  })

  it('transcribes through a self-hosted Parakeet or Whisper endpoint with a securely stored token', async () => {
    const settings = {
      ...defaultSettings(),
      voiceTranscriptionProvider: 'self-hosted' as const,
      voiceSelfHostedUrl: 'https://speech.example.test/v1',
      voiceSelfHostedModel: 'nvidia/parakeet-tdt-0.6b-v3',
    }
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://speech.example.test/v1/audio/transcriptions')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      expect(init?.headers).toEqual({ Authorization: 'Bearer local-asr-token' })
      const form = init?.body as FormData
      expect(form.get('model')).toBe('nvidia/parakeet-tdt-0.6b-v3')
      expect(form.get('response_format')).toBe('json')
      expect(form.get('file')).toBeInstanceOf(Blob)
      return Response.json({ text: 'A local transcript.' })
    })
    const { service } = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch })
    await service.saveApiKey('self-hosted', 'local-asr-token')

    await expect(service.transcribe({ provider: 'self-hosted', audio: new Uint8Array(44) })).resolves.toBe('A local transcript.')
    expect(JSON.stringify(await service.credentialStatus())).not.toContain('local-asr-token')
  })

  it('tests a token-free self-hosted endpoint through the actual transcription route', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:9000/v1/audio/transcriptions')
      expect(init?.headers).toBeUndefined()
      const form = init?.body as FormData
      expect(form.get('model')).toBeNull()
      expect(form.get('language')).toBe('en-US')
      expect((form.get('file') as Blob).size).toBeGreaterThan(44)
      return Response.json({ text: '' })
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })

    await expect(service.testSelfHosted({ url: 'http://127.0.0.1:9000/v1/audio/transcriptions', model: '' })).resolves.toBe(true)
  })

  it('rejects insecure remote self-hosted URLs and oversized provider responses', async () => {
    const { service } = makeService()
    await expect(service.testSelfHosted({ url: 'http://192.168.1.20:9000', model: '' })).rejects.toThrow(/HTTPS or an SSH tunnel/)

    const settings = { ...defaultSettings(), voiceSelfHostedUrl: 'https://speech.example.test', voiceSelfHostedModel: '' }
    const fetchMock = vi.fn(async () => new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }))
    const oversized = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch }).service
    await expect(oversized.transcribe({ provider: 'self-hosted', audio: new Uint8Array(44) })).rejects.toThrow(/response was too large/)
  })

  it('creates a realtime session with orchestration tools and no confirmation gate', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      const session = JSON.parse(String(form.get('session'))) as { instructions: string; tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> }
      expect(session.instructions).toContain('Do not ask for a second confirmation')
      expect(session.instructions).toContain('locked to the currently selected OMP harness')
      expect(session.instructions).toContain('Do not include phrases such as start a session')
      expect(session.instructions).toContain('"Determine the next logical feature to add to this project and explain why."')
      expect(session.instructions).toContain('first call get_local_context, then call search_web')
      expect(session.instructions).toContain('Do not ask the user for a location unless get_local_context returns no usable location_hint')
      expect(session.instructions).toContain('Choose the closest available model and the closest reasoning level')
      expect(session.tools.map((tool) => tool.name)).toEqual(['list_projects', 'list_models', 'start_task', 'get_local_context', 'search_web'])
      expect(session.tools.find((tool) => tool.name === 'start_task')?.parameters.properties).toHaveProperty('model')
      expect(session.tools.find((tool) => tool.name === 'start_task')?.parameters.properties).toHaveProperty('reasoning')
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await expect(service.createRealtimeCall({ mode: 'conversation', sdp: 'v=0\r\no=offer-value', harness: 'omp' })).resolves.toContain('o=answer')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('uses the selected native streaming transcription model', async () => {
    const settings = { ...defaultSettings(), voiceOpenAiLiveTranscriptionModel: 'gpt-realtime-whisper' }
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData
      const session = JSON.parse(String(form.get('session'))) as { audio: { input: { transcription: { model: string } } } }
      expect(session.audio.input.transcription.model).toBe('gpt-realtime-whisper')
      return new Response('v=0\r\no=answer')
    })
    const { service } = makeService({ settings: () => settings, fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await service.createRealtimeCall({ mode: 'transcription', sdp: 'v=0\r\no=offer-value' })
  })

  it('starts an explicitly requested task immediately in an existing granted project', async () => {
    const { service, agent } = makeService()
    const result = await service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Implement the feature', title: 'Voice feature' } }, 'prime')
    expect(agent.start).toHaveBeenCalledWith({ cwd: '/tmp/prime' })
    expect(agent.command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'prompt', message: 'Implement the feature' })
    expect(agent.command).toHaveBeenCalledWith('runtime-1', { type: 'get_state' })
    expect(result.task).toEqual({
      projectId: 'prime-project', projectName: 'prime project', harness: 'prime',
      runtimeId: 'runtime-1', sessionId: 'session-1', sessionFile: '/tmp/session.jsonl',
    })
  })

  it.each([
    ['prime', '/mcp login notion'],
    ['omp', '/mcp reauth docs'],
    ['pi', '/mcp-auth files'],
  ] as const)('rejects a %s MCP auth voice task before runtime start', async (harness, prompt) => {
    const { service, agent, options } = makeService()

    await expect(service.executeTool({
      name: 'start_task', arguments: { project_id: `${harness}-project`, prompt },
    }, harness)).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(options.projects[harness].list).not.toHaveBeenCalled()
    expect(agent.start).not.toHaveBeenCalled()
  })

  it('lists only available models from GUI-visible providers and searches approximate names', async () => {
    const settings = { ...defaultSettings(), disabledProviders: ['anthropic'] }
    const { service } = makeService({ settings: () => settings })
    const result = await service.executeTool({ name: 'list_models', arguments: { query: 'GPT five six sol' } }, 'prime')
    expect(JSON.parse(result.output)).toEqual({
      models: [{
        key: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai-codex',
        reasoning_levels: ['low', 'medium', 'high', 'max'],
      }, {
        key: 'openai-codex/gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai-codex',
        reasoning_levels: ['low', 'high'],
      }],
      matched: 2,
      returned: 2,
      truncated: false,
    })
  })

  it('keeps Prime and OMP provider visibility independent during model discovery', async () => {
    const settings = { ...defaultSettings(), disabledProviders: ['openai-codex'], ompDisabledProviders: ['anthropic'] }
    const { service, options } = makeService({ settings: () => settings })
    const primeResult = await service.executeTool({ name: 'list_models', arguments: { query: 'GPT' } }, 'prime')
    const ompResult = await service.executeTool({ name: 'list_models', arguments: { query: 'GPT' } }, 'omp')
    expect(JSON.parse(primeResult.output).models).toEqual([])
    expect(JSON.parse(ompResult.output).models).toHaveLength(2)
    expect(options.catalogs.prime.catalog).toHaveBeenCalledWith(false, new Set(['openai-codex']), new Set())
    expect(options.catalogs.omp.catalog).toHaveBeenCalledWith(false, new Set(['anthropic']), new Set())
  })

  it('omits desktop-disabled models without hiding their provider siblings', async () => {
    const settings = { ...defaultSettings(), disabledModels: ['openai-codex/gpt-5.6-sol'] }
    const { service } = makeService({ settings: () => settings })
    const result = await service.executeTool({ name: 'list_models', arguments: { query: 'GPT five six' } }, 'prime')
    const keys = JSON.parse(result.output).models.map((entry: { key: string }) => entry.key) as string[]
    expect(keys).toContain('openai-codex/gpt-5.6-luna')
    expect(keys).not.toContain('openai-codex/gpt-5.6-sol')
  })

  it('starts with the closest active model and supported reasoning level', async () => {
    const { service, agent } = makeService()
    const result = await service.executeTool({
      name: 'start_task',
      arguments: {
        project_id: 'prime-project', prompt: 'Implement it', model: 'GPT five six sol', reasoning: 'very high',
      },
    }, 'prime')
    expect(agent.start).toHaveBeenCalledWith({
      cwd: '/tmp/prime', model: 'openai-codex/gpt-5.6-sol', thinking: 'max',
    })
    expect(result.task).toMatchObject({
      model: { key: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
      reasoning: 'max',
    })
  })

  it('maps a high reasoning request to max when max is the only supported high tier', async () => {
    const { service, agent } = makeService()
    await service.executeTool({
      name: 'start_task',
      arguments: {
        project_id: 'prime-project', prompt: 'Implement it', model: 'Claude Sonnet 4.6', reasoning: 'high',
      },
    }, 'prime')
    expect(agent.start).toHaveBeenCalledWith({
      cwd: '/tmp/prime', model: 'anthropic/claude-sonnet-4-6', thinking: 'max',
    })
  })

  it('applies approximate reasoning to the harness default model before prompting', async () => {
    const { service, agent } = makeService()
    agent.start.mockResolvedValue({
      runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/prime', isStreaming: false,
      availableThinkingLevels: ['minimal', 'high'],
    })
    const result = await service.executeTool({
      name: 'start_task',
      arguments: { project_id: 'prime-project', prompt: 'Implement it', reasoning: 'somewhere in the middle' },
    }, 'prime')
    expect(agent.start).toHaveBeenCalledWith({ cwd: '/tmp/prime' })
    expect(agent.command).toHaveBeenNthCalledWith(1, 'runtime-1', { type: 'set_thinking_level', level: 'high' })
    expect(agent.command).toHaveBeenNthCalledWith(2, 'runtime-1', { type: 'prompt', message: 'Implement it' })
    expect(result.task?.reasoning).toBe('high')
  })

  it('does not report success when the harness fails to expose a saved session', async () => {
    const { service, agent } = makeService()
    agent.list.mockReturnValue([])
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Implement it' } }, 'prime')).rejects.toThrow(/did not create a visible session/)
    expect(agent.stop).toHaveBeenCalledWith('runtime-1')
  })

  it('never promotes an inferred project into a voice task grant', async () => {
    const { service, options } = makeService()
    vi.mocked(options.projects.prime.list).mockResolvedValue([project('prime', true)])
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Run it' } }, 'prime')).rejects.toThrow(/explicitly granted/)
  })

  it('scopes project lookup and task starts to the selected harness', async () => {
    const { service, options } = makeService()
    const listed = await service.executeTool({ name: 'list_projects', arguments: {} }, 'omp')
    expect(JSON.parse(listed.output)).toEqual({ projects: [{ id: 'omp-project', name: 'omp project', harness: 'omp', lastOpenedAt: '2026-01-01T00:00:00.000Z' }] })
    expect(options.projects.omp.list).toHaveBeenCalled()
    expect(options.projects.prime.list).not.toHaveBeenCalled()
    await expect(service.executeTool({ name: 'start_task', arguments: { project_id: 'prime-project', prompt: 'Run it' } }, 'omp')).rejects.toThrow(/selected OMP harness/)
  })

  it('dispatches an OMP-scoped voice task only through the OMP manager', async () => {
    const manager = (harness: 'prime' | 'omp') => ({
      start: vi.fn(async () => ({ runtimeId: `${harness}-runtime`, harness, cwd: `/tmp/${harness}`, isStreaming: false })),
      command: vi.fn(async () => ({})),
      stop: vi.fn(async () => true),
      list: vi.fn(() => [{ runtimeId: `${harness}-runtime`, harness, cwd: `/tmp/${harness}`, isStreaming: true, sessionFile: `/tmp/${harness}-session.jsonl` }]),
    })
    const primeAgent = manager('prime')
    const ompAgent = manager('omp')
    const { service } = makeService({ agents: { prime: primeAgent, omp: ompAgent } as unknown as VoiceServiceOptions['agents'] })
    const result = await service.executeTool({ name: 'start_task', arguments: { project_id: 'omp-project', prompt: 'Determine the next logical feature.' } }, 'omp')
    expect(primeAgent.start).not.toHaveBeenCalled()
    expect(ompAgent.start).toHaveBeenCalledWith({ cwd: '/tmp/omp' })
    expect(ompAgent.command).toHaveBeenNthCalledWith(1, 'omp-runtime', { type: 'prompt', message: 'Determine the next logical feature.' })
    expect(result.task?.harness).toBe('omp')
  })

  it('returns bounded local context without a calculation tool', async () => {
    const { service } = makeService()
    const result = await service.executeTool({ name: 'get_local_context', arguments: {} }, 'omp')
    const context = JSON.parse(result.output) as Record<string, string>
    expect(context.active_harness).toBe('omp')
    expect(context.time_zone).toBeTruthy()
    expect(context.utc_offset).toMatch(/^[+-]\d{2}:\d{2}$/)
    expect(context.location_hint).toBeTruthy()
    expect(context.location_precision).toMatch(/time-zone|country/)
  })

  it('uses low-context Responses web search for quick voice lookups', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-5.6-luna',
        tools: [{ type: 'web_search', search_context_size: 'low' }],
        input: 'What happened today?',
      })
      return Response.json({ output_text: 'A quick cited answer.' })
    })
    const { service } = makeService({ fetch: fetchMock as typeof fetch })
    await service.saveApiKey('openai', 'sk-test')
    await expect(service.executeTool({ name: 'search_web', arguments: { query: 'What happened today?' } }, 'prime')).resolves.toEqual({
      output: JSON.stringify({ answer: 'A quick cited answer.' }),
    })
  })
})
