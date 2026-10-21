import { randomUUID } from 'node:crypto'
import { AuthStorage } from 'prime-agent/auth-storage'
import { VERSION } from 'prime-agent/config'
import { ModelRegistry } from 'prime-agent/model-registry'
import { getSupportedThinkingLevels, supportsFastMode } from 'prime-agent-ai'
import { BUILTIN_MCP_CATALOG } from 'prime-agent-ai/mcp'
import type { Api, Model } from 'prime-agent-ai'
import type { OAuthLoginCallbacks } from 'prime-agent-ai/oauth'
import type { PrimeImplementation, PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor, ProviderAuthEvent, ProviderAuthMethod, ProviderAuthSource, SkillRecord } from '../../src/types/api'
import { NETWORK_MCP_AUTH_UNAVAILABLE, NETWORK_MCP_UNAVAILABLE_DETAIL } from '../../src/lib/mcp-policy'
import type { CliModelCatalogOptions } from './model-catalog-cli'
import { catalogLimitWarnings, limitCatalogRelations } from './model-catalog'
import { withModelVisibility } from './model-visibility'
import type { ExecutableSource } from './process-utils'
import { RustPrimeModelCatalogService } from './providers-prime-rust'
import { requireString, requireWebUrl } from './validation'

const CATALOG_TTL_MS = 30_000
export { MAX_CATALOG_PROVIDERS } from './model-catalog'
const EXTERNAL_AUTH_PROVIDERS = new Set(['amazon-bedrock', 'google-vertex'])
const OAUTH_TIMEOUT_MS = 10 * 60_000
interface PendingOAuthPrompt {
  id: string
  options?: Set<string>
  allowEmpty: boolean
  resolve(value: string | undefined): void
  reject(error: Error): void
}

interface OAuthFlow {
  id: string
  providerId: string
  abort: AbortController
  timer: NodeJS.Timeout
  pending?: PendingOAuthPrompt
}

type WithoutFlow<T> = T extends ProviderAuthEvent ? Omit<T, 'flowId' | 'providerId'> : never
type ProviderAuthEventPayload = WithoutFlow<ProviderAuthEvent>

function modelKey(provider: string, id: string): string { return `${provider}/${id}` }

function safeModelId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9._:/+-]+$/.test(value)
}

function safeProviderId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)
}

function isMcpAuthProvider(providerId: string): boolean {
  return providerId.toLowerCase().startsWith('mcp:')
}

/**
 * ModelRegistry also registers MCP OAuth providers in its process-global
 * registry. Give it a deliberately incomplete credential view so model
 * discovery cannot inspect or mutate a shared `mcp:*` credential.
 */
function modelRegistryAuthStorage(authStorage: AuthStorage): AuthStorage {
  return {
    reload: () => authStorage.reload(),
    getOAuthProviders: () => authStorage.getOAuthProviders().filter((provider) => !isMcpAuthProvider(provider.id)),
    get: (provider: string) => isMcpAuthProvider(provider) ? undefined : authStorage.get(provider),
    hasAuth: (provider: string) => !isMcpAuthProvider(provider) && authStorage.hasAuth(provider),
    getAuthStatus: (provider: string) => isMcpAuthProvider(provider) ? { configured: false } : authStorage.getAuthStatus(provider),
    getApiKey: async (provider: string, options?: Parameters<AuthStorage['getApiKey']>[1]) => isMcpAuthProvider(provider) ? undefined : authStorage.getApiKey(provider, options),
    getApiKeyWithSourceToken: async (provider: string, options?: Parameters<AuthStorage['getApiKeyWithSourceToken']>[1]) => isMcpAuthProvider(provider) ? {} : authStorage.getApiKeyWithSourceToken(provider, options),
    getProviderHeaders: (provider: string) => isMcpAuthProvider(provider) ? undefined : authStorage.getProviderHeaders(provider),
    markAuthStale: (provider: string) => !isMcpAuthProvider(provider) && authStorage.markAuthStale(provider),
    getCurrentAuthSourceToken: (provider: string) => isMcpAuthProvider(provider) ? undefined : authStorage.getCurrentAuthSourceToken(provider),
    markAuthSourceStale: (token: Parameters<AuthStorage['markAuthSourceStale']>[0]) => !isMcpAuthProvider(token.provider) && authStorage.markAuthSourceStale(token),
  } as unknown as AuthStorage
}

