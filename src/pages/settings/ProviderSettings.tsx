import { ChevronRight, ExternalLink, Gauge, KeyRound, LogIn, LogOut, RefreshCw, Search, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { HarnessId, PrimeImplementation, PrimeModelCatalog, PrimeModelDescriptor, PrimeProviderDescriptor } from '@/types/api'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { RUST_PRIME_AGENT_NAME } from '@/lib/prime-compat'
import { Modal } from '@/components/ui'

interface ProviderSettingsProps {
  /** Active harness. OMP and Pi credentials stay CLI-owned; visibility toggles only affect GooeyPi. */
  harness?: HarnessId
  catalog: PrimeModelCatalog | null
  onRefresh(): Promise<void>
  onSaveApiKey(providerId: string, apiKey: string): Promise<void>
  onLogout(providerId: string): Promise<void>
  onSetEnabled(providerId: string, enabled: boolean): Promise<void>
  onSetAllEnabled(): Promise<void>
  onSetAllDisabled(): Promise<void>
  onSetModelEnabled(modelKey: string, enabled: boolean): Promise<void>
  onStartOAuth(providerId: string): Promise<void>
  onOpenDocs(): void
}

function authDescription(provider: PrimeProviderDescriptor): string {
  if (!provider.configured) return provider.authMethod === 'external' ? 'Uses credentials configured outside GooeyPi' : 'Not connected'
  const source = provider.authSource === 'environment' ? provider.authLabel ? `Environment · ${provider.authLabel}` : 'Environment'
    : provider.authSource === 'prime_cli' ? 'Prime CLI account'
      : provider.authSource === 'models_json_key' || provider.authSource === 'models_json_command' ? 'models.json'
        : provider.authSource === 'stored' ? provider.authMethod === 'oauth' ? 'Connected account' : 'Stored API key'
          : provider.authSource ?? 'Configured'
  return `${source} · ${provider.availableModelCount.toLocaleString()} available models`
}

function activeFirst<T extends { enabled?: boolean }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => Number(right.enabled !== false) - Number(left.enabled !== false))
}

