import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_CATALOG_PROVIDERS, PrimeProviderService, resolveAvailableModelKeys, resolveMcpOAuthDiscovery } from '../../electron/main/providers'
import type { PrimeModelCatalog } from '../../src/types/api'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
  it('follows MCP protected-resource metadata to its OAuth server and scopes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_request", resource_metadata="https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp?read_only=true"' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_servers: ['https://api.supabase.com'],
        scopes_supported: ['organizations:read', 'projects:read', 'database:read'],
      }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpOAuthDiscovery('https://mcp.supabase.com/mcp?read_only=true')).resolves.toEqual({
      url: 'https://api.supabase.com/',
      scopes: 'organizations:read projects:read database:read',
    })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://mcp.supabase.com/mcp?read_only=true', expect.objectContaining({ method: 'GET' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp?read_only=true', expect.objectContaining({ method: 'GET' }))
  })

  it('ignores MCP protected-resource metadata advertised on another origin', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', {
      status: 401,
      headers: { 'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1:9000/.well-known/oauth-protected-resource"' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpOAuthDiscovery('https://mcp.example.com/mcp')).resolves.toEqual({
      url: 'https://mcp.example.com/mcp',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

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

  it('rejects OAuth for providers that do not own an OAuth flow', async () => {
    await expect(service().startOAuth('openai')).rejects.toThrow('requires api_key authentication')
  })

  it('starts built-in MCP OAuth through Prime Agent credential storage', async () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { login(providerId: string, options: unknown): Promise<void> }
    }
    const login = vi.fn(async () => undefined)
    internals.authStorage.login = login

    const flow = await providerService.startMcpOAuth('notion')
    expect(flow.flowId).toBeTruthy()
    expect(login).toHaveBeenCalledWith('mcp:notion', expect.any(Object))
  })

  it('surfaces built-in MCP connection state without exposing credentials', () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { set(providerId: string, credential: unknown): void }
    }
    expect(providerService.mcpCapabilities()).toContainEqual(expect.objectContaining({ name: 'Notion', kind: 'mcp', location: 'bundled', enabled: false }))
    internals.authStorage.set('mcp:notion', { type: 'oauth', access: 'secret-token', refresh: 'refresh-token', expires: Date.now() + 60_000 })
    const capabilities = providerService.mcpCapabilities()
    expect(capabilities).toContainEqual(expect.objectContaining({ id: 'prime-mcp-notion', name: 'Notion', enabled: true }))
    expect(JSON.stringify(capabilities)).not.toContain('secret-token')
  })

  it('logs out only the selected built-in MCP integration', async () => {
    const providerService = service()
    const internals = providerService as unknown as {
      authStorage: { set(providerId: string, credential: unknown): void; get(providerId: string): unknown }
    }
    internals.authStorage.set('mcp:notion', { type: 'oauth', access: 'notion-secret' })
    internals.authStorage.set('openai-codex', { type: 'oauth', access: 'provider-secret' })

    await providerService.logoutMcp('notion')

    expect(internals.authStorage.get('mcp:notion')).toBeUndefined()
    expect(internals.authStorage.get('openai-codex')).toBeDefined()
  })

  it('registers a configured custom Prime MCP OAuth server before login', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-mcp-provider-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      mcpServers: { acme: { type: 'http', url: 'https://acme.example/mcp', oauth: true } },
    }))
    const providerService = new PrimeProviderService({
      agentDir: dir,
      authPath: join(dir, 'auth.json'),
      modelsPath: join(dir, 'models.json'),
    })
    const internals = providerService as unknown as {
      startOAuthFlow(providerId: string): { flowId: string }
    }
    const startOAuthFlow = vi.fn(() => ({ flowId: 'custom-mcp-flow' }))
    internals.startOAuthFlow = startOAuthFlow

    await expect(providerService.startMcpOAuth('acme')).resolves.toEqual({ flowId: 'custom-mcp-flow' })
    expect(startOAuthFlow).toHaveBeenCalledWith('mcp:acme')
  })

  it('rejects unknown and non-OAuth MCP login targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-mcp-provider-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      mcpServers: { local: { type: 'http', url: 'https://local.example/mcp', enabled: true } },
    }))
    const providerService = new PrimeProviderService({
      agentDir: dir,
      authPath: join(dir, 'auth.json'),
      modelsPath: join(dir, 'models.json'),
    })

    await expect(providerService.startMcpOAuth('missing')).rejects.toThrow('Unknown MCP integration')
    await expect(providerService.startMcpOAuth('local')).rejects.toThrow('not configured for OAuth')
    await expect(providerService.startMcpOAuth('../notion')).rejects.toThrow('unsupported characters')
  })
})