/** The distinct provider ids a catalog may list: well formed, and never an MCP credential. */
function listableProviderIds(providerIds: Iterable<string>): string[] {
  return [...new Set(providerIds)].filter((id) => safeProviderId(id) && !isMcpAuthProvider(id))
}

type ProviderAuthStatus = ReturnType<ModelRegistry['getProviderAuthStatus']>

interface ProviderContext {
  primeCliCredentials: boolean
  authStorage: AuthStorage
  registry: ModelRegistry
}

function boundedInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function resolveAvailableModelKeys(
  models: ReadonlyArray<{ provider: string; id: string }>,
  executableModels: ReadonlyArray<{ provider: string; id: string }>,
  configuredProviders: ReadonlySet<string>,
): { keys: Set<string>; fallbackProviders: string[] } {
  const keys = new Set(executableModels.map((model) => modelKey(model.provider, model.id)))
  const fallbackProviders: string[] = []
  // Codex subscription discovery is an optional entitlement refinement, not the
  // runtime's source of truth. A configured Prime Agent account can still execute
  // its built-in catalogue when that network result is empty or partial.
  if (configuredProviders.has('openai-codex')) {
    const missingConfiguredModel = models.some((model) => model.provider === 'openai-codex' && !keys.has(modelKey(model.provider, model.id)))
    if (missingConfiguredModel) fallbackProviders.push('openai-codex')
    for (const model of models) if (model.provider === 'openai-codex') keys.add(modelKey(model.provider, model.id))
  }
  return { keys, fallbackProviders }
}

function toModelDescriptor(model: Model<Api>, available: Set<string>): PrimeModelDescriptor {
  return {
    key: modelKey(model.provider, model.id),
    provider: model.provider,
    id: model.id,
    name: model.name.slice(0, 500),
    reasoning: model.reasoning,
    input: model.input.filter((input): input is 'text' | 'image' => input === 'text' || input === 'image'),
    contextWindow: boundedInteger(model.contextWindow),
    maxTokens: boundedInteger(model.maxTokens),
    availableThinkingLevels: getSupportedThinkingLevels(model),
    fastModeSupported: supportsFastMode(model),
    available: available.has(modelKey(model.provider, model.id)),
  }
}

export interface PrimeProviderServiceOptions {
  authPath?: string
  modelsPath?: string
  /** The discovered prime-agent, which Rust Prime's model catalog is read from. */
  executable?: ExecutableSource
  /** The discovered Prime build, read on every catalog request; undefined keeps the TypeScript path. */
  implementation?: () => PrimeImplementation | undefined
  /**
   * Counts the separate Prime CLI login in ~/.prime/config.json as Prime
   * Inference auth, as TypeScript Prime does at runtime. Rust Prime only
   * reads auth.json, so for it the CLI key would show models that fail to
   * start, and a logout would rewrite another tool's file. Defaults to
   * whether the discovered build is TypeScript, including after a refresh.
   */
  primeCliCredentials?: boolean
  /** Probe limits for Rust Prime's model catalog. */
  rustProbe?: CliModelCatalogOptions
  openExternal?: (url: string) => Promise<void>
}

export class PrimeProviderService {
  private context: ProviderContext
  private readonly implementation: () => PrimeImplementation | undefined
  private readonly rustModels: RustPrimeModelCatalogService
  private cachedCatalog: PrimeModelCatalog | null = null
  private cachedAt = 0
  private catalogGeneration = 0
  private catalogRefresh: Promise<PrimeModelCatalog> | null = null
  private readonly flows = new Map<string, OAuthFlow>()
  private eventSink: (event: ProviderAuthEvent) => void = () => undefined
  private readonly openExternal: (url: string) => Promise<void>

  constructor(private readonly options: PrimeProviderServiceOptions = {}) {
    this.implementation = options.implementation ?? (() => undefined)
    this.context = this.createContext(this.usesPrimeCliCredentials())
    this.rustModels = new RustPrimeModelCatalogService(options.executable ?? null, (modelProviders) => this.rustProviderDescriptors(modelProviders), options.rustProbe)
    this.openExternal = options.openExternal ?? (async () => undefined)
  }

