import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OAuthLoginCallbacks } from 'prime-agent-ai/oauth'
import { AuthStorage } from 'prime-agent'
import { MAX_CATALOG_PROVIDERS, PrimeProviderService, resolveAvailableModelKeys } from '../../electron/main/providers'
import type { PrimeImplementation, PrimeModelCatalog } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function service(): PrimeProviderService {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-providers-'))
  dirs.push(dir)
  return new PrimeProviderService({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
}

function serviceWithAuthPath(): { providerService: PrimeProviderService; authPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-provider-auth-'))
  dirs.push(dir)
  const authPath = join(dir, 'auth.json')
  return { providerService: new PrimeProviderService({ authPath, modelsPath: join(dir, 'models.json') }), authPath }
}

function serviceWithModels(config: unknown): PrimeProviderService {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-provider-models-'))
  dirs.push(dir)
  const modelsPath = join(dir, 'models.json')
  writeFileSync(modelsPath, JSON.stringify(config))
  return new PrimeProviderService({ authPath: join(dir, 'auth.json'), modelsPath })
}

function primeModel(provider: string, id: string): Record<string, unknown> {
  return {
    provider,
    id,
    name: `${provider} ${id}`,
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:8118/v1',
    reasoning: false,
    input: ['text'],
    contextWindow: 1,
    maxTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

function serviceWithRegistryModels(models: unknown[], options: { executableModels?: unknown[] } = {}): PrimeProviderService {
  const providerService = service()
  const internals = providerService as unknown as {
    authStorage: { getOAuthProviders(): Array<{ id: string; name: string }> }
    registry: {
      refreshModelCatalog(): Promise<{ models: unknown[] }>
      getExecutableModels(): Promise<unknown[]>
      getProviderAuthStatus(id: string): { configured: boolean; source: string; label: string }
      getProviderDisplayName(id: string): string
      getError(): string | undefined
    }
  }
  internals.authStorage.getOAuthProviders = () => []
  internals.registry.refreshModelCatalog = async () => ({ models })
  internals.registry.getExecutableModels = async () => options.executableModels ?? models
  internals.registry.getProviderAuthStatus = () => ({ configured: true, source: 'stored', label: 'Test credentials' })
  internals.registry.getProviderDisplayName = (id) => id
  internals.registry.getError = () => undefined
  return providerService
}

function expectRelationalIntegrity(catalog: PrimeModelCatalog): void {
  const providerIds = catalog.providers.map((provider) => provider.id)
  expect(new Set(providerIds).size).toBe(providerIds.length)
  const providerIdSet = new Set(providerIds)
  for (const model of catalog.models) expect(providerIdSet.has(model.provider)).toBe(true)
  for (const provider of catalog.providers) {
    const models = catalog.models.filter((model) => model.provider === provider.id)
    expect(provider.modelCount).toBe(models.length)
    expect(provider.availableModelCount).toBe(models.filter((model) => model.available).length)
  }
}

describe('Prime provider adapter', () => {
  it('keeps configured ChatGPT subscription models selectable when discovery returns no models', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'anthropic', id: 'claude-sonnet-5' }],
      [{ provider: 'anthropic', id: 'claude-sonnet-5' }],
      new Set(['openai-codex', 'anthropic']),
    )

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'anthropic/claude-sonnet-5']))
    expect(result.fallbackProviders).toEqual(['openai-codex'])
  })

  it('keeps configured ChatGPT subscription models selectable when discovery is partial', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'openai-codex', id: 'gpt-5.6-terra' }],
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }],
      new Set(['openai-codex']),
    )

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra']))
    expect(result.fallbackProviders).toEqual(['openai-codex'])
  })

  it('does not warn when configured ChatGPT discovery contains the complete catalogue', () => {
    const models = [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'openai-codex', id: 'gpt-5.6-terra' }]
    const result = resolveAvailableModelKeys(models, models, new Set(['openai-codex']))

    expect(result.keys).toEqual(new Set(['openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra']))
    expect(result.fallbackProviders).toEqual([])
  })

  it('does not make subscription models available for an unconfigured provider', () => {
    const result = resolveAvailableModelKeys(
      [{ provider: 'openai-codex', id: 'gpt-5.6-sol' }, { provider: 'anthropic', id: 'claude-sonnet-5' }],
      [{ provider: 'anthropic', id: 'claude-sonnet-5' }],
      new Set(['anthropic']),
    )

    expect(result.keys).toEqual(new Set(['anthropic/claude-sonnet-5']))
    expect(result.fallbackProviders).toEqual([])
  })

  it('returns the Prime catalog with model-specific capability metadata', async () => {
    const providerService = service()
    const catalog = await providerService.catalog(true)
    const gpt54 = catalog.models.find((model) => model.provider === 'openai-codex' && model.id === 'gpt-5.4')
    const gpt56 = catalog.models.find((model) => model.provider === 'openai-codex' && model.id === 'gpt-5.6-sol')

    expect(catalog.models.length).toBeGreaterThan(100)
    expect(catalog.providers.length).toBeGreaterThan(10)
    expect(gpt54?.fastModeSupported).toBe(true)
    expect(gpt54?.availableThinkingLevels).not.toContain('max')
    expect(gpt56?.availableThinkingLevels).toContain('max')
    expect(gpt56?.availableThinkingLevels).not.toContain('minimal')
    expectRelationalIntegrity(catalog)
    const providerNames = catalog.providers.map((provider) => provider.name)
    expect(providerNames).toEqual([...providerNames].sort((left, right) => left.localeCompare(right, 'en-US')))
    expect(new Set(catalog.models.map((model) => model.key)).size).toBe(catalog.models.length)
    const cached = await providerService.catalog()
    expect(cached.models).toEqual(catalog.models)
    expect(cached.providers).toEqual(catalog.providers)
  })

  it('single-flights concurrent catalog refreshes and clears the in-flight promise', async () => {
    const providerService = service()
    const registry = (providerService as unknown as { registry: { refreshModelCatalog(): Promise<unknown> } }).registry
    const original = registry.refreshModelCatalog.bind(registry)
    let refreshes = 0
    registry.refreshModelCatalog = async () => {
      refreshes += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return original()
    }

    const [first, second, third] = await Promise.all([
      providerService.catalog(true),
      providerService.catalog(true),
      providerService.catalog(true, new Set(['anthropic'])),
    ])
    expect(refreshes).toBe(1)
    expect(first.models.length).toBe(second.models.length)
    expect(third.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(false)
    expect(first.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(true)

    // After settling, a forced refresh runs again (the in-flight slot was cleared).
    await providerService.catalog(true)
    expect(refreshes).toBe(2)
  })

  it('keeps provider enablement as a desktop policy separate from authentication', async () => {
    const catalog = await service().catalog(true, new Set(['anthropic']))
    const anthropic = catalog.providers.find((provider) => provider.id === 'anthropic')

    expect(anthropic?.enabled).toBe(false)
    expect(typeof anthropic?.configured).toBe('boolean')
  })

  it('keeps model enablement as a per-key desktop policy', async () => {
    const initial = await service().catalog(true)
    const modelKey = initial.models[0]?.key
    expect(modelKey).toBeTruthy()
    const catalog = await service().catalog(false, new Set(), new Set([modelKey!]))
    expect(catalog.models.find((model) => model.key === modelKey)?.enabled).toBe(false)
    expect(catalog.models.filter((model) => model.key !== modelKey).every((model) => model.enabled)).toBe(true)
  })

  it('reports DeepSeek V4 Flash non-think, high, and max reasoning levels from custom config', async () => {
    const catalog = await serviceWithModels({ providers: {
      'deepseek-linux': {
        baseUrl: 'http://127.0.0.1:8118/v1', api: 'openai-completions', apiKey: 'prime-local',
        models: [{
          id: 'DeepSeek-V4-Flash', reasoning: true,
          thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: 'max' },
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, thinkingFormat: 'deepseek' },
        }],
      },
    }}).catalog(true)
    const deepseek = catalog.models.find((model) => model.provider === 'deepseek-linux' && model.id === 'DeepSeek-V4-Flash')

    expect(deepseek?.availableThinkingLevels).toEqual(['off', 'high', 'xhigh'])
  })

  it('keeps an exact-boundary catalog unchanged and relationally consistent', async () => {
    const models: unknown[] = []
    for (let index = 0; index < MAX_CATALOG_PROVIDERS; index += 1) {
      models.push(primeModel(`provider-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = MAX_CATALOG_PROVIDERS; index < 5_000; index += 1) {
      models.push(primeModel('provider-000', `model-${index}`))
    }

    const catalog = await serviceWithRegistryModels(models).catalog(true)

    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.warning).toBeUndefined()
    expectRelationalIntegrity(catalog)
  })

  it('caps provider-only overflow without returning orphan models', async () => {
    const models = Array.from({ length: MAX_CATALOG_PROVIDERS + 1 }, (_, index) => (
      primeModel(`provider-${String(index).padStart(3, '0')}`, 'model')
    ))
    const providerService = serviceWithRegistryModels(models)
    const catalog = await providerService.catalog(true)

    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.models).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.warning).toMatch(/257 valid providers.*retained 256.*1 omitted/)
    expect(catalog.warning).toMatch(/257 valid unique models.*retained 256.*1 omitted/)
    expect(catalog.warning).toContain('1 omitted by catalog limits: 1 with omitted providers and 0 beyond the model limit')
    expectRelationalIntegrity(catalog)
    await expect(providerService.requireAvailableModel('provider-256/model')).rejects.toThrow(/not found/)
    expect(await providerService.capabilities('provider-256', 'model')).toBeUndefined()
  })

  it('caps model-only overflow while keeping visibility and launch validation aligned', async () => {
    const models = Array.from({ length: 5_001 }, (_, index) => primeModel('provider-000', `model-${index}`))
    const providerService = serviceWithRegistryModels(models)
    const catalog = await providerService.catalog(true, new Set(), new Set(['provider-000/model-0']))

    expect(catalog.providers).toHaveLength(1)
    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.models[0]?.enabled).toBe(false)
    expect(catalog.warning).toMatch(/5,001 valid unique models.*retained 5,000.*1 omitted/)
    expect(catalog.warning).toContain('1 omitted by catalog limits: 0 with omitted providers and 1 beyond the model limit')
    expectRelationalIntegrity(catalog)
    await expect(providerService.requireAvailableModel('provider-000/model-5000')).rejects.toThrow(/not found/)
    await expect(providerService.requireAvailableModel('provider-000/model-0', new Set(), new Set(['provider-000/model-0']))).rejects.toThrow(/disabled/)
  })

  it('applies simultaneous model and provider caps as one relational operation', async () => {
    const models: unknown[] = []
    for (let index = 0; index < 300; index += 1) {
      models.push(primeModel(`overflow-${String(index).padStart(3, '0')}`, 'model'))
    }
    for (let index = 0; index < 5_010; index += 1) {
      models.push(primeModel('anthropic', `model-${index}`))
    }
    const providerService = serviceWithRegistryModels(models)
    const catalog = await providerService.catalog(true)

    expect(catalog.models).toHaveLength(5_000)
    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    const names = catalog.providers.map((provider) => provider.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(catalog.warning).toMatch(/301 valid providers.*retained 256.*45 omitted/)
    expect(catalog.warning).toMatch(/5,310 valid unique models.*retained 5,000.*310 omitted/)
    expect(catalog.warning).toContain('310 omitted by catalog limits: 45 with omitted providers and 265 beyond the model limit')
    expectRelationalIntegrity(catalog)
    expect(catalog.models.some((model) => model.provider === 'overflow-299')).toBe(false)
    await expect(providerService.requireAvailableModel('overflow-299/model')).rejects.toThrow(/not found/)
  })

  it('reports only providers represented after source order exhausts the model limit', async () => {
    const models: unknown[] = []
    for (let index = 0; index < 5_001; index += 1) models.push(primeModel('provider-255', `model-${index}`))
    for (let index = 0; index < 255; index += 1) models.push(primeModel(`provider-${String(index).padStart(3, '0')}`, 'model'))

    const catalog = await serviceWithRegistryModels(models).catalog(true)

    expect(catalog.providers).toHaveLength(MAX_CATALOG_PROVIDERS)
    expect(catalog.models).toHaveLength(5_000)
    expect(new Set(catalog.models.map((model) => model.provider))).toEqual(new Set(['provider-255']))
    expect(catalog.providers.find((provider) => provider.id === 'provider-255')).toMatchObject({ modelCount: 5_000, availableModelCount: 5_000 })
    expect(catalog.providers.find((provider) => provider.id === 'provider-000')).toMatchObject({ modelCount: 0, availableModelCount: 0 })
    expect(catalog.warning).toContain('retained 5,000 across 1 provider (256 omitted by catalog limits')
    expectRelationalIntegrity(catalog)
  })

  it('warns about Codex fallback only when a Codex model survives the limits', async () => {
    const retained = await serviceWithRegistryModels(
      [primeModel('openai-codex', 'gpt-retained')],
      { executableModels: [] },
    ).catalog(true)
    expect(retained.models.map((model) => model.key)).toEqual(['openai-codex/gpt-retained'])
    expect(retained.warning).toContain('configured Codex catalogue')

    const overflowModels = Array.from({ length: 5_000 }, (_, index) => primeModel('aa-source', `model-${index}`))
    overflowModels.push(primeModel('openai-codex', 'gpt-omitted'))
    const overflow = await serviceWithRegistryModels(overflowModels, {
      executableModels: overflowModels.filter((model) => (model as { provider: string }).provider !== 'openai-codex'),
    }).catalog(true)

    expect(overflow.providers.find((provider) => provider.id === 'openai-codex')).toMatchObject({ modelCount: 0, availableModelCount: 0 })
    expect(overflow.models.some((model) => model.provider === 'openai-codex')).toBe(false)
    expect(overflow.warning).not.toContain('configured Codex catalogue')
  })

  it('stores API keys through Prime auth storage without exposing them in the catalog', async () => {
    const { providerService, authPath } = serviceWithAuthPath()
    const secret = 'test-provider-secret-that-must-not-cross-back'

    await providerService.saveApiKey('openai', secret)
    const catalog = await providerService.catalog(true)
    const openai = catalog.providers.find((provider) => provider.id === 'openai')

    expect(openai?.configured).toBe(true)
    expect(openai?.authSource).toBe('stored')
    expect(JSON.stringify(catalog)).not.toContain(secret)
    expect(readFileSync(authPath, 'utf8')).toContain(secret)
    expect(statSync(authPath).mode & 0o777).toBe(0o600)

    await providerService.logout('openai')
    expect((await providerService.catalog(true)).providers.find((provider) => provider.id === 'openai')?.configured).toBe(false)
  })

  it('always allows retrying a provider login after cancel, even when login hangs', async () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { login(providerId: string, options: unknown): Promise<void> }
      flows: Map<string, { timer: NodeJS.Timeout }>
    }
    // A login that ignores the abort signal and never settles.
    internals.authStorage.login = () => new Promise<void>(() => undefined)

    const catalog = await providerService.catalog(true)
    const oauthProvider = catalog.providers.find((provider) => provider.authMethod === 'oauth')
    expect(oauthProvider).toBeDefined()

    const first = await providerService.startOAuth(oauthProvider!.id)
    await expect(providerService.startOAuth(oauthProvider!.id)).rejects.toThrow(/already active/)
    expect(providerService.cancelOAuth(first.flowId)).toBe(true)
    expect(internals.flows.size).toBe(0)

    // Cancel then retry must succeed immediately.
    const second = await providerService.startOAuth(oauthProvider!.id)
    expect(second.flowId).not.toBe(first.flowId)
    expect(providerService.cancelOAuth(second.flowId)).toBe(true)
    // A second cancel of the same flow is a no-op.
    expect(providerService.cancelOAuth(second.flowId)).toBe(false)
  })

  it('ignores late authorization URLs, progress and completion after OAuth cancellation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-oauth-cancel-'))
    dirs.push(dir)
    const openExternal = vi.fn(async () => undefined)
    const providerService = new PrimeProviderService({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), openExternal })
    const events = vi.fn()
    providerService.setEventSink(events)
    let callbacks!: OAuthLoginCallbacks
    let finish!: () => void
    const internals = providerService as unknown as { authStorage: { login(providerId: string, value: OAuthLoginCallbacks): Promise<void> } }
    internals.authStorage.login = async (_provider, value) => { callbacks = value; await new Promise<void>((resolve) => { finish = resolve }) }
    const provider = (await providerService.catalog()).providers.find((candidate) => candidate.authMethod === 'oauth')!
    const { flowId } = await providerService.startOAuth(provider.id)
    providerService.cancelOAuth(flowId)
    events.mockClear()
    callbacks.onAuth({ url: 'https://example.test/login' })
    callbacks.onProgress?.('Late progress')
    finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalled()
    expect(events).not.toHaveBeenCalled()
  })

  it('rejects OAuth for providers that do not own an OAuth flow', async () => {
    await expect(service().startOAuth('openai')).rejects.toThrow('requires api_key authentication')
  })

  it('rejects MCP provider ids at the generic OAuth boundary', async () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { login(providerId: string, options: unknown): Promise<void>; set(providerId: string, credential: unknown): void; logout(providerId: string): void }
    }
    const login = vi.fn(async () => undefined)
    const set = vi.fn()
    const logout = vi.fn()
    internals.authStorage.login = login
    internals.authStorage.set = set
    internals.authStorage.logout = logout

    await expect(providerService.startOAuth('mcp:notion')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    await expect(providerService.saveApiKey('mcp:notion', 'secret')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    await expect(providerService.logout('mcp:notion')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(login).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })

  it('surfaces built-in MCP entries without inspecting Prime credential storage', () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { get(providerId: string): unknown }
    }
    const get = vi.fn(() => { throw new Error('credential storage must not be inspected') })
    internals.authStorage.get = get
    expect(providerService.mcpCapabilities()).toContainEqual(expect.objectContaining({
      name: 'Notion', kind: 'mcp', location: 'bundled', enabled: false,
      availability: { available: false, detail: expect.stringContaining('managed outside GooeyPi') },
    }))
    expect(get).not.toHaveBeenCalled()
  })

  it('keeps model-registry construction and catalog refresh blind to existing MCP credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-provider-mcp-blind-'))
    dirs.push(dir)
    const authPath = join(dir, 'auth.json')
    const credential = { type: 'oauth', access: 'mcp-secret', refresh: 'mcp-refresh', expires: Date.now() + 3_600_000 }
    writeFileSync(authPath, JSON.stringify({ 'mcp:notion': credential }))
    const get = vi.spyOn(AuthStorage.prototype, 'get')
    const getAuthStatus = vi.spyOn(AuthStorage.prototype, 'getAuthStatus')
    const hasAuth = vi.spyOn(AuthStorage.prototype, 'hasAuth')
    const getApiKey = vi.spyOn(AuthStorage.prototype, 'getApiKey')
    const getApiKeyWithSourceToken = vi.spyOn(AuthStorage.prototype, 'getApiKeyWithSourceToken')
    const getProviderHeaders = vi.spyOn(AuthStorage.prototype, 'getProviderHeaders')
    const markAuthStale = vi.spyOn(AuthStorage.prototype, 'markAuthStale')
    const getCurrentAuthSourceToken = vi.spyOn(AuthStorage.prototype, 'getCurrentAuthSourceToken')
    const markAuthSourceStale = vi.spyOn(AuthStorage.prototype, 'markAuthSourceStale')
    const set = vi.spyOn(AuthStorage.prototype, 'set')
    const remove = vi.spyOn(AuthStorage.prototype, 'remove')
    const logout = vi.spyOn(AuthStorage.prototype, 'logout')

    const providerService = new PrimeProviderService({ authPath, modelsPath: join(dir, 'models.json') })
    const catalog = await providerService.catalog(true)

    const providerAccesses = [get, getAuthStatus, hasAuth, getApiKey, getApiKeyWithSourceToken, getProviderHeaders, markAuthStale, getCurrentAuthSourceToken]
      .flatMap((spy) => spy.mock.calls.map(([provider]) => provider))
    expect(providerAccesses.some((provider) => typeof provider === 'string' && provider.toLowerCase().startsWith('mcp:'))).toBe(false)
    expect(markAuthSourceStale.mock.calls.some(([token]) => token.provider.toLowerCase().startsWith('mcp:'))).toBe(false)
    expect([set, remove, logout].flatMap((spy) => spy.mock.calls.map(([provider]) => provider))
      .some((provider) => typeof provider === 'string' && provider.toLowerCase().startsWith('mcp:'))).toBe(false)
    expect(catalog.providers.some((provider) => provider.id.startsWith('mcp:'))).toBe(false)
    expect(readFileSync(authPath, 'utf8')).toBe(JSON.stringify({ 'mcp:notion': credential }))
  })

  it('does not expose MCP-specific credential mutation methods', () => {
    const providerService = service()
    expect(providerService).not.toHaveProperty('startMcpOAuth')
    expect(providerService).not.toHaveProperty('logoutMcp')
    expect(providerService).not.toHaveProperty('removeMcpCredential')
  })

})

describe('Prime CLI credentials', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  /** A home whose only Prime Inference login is the separate Prime CLI's ~/.prime/config.json. */
  function primeCliHome(): { configPath: string; config: string; agentDir: string } {
    const home = mkdtempSync(join(tmpdir(), 'prime-work-prime-cli-home-'))
    dirs.push(home)
    const agentDir = join(home, 'agent')
    mkdirSync(join(home, '.prime'))
    mkdirSync(agentDir)
    const configPath = join(home, '.prime', 'config.json')
    const config = `${JSON.stringify({ api_key: 'prime-cli-test-key', team_id: 'team-from-cli' }, null, 2)}\n`
    writeFileSync(configPath, config)
    vi.stubEnv('HOME', home)
    vi.stubEnv('PRIME_AGENT_CODING_AGENT_DIR', agentDir)
    vi.stubEnv('PRIME_API_KEY', '')
    vi.stubEnv('PRIME_TEAM_ID', '')
    // A configured Prime Inference login refreshes its private model list; keep that offline.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test') }))
    return { configPath, config, agentDir }
  }

  /** The Prime Inference row, and how many of its models GooeyPi would offer. */
  async function primeInference(providerService: PrimeProviderService) {
    const catalog = await providerService.catalog(true)
    return {
      provider: catalog.providers.find((provider) => provider.id === 'prime-inference'),
      offered: catalog.models.filter((model) => model.provider === 'prime-inference' && model.available).length,
    }
  }

  it('counts the Prime CLI login for TypeScript Prime by default', async () => {
    primeCliHome()
    const { provider, offered } = await primeInference(new PrimeProviderService())
    expect(provider).toMatchObject({ authSource: 'prime_cli', authLabel: 'Prime CLI' })
    expect(offered).toBeGreaterThan(0)
  })

  it('ignores and never rewrites the Prime CLI login for Rust Prime', async () => {
    const { configPath, config } = primeCliHome()
    const providerService = new PrimeProviderService({ primeCliCredentials: false })

    const { provider, offered } = await primeInference(providerService)
    expect(provider).toMatchObject({ configured: false, authSource: undefined })
    expect(offered).toBe(0)
    await providerService.logout('prime-inference')
    expect(readFileSync(configPath, 'utf8')).toBe(config)
  })

  it('stops using the Prime CLI login after the discovered build changes to Rust', async () => {
    const { configPath, config } = primeCliHome()
    let implementation: PrimeImplementation = 'typescript'
    // Node rejects the RPC argv, exercising the real failed-probe provider fallback.
    const providerService = new PrimeProviderService({ implementation: () => implementation, executable: process.execPath })
    expect((await primeInference(providerService)).provider).toMatchObject({ authSource: 'prime_cli' })

    implementation = 'rust'
    expect((await primeInference(providerService)).provider).toMatchObject({ configured: false, authSource: undefined })
    await providerService.logout('prime-inference')
    expect(readFileSync(configPath, 'utf8')).toBe(config)

    implementation = 'typescript'
    expect((await primeInference(providerService)).provider).toMatchObject({ authSource: 'prime_cli' })
  })

  it.each([true, false])('honors a key stored in auth.json (Prime CLI credentials %s)', async (primeCliCredentials) => {
    const { agentDir } = primeCliHome()
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({ 'prime-inference': { type: 'api_key', key: 'stored-test-key' } }))
    const { provider, offered } = await primeInference(new PrimeProviderService({ primeCliCredentials }))
    // TypeScript Prime prefers the CLI login over auth.json; Rust Prime reads auth.json only.
    expect(provider?.authSource).toBe(primeCliCredentials ? 'prime_cli' : 'stored')
    expect(offered).toBeGreaterThan(0)
  })
})