export function ProviderSettings({ harness = 'prime', catalog, onRefresh, onSaveApiKey, onLogout, onSetEnabled, onSetAllEnabled, onSetAllDisabled, onSetModelEnabled, onStartOAuth, onOpenDocs }: ProviderSettingsProps) {
  // OMP and Pi own their credentials in their CLIs; GooeyPi only toggles visibility.
  const externalAuth = harness !== 'prime'
  const agentName = HARNESS_AGENT_NAMES[harness]
  const [view, setView] = useState<'providers' | 'models'>('providers')
  const [query, setQuery] = useState('')
  const [apiKeyProvider, setApiKeyProvider] = useState<PrimeProviderDescriptor | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [collapsedModelProviders, setCollapsedModelProviders] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState('')
  const [apiKeyError, setApiKeyError] = useState('')
  const providers = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const matches = normalized
      ? (catalog?.providers ?? []).filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(normalized))
      : catalog?.providers ?? []
    return activeFirst(matches)
  }, [catalog, query])
  const providerNames = useMemo(() => new Map((catalog?.providers ?? []).map((provider) => [provider.id, provider.name])), [catalog])
  const modelGroups = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const matches = normalized
      ? (catalog?.models ?? []).filter((model) => `${model.name} ${model.id} ${model.provider} ${providerNames.get(model.provider) ?? ''}`.toLowerCase().includes(normalized))
      : catalog?.models ?? []
    const byProvider = new Map<string, PrimeModelDescriptor[]>()
    for (const model of matches) {
      const models = byProvider.get(model.provider)
      if (models) models.push(model)
      else byProvider.set(model.provider, [model])
    }
    const orderedProviders = activeFirst(catalog?.providers ?? [])
    const groups = orderedProviders.flatMap((provider) => {
      const models = byProvider.get(provider.id)
      if (!models?.length) return []
      byProvider.delete(provider.id)
      return [{ provider, models: activeFirst(models) }]
    })
    for (const [providerId, models] of byProvider) {
      groups.push({
        provider: { id: providerId, name: providerNames.get(providerId) ?? providerId, authMethod: 'external', configured: false, modelCount: models.length, availableModelCount: 0, enabled: models.some((model) => model.enabled !== false) },
        models: activeFirst(models),
      })
    }
    return groups
  }, [catalog, providerNames, query])

  const run = async (providerId: string, action: () => Promise<void>) => {
    setBusyProvider(providerId); setError('')
    try { await action() } catch (failure) { setError(errorMessage(failure)) } finally { setBusyProvider(null) }
  }

  const saveApiKey = async () => {
    const provider = apiKeyProvider
    if (!provider || !apiKey.trim()) return
    setBusyProvider(provider.id)
    setApiKeyError('')
    try {
      await onSaveApiKey(provider.id, apiKey)
      setApiKey('')
      setApiKeyProvider(null)
    } catch (failure) {
      setApiKeyError(errorMessage(failure))
    } finally {
      setBusyProvider(null)
    }
  }

  const closeApiKey = () => { setApiKey(''); setApiKeyError(''); setApiKeyProvider(null) }
  const toggleModelProvider = (providerId: string) => setCollapsedModelProviders((current) => {
    const next = new Set(current)
    if (next.has(providerId)) next.delete(providerId)
    else next.add(providerId)
    return next
  })
  const enableAll = () => run('enable-all', onSetAllEnabled)
  const disableAll = () => run('disable-all', onSetAllDisabled)

  const providerCount = catalog?.providers.length ?? 0
  const modelCount = catalog?.models.length ?? 0
  const availableModelCount = catalog?.models.filter((model) => model.available && model.enabled !== false).length ?? 0
  const disabledCount = catalog?.providers.filter((provider) => !provider.enabled).length ?? 0

  return (
    <section className="settings-group provider-settings">
      <div className="settings-group__heading"><h2>{agentName} catalogue</h2><div className="provider-heading-actions">{catalog && disabledCount < providerCount ? <button type="button" className="button button--danger" disabled={Boolean(busyProvider)} onClick={() => void disableAll()}>{externalAuth ? 'Hide all' : 'Disable all'}</button> : null}{disabledCount ? <button type="button" className="button" disabled={Boolean(busyProvider)} onClick={() => void enableAll()}>{externalAuth ? 'Show all' : 'Enable all'}</button> : null}<button type="button" className="button button--icon" aria-label="Refresh providers" disabled={Boolean(busyProvider)} onClick={() => void run('refresh', onRefresh)}><RefreshCw size={13} /></button></div></div>
      <div className="provider-catalog-summary"><strong>{catalog ? `${providerCount.toLocaleString()} providers · ${modelCount.toLocaleString()} models` : 'Loading provider catalogue…'}</strong>{catalog ? <small>{externalAuth ? `${availableModelCount.toLocaleString()} models are shown in GooeyPi; ${agentName} checks credentials when you launch one` : `${availableModelCount.toLocaleString()} models are available with your current ${agentName} credentials`}</small> : null}</div>
      {catalog?.warning ? <p className="provider-catalog-warning" role="status">{catalog.warning}</p> : null}
      <div className="provider-catalog-tabs" role="tablist" aria-label="Provider catalogue view">
        <button type="button" role="tab" aria-selected={view === 'providers'} className={view === 'providers' ? 'is-active' : ''} onClick={() => { setView('providers'); setQuery('') }}>Providers <span>{providerCount.toLocaleString()}</span></button>
        <button type="button" role="tab" aria-selected={view === 'models'} className={view === 'models' ? 'is-active' : ''} onClick={() => { setView('models'); setQuery('') }}>Models <span>{modelCount.toLocaleString()}</span></button>
      </div>
      <label className="provider-search"><Search size={13} /><input value={query} placeholder={view === 'providers' ? 'Search providers' : 'Search models'} aria-label={view === 'providers' ? 'Search providers' : 'Search models'} onChange={(event) => setQuery(event.target.value)} /></label>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {view === 'providers' ? <div className="provider-list">
        {providers.map((provider) => {
          const busy = busyProvider === provider.id
          return <div className="provider-row" key={provider.id}>
            <label className="provider-row__toggle" title={provider.enabled ? `Hide provider in ${agentName}` : `Show provider in ${agentName}`}><input type="checkbox" aria-label={`Show ${provider.name} provider`} checked={provider.enabled} disabled={busy} onChange={(event) => void run(provider.id, () => onSetEnabled(provider.id, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
            <div className="provider-row__identity"><strong>{provider.name}</strong><small>{externalAuth ? `${provider.authLabel ?? `Credentials managed by the ${harness} CLI`} · ${provider.availableModelCount.toLocaleString()} models` : authDescription(provider)}</small></div>
            {externalAuth ? <div className="provider-row__actions"><button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Credential setup</button></div> : <div className="provider-row__actions">
              {provider.authMethod === 'oauth' ? <button type="button" className="button" disabled={busy} onClick={() => void run(provider.id, () => onStartOAuth(provider.id))}><LogIn size={13} /> {provider.configured ? 'Reconnect' : 'Connect'}</button> : null}
              {provider.authMethod === 'api_key' ? <button type="button" className="button" disabled={busy} onClick={() => { setError(''); setApiKeyError(''); setApiKey(''); setApiKeyProvider(provider) }}><KeyRound size={13} /> {provider.configured ? 'Replace key' : 'Add key'}</button> : null}
              {provider.authMethod === 'external' ? <button type="button" className="button" onClick={onOpenDocs}><ExternalLink size={13} /> Setup</button> : null}
              {provider.configured && provider.authSource === 'stored' ? <button type="button" className="button button--icon" aria-label={`Log out of ${provider.name}`} disabled={busy} onClick={() => void run(provider.id, () => onLogout(provider.id))}><LogOut size={13} /></button> : null}
            </div>}
          </div>
        })}
      </div> : <div className="provider-list provider-model-list">
        {modelGroups.map(({ provider, models }) => {
          const collapsed = collapsedModelProviders.has(provider.id)
          const contentId = `provider-models-${provider.id.replace(/[^a-z0-9_-]/gi, '-')}`
          return <div className={`provider-model-group${provider.enabled ? '' : ' is-disabled'}${collapsed ? ' is-collapsed' : ''}`} key={provider.id}>
          <button type="button" className="provider-model-group__heading" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => toggleModelProvider(provider.id)}><strong>{provider.name}</strong><small>{models.filter((model) => model.enabled !== false).length.toLocaleString()} of {models.length.toLocaleString()} on</small><ChevronRight className="provider-model-group__chevron" size={13} aria-hidden="true" /></button>
          <div id={contentId} className="provider-model-group__models" hidden={collapsed}>{models.map((model) => <div className={`provider-model-row${model.enabled === false ? ' is-disabled' : ''}`} key={model.key}>
            <div className="provider-row__identity"><strong>{model.name}</strong><small>{model.id}</small></div>
            <div className="provider-model-row__capabilities">
              {model.reasoning ? <span title={`${model.availableThinkingLevels.length} reasoning levels`}><Gauge size={11} /> Reasoning</span> : null}
              {model.fastModeSupported ? <span><Zap size={11} /> Fast</span> : null}
              <span className={model.available && model.enabled !== false ? 'is-available' : ''}>{model.enabled === false ? (externalAuth ? 'Hidden' : 'Disabled') : externalAuth ? 'Shown' : model.available ? 'Available' : 'Needs credentials'}</span>
            </div>
            <label className="provider-row__toggle provider-model-row__toggle" title={model.enabled === false ? `Show model in ${agentName}` : `Hide model in ${agentName}`}><input type="checkbox" aria-label={`Show ${model.name} model`} checked={model.enabled !== false} disabled={busyProvider === `model:${model.key}`} onChange={(event) => void run(`model:${model.key}`, () => onSetModelEnabled(model.key, event.target.checked))} /><i aria-hidden="true"><span /></i></label>
          </div>)}</div>
        </div>})}
      </div>}
      {catalog && view === 'providers' && !providers.length ? <p className="settings-empty">No providers match your search.</p> : null}
      {catalog && view === 'models' && !modelGroups.length ? <p className="settings-empty">No models match your search.</p> : null}
      {apiKeyProvider ? <Modal title={`Connect ${apiKeyProvider.name}`} onClose={() => { if (!busyProvider) closeApiKey() }} footer={<><button type="button" className="button" disabled={Boolean(busyProvider)} onClick={closeApiKey}>Cancel</button><button type="button" className="button button--primary" disabled={Boolean(busyProvider) || !apiKey.trim()} onClick={() => void saveApiKey()}>Save API key</button></>}><p className="modal-intro">The key is sent directly to Prime Agent’s protected auth store. GooeyPi clears it from renderer state when this dialog closes.</p>{apiKeyError ? <p className="settings-error" role="alert">{apiKeyError}</p> : null}<label className="field"><span>API key</span><input autoFocus type="password" value={apiKey} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /></label></Modal> : null}
    </section>
  )
}

const PROVIDERS_PAGE_INTROS: Record<HarnessId, string> = {
  omp: 'Choose which OMP providers and models appear in GooeyPi. These visibility settings do not change OMP itself; credentials remain managed by OMP. You may need to log in to or out of providers in the OMP CLI before they appear on this screen.',
  pi: 'Choose which Pi providers and models appear in GooeyPi. These visibility settings do not change Pi itself; Pi provider authentication is managed by the pi CLI. You may need to log in to or out of providers in the Pi CLI before they appear on this screen.',
  prime: 'Connect accounts, choose which providers and their models appear in GooeyPi, and browse every model Prime Agent supports. You may need to log in to or out of providers in the Prime Agent CLI before they appear on this screen.',
}
/** Rust Prime's catalog lists only models it has credentials for, so there is no full catalogue to browse. */
const RUST_PRIME_PROVIDERS_PAGE_INTRO = `Connect accounts and choose which providers and their models appear in GooeyPi. ${RUST_PRIME_AGENT_NAME} lists only the models your credentials can use, so a provider's models appear once it is connected. You may need to log in to or out of providers in the Prime Agent CLI before they appear on this screen.`

interface ProvidersSettingsProps extends ProviderSettingsProps {
  /** Detected Prime build; Rust Prime gets its own intro. */
  primeImplementation?: PrimeImplementation
}

/** The Providers settings page: heading plus the provider/model catalog section. */
export function ProvidersSettings({ primeImplementation, ...props }: ProvidersSettingsProps) {
  const harness = props.harness ?? 'prime'
  const intro = harness === 'prime' && primeImplementation === 'rust' ? RUST_PRIME_PROVIDERS_PAGE_INTRO : PROVIDERS_PAGE_INTROS[harness]
  return (
    <>
      <header><h1>Providers</h1><p>{intro}</p></header>
      <ProviderSettings {...props} />
    </>
  )
}