  private usesPrimeCliCredentials(): boolean {
    return this.options.authPath === undefined && (this.options.primeCliCredentials ?? this.implementation() !== 'rust')
  }

  private createContext(primeCliCredentials: boolean): ProviderContext {
    const authStorage = AuthStorage.create(this.options.authPath, { usePrimeCliConfig: primeCliCredentials })
    return { primeCliCredentials, authStorage, registry: ModelRegistry.create(modelRegistryAuthStorage(authStorage), this.options.modelsPath) }
  }

  private currentContext(): ProviderContext {
    const primeCliCredentials = this.usesPrimeCliCredentials()
    if (this.context.primeCliCredentials !== primeCliCredentials) {
      this.context = this.createContext(primeCliCredentials)
      this.invalidate()
    }
    return this.context
  }

  private get authStorage(): AuthStorage { return this.currentContext().authStorage }
  private get registry(): ModelRegistry { return this.currentContext().registry }

  setEventSink(sink: (event: ProviderAuthEvent) => void): void { this.eventSink = sink }

  mcpCapabilities(): SkillRecord[] {
    return BUILTIN_MCP_CATALOG.map((integration) => ({
      id: `prime-mcp-${integration.server}`,
      name: integration.label,
      description: `Network MCP integration at ${new URL(integration.url).origin}. Configuration and authorization are managed directly in Prime Agent.`,
      kind: 'mcp',
      location: 'bundled',
      enabled: false,
      source: new URL(integration.url).origin,
      availability: { available: false, detail: NETWORK_MCP_UNAVAILABLE_DETAIL },
    }))
  }

  async catalog(force = false, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelCatalog> {
    this.currentContext()
    if (this.implementation() === 'rust') return this.rustCatalog(force, disabledProviders, disabledModels)
    if (force) this.invalidate()
    if (!force && this.cachedCatalog && Date.now() - this.cachedAt < CATALOG_TTL_MS) {
      return withModelVisibility(this.cachedCatalog, disabledProviders, disabledModels)
    }
    // Single-flight: concurrent callers share one refresh instead of racing
    // duplicate registry work; the in-flight promise is cleared in finally.
    if (!this.catalogRefresh) {
      const refresh = this.refreshCatalog(this.catalogGeneration).finally(() => {
        if (this.catalogRefresh === refresh) this.catalogRefresh = null
      })
      this.catalogRefresh = refresh
    }
    return withModelVisibility(await this.catalogRefresh, disabledProviders, disabledModels)
  }

  private async refreshCatalog(generation: number): Promise<PrimeModelCatalog> {
    const context = this.currentContext()
    const { registry } = context
    const snapshot = await registry.refreshModelCatalog()
    let executableModels: Model<Api>[] = []
    let executableDiscoveryWarning: string | undefined
    try { executableModels = await registry.getExecutableModels() }
    catch { executableDiscoveryWarning = 'Executable model discovery failed; availability may be incomplete.' }
    const oauthProviders = new Map(registry.authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]))
    const eligibleModels = snapshot.models.filter((model) => safeProviderId(model.provider) && safeModelId(model.id))
    const validProviderIds = listableProviderIds([...eligibleModels.map((model) => model.provider), ...oauthProviders.keys()])
    const authStatuses = new Map(validProviderIds.map((id) => [id, registry.getProviderAuthStatus(id)]))
    const configuredProviders = new Set([...authStatuses].filter(([, status]) => status.configured).map(([id]) => id))
    const { keys: available, fallbackProviders } = resolveAvailableModelKeys(eligibleModels, executableModels, configuredProviders)
    const relation = limitCatalogRelations(
      eligibleModels.map((model) => toModelDescriptor(model, available)),
      validProviderIds.map((id) => this.providerDescriptor(id, authStatuses.get(id) ?? registry.getProviderAuthStatus(id), oauthProviders)),
    )

