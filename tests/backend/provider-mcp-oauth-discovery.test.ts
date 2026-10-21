import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthLoginCallbacks, OAuthProviderInterface } from 'prime-agent-ai/oauth'
import type { ProviderAuthEvent } from '../../src/types/api'
import { PrimeProviderService } from '../../electron/main/providers'

const dirs: string[] = []
const services: PrimeProviderService[] = []
afterEach(() => {
  for (const provider of services.splice(0)) provider.cancelAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function service(options: { openExternal?: (url: string) => Promise<void> } = {}): PrimeProviderService {
  const dir = createTempDir('gooeypi-provider-mcp-')
  return new PrimeProviderService({
    authPath: join(dir, 'auth.json'),
    modelsPath: join(dir, 'models.json'),
    ...options,
  })
}

describe('MCP OAuth boundary', () => {
  it('rejects MCP-prefixed ids at the generic boundaries before network or browser launch', async () => {
    const fetchMock = vi.fn()
    const openExternal = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', fetchMock)
    const providerService = service({ openExternal })

    await expect(providerService.startOAuth('mcp:notion')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    await expect(providerService.saveApiKey('mcp:custom-server', 'secret')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('provider login flow bookkeeping', () => {
  it('ignores responses and cancellations for unknown flows', () => {
    const providerService = service()
    expect(providerService.respondOAuth('flow-1', 'prompt-1', 'value')).toBe(false)
    expect(providerService.cancelOAuth('flow-1')).toBe(false)
    expect(() => providerService.respondOAuth('', 'prompt-1', 'value')).toThrow('flowId is too short')
    expect(() => providerService.cancelOAuth(7)).toThrow('flowId must be a string')
    expect(() => providerService.cancelAll()).not.toThrow()
  })
})

async function oauthFixture() {
  const openExternal = vi.fn(async () => undefined)
  const provider = service({ openExternal })
  services.push(provider)
  const events: ProviderAuthEvent[] = []
  provider.setEventSink((event) => events.push(event))
  vi.spyOn(provider, 'catalog').mockResolvedValue({ primeVersion: 'test', refreshedAt: '', models: [], providers: [{ id: 'test-oauth', name: 'Test', authMethod: 'oauth', configured: false, modelCount: 0, availableModelCount: 0, enabled: true }] })
  let callbacks: OAuthLoginCallbacks | undefined
  const internals = provider as unknown as { authStorage: { getOAuthProviders(): OAuthProviderInterface[] } }
  vi.spyOn(internals.authStorage, 'getOAuthProviders').mockReturnValue([{
    id: 'test-oauth', name: 'Test',
    login: async (value) => {
      callbacks = value
      return new Promise<never>((_resolve, reject) => { value.signal?.addEventListener('abort', () => reject(value.signal?.reason), { once: true }) })
    },
    refreshToken: async (credentials) => credentials,
    getApiKey: (credentials) => credentials.access,
  }])
  const { flowId } = await provider.startOAuth('test-oauth')
  if (!callbacks) throw new Error('Login did not receive callbacks')
  return { provider, callbacks, flowId, events, openExternal }
}

describe('provider OAuth flow', () => {
  it.each(['file:///tmp/auth', 'javascript:alert(1)', 'https://user:password@example.test/auth'])('checks authorization URL %s before opening or emitting it', async (url) => {
    const { callbacks, events, openExternal } = await oauthFixture()
    expect(() => callbacks.onAuth({ url })).toThrow()
    expect(events).toEqual([])
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('checks liveness again if an authorization event cancels its flow', async () => {
    const { provider, callbacks, flowId, openExternal } = await oauthFixture()
    provider.setEventSink((event) => { if (event.type === 'auth') provider.cancelOAuth(flowId) })
    callbacks.onAuth({ url: 'https://example.test/auth' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('validates prompt identity, required responses, selection options and overlapping input', async () => {
    const { provider, callbacks, flowId, events } = await oauthFixture()
    const answer = callbacks.onPrompt({ message: 'Authorization code', allowEmpty: false })
    const prompt = events.find((event) => event.type === 'prompt')
    if (prompt?.type !== 'prompt') throw new Error('Missing prompt')
    expect(provider.respondOAuth(flowId, 'wrong-prompt', 'code')).toBe(false)
    expect(() => provider.respondOAuth(flowId, prompt.promptId, ' ')).toThrow('required')
    await expect(callbacks.onPrompt({ message: 'Overlapping prompt' })).rejects.toThrow('overlapping')
    expect(provider.respondOAuth(flowId, prompt.promptId, 'code')).toBe(true)
    await expect(answer).resolves.toBe('code')
    if (!callbacks.onSelect) throw new Error('Missing select callback')
    const selection = callbacks.onSelect({ message: 'Select account', options: [{ id: 'one', label: 'One' }] })
    const select = events.find((event) => event.type === 'select')
    if (select?.type !== 'select') throw new Error('Missing selection')
    expect(() => provider.respondOAuth(flowId, select.promptId, 'other')).toThrow('Invalid provider login selection')
    expect(provider.respondOAuth(flowId, select.promptId, 'one')).toBe(true)
    await expect(selection).resolves.toBe('one')
  })

  it('times out pending input and immediately frees the provider flow slot', async () => {
    vi.useFakeTimers()
    const { provider, callbacks, flowId, events } = await oauthFixture()
    const prompt = callbacks.onPrompt({ message: 'Code' })
    const rejected = expect(prompt).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await rejected
    expect(provider.cancelOAuth(flowId)).toBe(false)
    expect(events.filter((event) => event.type === 'cancelled')).toHaveLength(1)
    await expect(provider.startOAuth('test-oauth')).resolves.toHaveProperty('flowId')
  })
})