    const warnings = [
      ...catalogLimitWarnings('Prime Agent', relation, { uniqueModels: true }),
      snapshot.models.length > eligibleModels.length
        ? `Prime Agent returned ${(snapshot.models.length - eligibleModels.length).toLocaleString('en-US')} model entries GooeyPi could not validate; they were skipped.`
        : undefined,
      fallbackProviders.includes('openai-codex') && relation.models.some((model) => model.provider === 'openai-codex')
        ? 'ChatGPT subscription model discovery was unavailable or incomplete; GooeyPi is showing Prime Agent’s configured Codex catalogue.'
        : undefined,
      executableDiscoveryWarning,
      registry.getError()?.slice(0, 4_000),
    ].filter((warning): warning is string => Boolean(warning))

    const catalog: PrimeModelCatalog = {
      primeVersion: VERSION,
      refreshedAt: new Date().toISOString(),
      models: relation.models,
      providers: relation.providers,
      warning: warnings.length ? warnings.join(' ') : undefined,
    }
    if (this.currentContext() === context && this.catalogGeneration === generation) {
      this.cachedCatalog = catalog
      this.cachedAt = Date.now()
    }
    return catalog
  }

  /**
   * Rust Prime's catalog comes from its own RPC probe, never from the bundled
   * TypeScript registry's model refresh: that would list 0.7's models and
   * rewrite Rust's prime-inference-private-models.json in TypeScript's
   * format. Until a probe has answered once, a failing probe still yields the
   * provider rows, so credentials can be added, with the failure as the
   * warning. Later failures keep the last loaded catalog.
   */
  private async rustCatalog(force: boolean, disabledProviders: ReadonlySet<string>, disabledModels: ReadonlySet<string>): Promise<PrimeModelCatalog> {
    try {
      return await this.rustModels.catalog(force, disabledProviders, disabledModels)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return withModelVisibility({
        primeVersion: 'unknown',
        refreshedAt: new Date().toISOString(),
        models: [],
        providers: limitCatalogRelations([], this.rustProviderDescriptors(new Set())).providers,
        warning: `The Prime Agent model catalog could not be loaded (${reason.slice(0, 4_000)}).`,
      }, disabledProviders, disabledModels)
    }
  }

  /**
   * Provider rows for Rust Prime's catalog. Auth state still comes from the
   * shared auth.json and models.json through the in-process store, which is
   * reloaded here without the registry's network refresh. Providers without
   * Rust models are listed too, so a key can be added. Rust lists models
   * only for providers it has credentials for, so such a provider is
   * configured even when the store cannot see the credential, such as an
   * environment source only Rust reads.
   */
  private rustProviderDescriptors(modelProviders: ReadonlySet<string>): PrimeProviderDescriptor[] {
    this.registry.refresh()
    const oauthProviders = this.oauthProviderNames()
    const providerIds = listableProviderIds([...modelProviders, ...this.registry.getAll().map((model) => model.provider), ...oauthProviders.keys()])
    return providerIds.map((id) => {
      const authStatus = this.registry.getProviderAuthStatus(id)
      return this.providerDescriptor(id, authStatus.configured || !modelProviders.has(id) ? authStatus : { configured: true }, oauthProviders)
    })
  }

  /** Display names of the providers that sign in through an OAuth flow. */
  private oauthProviderNames(): Map<string, string> {
    return new Map(this.registry.authStorage.getOAuthProviders().map((provider) => [provider.id, provider.name]))
  }

  /** One provider row, as GooeyPi's Prime auth store sees the provider. */
  private providerDescriptor(id: string, authStatus: ProviderAuthStatus, oauthProviders: ReadonlyMap<string, string>): PrimeProviderDescriptor {
    const authMethod: ProviderAuthMethod = oauthProviders.has(id) ? 'oauth' : EXTERNAL_AUTH_PROVIDERS.has(id) ? 'external' : 'api_key'
    return {
      id,
      name: (oauthProviders.get(id) ?? this.registry.getProviderDisplayName(id)).slice(0, 200),
      authMethod,
      configured: authStatus.configured,
      authSource: authStatus.source as ProviderAuthSource | undefined,
      authLabel: authStatus.label?.slice(0, 200),
      modelCount: 0,
      availableModelCount: 0,
      enabled: true,
    }
  }

  async requireAvailableModel(rawKey: unknown, disabledProviders: ReadonlySet<string> = new Set(), disabledModels: ReadonlySet<string> = new Set()): Promise<PrimeModelDescriptor> {
    const key = requireString(rawKey, 'model', { min: 3, max: 512, trim: true })
    const catalog = await this.catalog(false, disabledProviders, disabledModels)
    const model = catalog.models.find((candidate) => candidate.key === key)
    if (!model) throw new Error('Model was not found in the Prime Agent catalog')
    const provider = catalog.providers.find((candidate) => candidate.id === model.provider)
    if (!provider?.enabled) throw new Error(`Provider ${model.provider} is disabled in GooeyPi`)
    if (model.enabled === false) throw new Error(`${model.name} is disabled in GooeyPi`)
    if (!model.available) throw new Error(`Provider ${model.provider} is not configured for ${model.name}`)
    return model
  }

  async capabilities(provider: string | undefined, modelId: string | undefined): Promise<PrimeModelDescriptor | undefined> {
    if (!provider || !modelId) return undefined
    return (await this.catalog()).models.find((model) => model.provider === provider && model.id === modelId)
  }

  async saveApiKey(rawProviderId: unknown, rawKey: unknown): Promise<void> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    if (isMcpAuthProvider(providerId)) throw new Error(NETWORK_MCP_AUTH_UNAVAILABLE)
    const key = requireString(rawKey, 'apiKey', { min: 1, max: 16_384, trim: true })
    await this.requireProvider(providerId, 'api_key')
    this.authStorage.set(providerId, { type: 'api_key', key })
    this.invalidate()
  }

  async logout(rawProviderId: unknown): Promise<void> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    if (isMcpAuthProvider(providerId)) throw new Error(NETWORK_MCP_AUTH_UNAVAILABLE)
    await this.requireProvider(providerId)
    this.authStorage.logout(providerId)
    this.invalidate()
  }

  async startOAuth(rawProviderId: unknown): Promise<{ flowId: string }> {
    const providerId = requireString(rawProviderId, 'providerId', { min: 1, max: 128, trim: true })
    if (isMcpAuthProvider(providerId)) throw new Error(NETWORK_MCP_AUTH_UNAVAILABLE)
    await this.requireProvider(providerId, 'oauth')
    return this.startOAuthFlow(providerId)
  }

  private startOAuthFlow(providerId: string): { flowId: string } {
    if (this.flows.size >= 2) throw new Error('Too many provider login flows are active')
    if ([...this.flows.values()].some((flow) => flow.providerId === providerId)) throw new Error('This provider login is already active')
    const id = randomUUID()
    const abort = new AbortController()
    const timer = setTimeout(() => {
      const active = this.flows.get(id)
      if (active) this.abortFlow(active, 'Provider login timed out')
    }, OAUTH_TIMEOUT_MS)
    timer.unref()
    const flow: OAuthFlow = { id, providerId, abort, timer }
    this.flows.set(id, flow)
    void this.runOAuth(flow)
    return { flowId: id }
  }

  respondOAuth(rawFlowId: unknown, rawPromptId: unknown, rawValue: unknown): boolean {
    const flowId = requireString(rawFlowId, 'flowId', { min: 1, max: 128 })
    const promptId = requireString(rawPromptId, 'promptId', { min: 1, max: 128 })
    const flow = this.flows.get(flowId)
    const pending = flow?.pending
    if (!flow || !pending || pending.id !== promptId) return false
    const value = rawValue === undefined ? undefined : requireString(rawValue, 'value', { max: 16_384 })
    if (!pending.allowEmpty && !value?.trim()) throw new TypeError('A response is required')
    if (pending.options && (!value || !pending.options.has(value))) throw new TypeError('Invalid provider login selection')
    flow.pending = undefined
    pending.resolve(value)
    return true
  }

  cancelOAuth(rawFlowId: unknown): boolean {
    const flowId = requireString(rawFlowId, 'flowId', { min: 1, max: 128 })
    const flow = this.flows.get(flowId)
    if (!flow) return false
    this.abortFlow(flow, 'Provider login cancelled')
    return true
  }

  cancelAll(): void { for (const flow of this.flows.values()) this.cancelOAuth(flow.id) }

  invalidate(): void {
    this.catalogGeneration += 1
    this.cachedCatalog = null
    this.cachedAt = 0
    this.catalogRefresh = null
    this.rustModels.invalidate()
  }

  private async requireProvider(providerId: string, expectedMethod?: ProviderAuthMethod): Promise<PrimeProviderDescriptor> {
    const provider = (await this.catalog()).providers.find((candidate) => candidate.id === providerId)
    if (!provider) throw new Error('Provider was not found')
    if (expectedMethod && provider.authMethod !== expectedMethod) throw new Error(`Provider requires ${provider.authMethod} authentication`)
    return provider
  }

  private async runOAuth(flow: OAuthFlow): Promise<void> {
    const live = () => this.flows.get(flow.id) === flow && !flow.abort.signal.aborted
    try {
      const callbacks: OAuthLoginCallbacks = {
        signal: flow.abort.signal,
        onAuth: (info) => {
          if (!live()) return
          const url = requireWebUrl(info.url)
          this.emit(flow, { type: 'auth', url, instructions: info.instructions?.slice(0, 4_000) })
          if (live()) void this.openExternal(url).catch((error) => { if (live()) this.emit(flow, { type: 'error', error: this.errorMessage(error) }) })
        },
        onProgress: (message) => { if (live()) this.emit(flow, { type: 'progress', message: message.slice(0, 4_000) }) },
        onPrompt: (prompt) => this.requestOAuthValue(flow, {
          type: 'prompt',
          message: prompt.message.slice(0, 4_000),
          placeholder: prompt.placeholder?.slice(0, 500),
          allowEmpty: prompt.allowEmpty === true,
        }).then((value) => value ?? ''),
        onManualCodeInput: () => this.requestOAuthValue(flow, {
          type: 'prompt',
          message: 'Paste the authorization code from your browser.',
          placeholder: 'Authorization code',
          allowEmpty: false,
        }).then((value) => value ?? ''),
        onSelect: (prompt) => this.requestOAuthValue(flow, {
          type: 'select',
          message: prompt.message.slice(0, 4_000),
          options: prompt.options.slice(0, 100).map((option) => ({ id: option.id.slice(0, 500), label: option.label.slice(0, 500) })),
        }),
      }
      await this.authStorage.login(flow.providerId, callbacks)
      if (!live()) return
      this.invalidate()
      this.emit(flow, { type: 'complete' })
    } catch (error) {
      if (live()) this.emit(flow, { type: 'error', error: this.errorMessage(error) })
    } finally {
      clearTimeout(flow.timer)
      flow.pending?.reject(new Error('Provider login ended'))
      this.flows.delete(flow.id)
    }
  }

  private abortFlow(flow: OAuthFlow, message: string): void {
    const error = new Error(message)
    // Release the flow slot immediately so cancel -> retry always works, even
    // when the underlying login ignores the abort signal and never settles.
    clearTimeout(flow.timer)
    this.emit(flow, { type: 'cancelled' })
    this.flows.delete(flow.id)
    flow.abort.abort(error)
    flow.pending?.reject(error)
    flow.pending = undefined
  }

  private requestOAuthValue(
    flow: OAuthFlow,
    request: { type: 'prompt'; message: string; placeholder?: string; allowEmpty: boolean }
      | { type: 'select'; message: string; options: Array<{ id: string; label: string }> },
  ): Promise<string | undefined> {
    if (flow.abort.signal.aborted) return Promise.reject(new Error('Provider login cancelled'))
    if (flow.pending) return Promise.reject(new Error('Provider login requested overlapping input'))
    const promptId = randomUUID()
    return new Promise((resolve, reject) => {
      flow.pending = {
        id: promptId,
        allowEmpty: request.type === 'prompt' && request.allowEmpty,
        options: request.type === 'select' ? new Set(request.options.map((option) => option.id)) : undefined,
        resolve,
        reject,
      }
      this.emit(flow, { ...request, promptId })
    })
  }

  private emit(flow: OAuthFlow, event: ProviderAuthEventPayload): void {
    this.eventSink({ flowId: flow.id, providerId: flow.providerId, ...event } as ProviderAuthEvent)
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ').slice(0, 4_000) || 'Provider login failed'
  }
}
