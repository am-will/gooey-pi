import { AlertTriangle, ArrowLeft, BookOpen, Check, ChevronRight, FileCode2, FileText, GitFork, Globe2, Package, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CapabilityMutationInput, ExtensionInstallInput, HarnessId, McpConnectionInput, McpStateInput, PluginWarning, PrimeImplementation, SkillRecord } from '@/types/api'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { LOCAL_MCP_STATE_UNAVAILABLE_DETAIL, NETWORK_MCP_AUTH_UNAVAILABLE, NETWORK_MCP_UNAVAILABLE_DETAIL, PI_MCP_ADAPTER_REQUIRED_DETAIL, PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL } from '@/lib/mcp-policy'
import { primeCapabilityAvailable, primeUnavailableCapabilitiesNotice, RUST_PRIME_EXTENSIONS_DETAIL } from '@/lib/prime-compat'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { EmptyState, Modal } from '@/components/ui'

const MCP_STDIO_HELP_KEYS: Record<HarnessId, MessageKey> = {
  omp: 'plugins.mcpStdioHelp.omp',
  prime: 'plugins.mcpStdioHelp.prime',
  pi: 'plugins.mcpStdioHelp.pi',
}

type DirectoryTab = 'plugins' | 'skills'
type AddKind = 'mcp' | 'bundle' | 'extension'
type McpScope = 'user' | 'project'

const PACKAGE_LABEL_KEYS: Record<HarnessId, MessageKey> = { prime: 'plugins.packageLabel.prime', omp: 'plugins.packageLabel.omp', pi: 'plugins.packageLabel.pi' }
const PACKAGE_HELP_KEYS: Record<HarnessId, MessageKey> = {
  prime: 'plugins.packageHelp.prime',
  omp: 'plugins.packageHelp.omp',
  pi: 'plugins.packageHelp.pi',
}
/** English lowercases the harness noun in the add-modal heading, so each harness needs its own key. */
const ADD_BUNDLE_TITLE_KEYS: Record<HarnessId, MessageKey> = { prime: 'plugins.add.title.primePackage', omp: 'plugins.add.title.ompPlugin', pi: 'plugins.add.title.piPackage' }
const GITHUB_ISSUES_URL = 'https://github.com/am-will/gooey-pi/issues/new'

/**
 * Why a record cannot be offered, when it cannot. Computer use is the one
 * unavailable capability that stays actionable: enabling it opens the driver
 * installer instead.
 */
function unavailableDetail(skill: SkillRecord): string | undefined {
  return skill.availability?.available === false && skill.id !== 'gooeypi-computer-use' ? skill.availability.detail : undefined
}

const AVAILABILITY_DETAIL_KEYS: Record<string, MessageKey> = {
  [NETWORK_MCP_UNAVAILABLE_DETAIL]: 'plugins.warning.networkMcpUnavailable',
  [NETWORK_MCP_AUTH_UNAVAILABLE]: 'plugins.warning.networkMcpAuth',
  [PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL]: 'plugins.warning.primeMcpManagement',
  [PI_MCP_ADAPTER_REQUIRED_DETAIL]: 'plugins.warning.piMcpAdapterRequired',
  [LOCAL_MCP_STATE_UNAVAILABLE_DETAIL]: 'plugins.warning.localMcpState',
}

// The directory row shows the stored location verbatim, so these English entries
// mirror the enum; the filter above labels the same values in its own words.
const LOCATION_KEYS: Record<SkillRecord['location'], MessageKey> = {
  bundled: 'plugins.location.bundled',
  user: 'plugins.location.user',
  project: 'plugins.location.project',
  system: 'plugins.location.system',
}

function capabilityDetailId(skill: SkillRecord): string {
  return `capability-detail-${skill.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)}`
}

function SkillIcon({ skill }: { skill: SkillRecord }) {
  const common = { size: 16 }
  if (skill.icon === 'github') return <GitFork {...common}/>
  if (skill.icon === 'palette') return <Palette {...common}/>
  if (skill.icon === 'book-open') return <BookOpen {...common}/>
  if (skill.kind === 'mcp') return <Globe2 {...common}/>
  if (skill.kind === 'prompt') return <FileText {...common}/>
  if (skill.kind === 'skill') return <WandSparkles {...common}/>
  return <Package {...common}/>
}

interface PluginsPageProps {
  harness: HarnessId
  /** Detected Prime build; Rust Prime lists the capabilities it does not offer. */
  primeImplementation?: PrimeImplementation
  skills: SkillRecord[]
  warnings: PluginWarning[]
  loading: boolean
  activeProjectPath?: string
  onRefresh(): Promise<void>
  askUserTimeoutMs?: number
  onSetAskUserTimeoutMs?(ms: number): Promise<void>
  askUserEnabled: boolean
  onSetAskUserEnabled(enabled: boolean): Promise<void>
  browserEnabled: boolean
  onSetBrowserEnabled(enabled: boolean): Promise<void>
  computerUseEnabled: boolean
  onSetComputerUseEnabled(enabled: boolean): Promise<void>
  onOpenExternal(url: string): void
  onInstall(source: string): Promise<{ ok: boolean; output: string }>
  onInstallExtension(input: ExtensionInstallInput): Promise<{ ok: boolean; output: string }>
  onSetMcpSupport(enabled: boolean): Promise<{ ok: boolean; output: string }>
  onConnectMcp(input: McpConnectionInput): Promise<{ ok: boolean; output: string }>
  onSetMcpEnabled(input: McpStateInput): Promise<{ ok: boolean; output: string }>
  onMutateCapability?(input: CapabilityMutationInput): Promise<{ ok: boolean; output: string }>
}

export function PluginsPage({ harness, primeImplementation, skills, warnings, loading, activeProjectPath, askUserTimeoutMs = 120_000, onSetAskUserTimeoutMs, askUserEnabled, onSetAskUserEnabled, browserEnabled, onSetBrowserEnabled, computerUseEnabled, onSetComputerUseEnabled, onOpenExternal, onRefresh, onInstall, onInstallExtension, onSetMcpSupport, onConnectMcp, onSetMcpEnabled, onMutateCapability }: PluginsPageProps) {
  const { t } = useI18n()
  // Main-process output is either one of the fixed availability details or raw
  // command output; only the former is translated.
  const describeDetail = (detail: string): string => {
    const key = AVAILABILITY_DETAIL_KEYS[detail]
    return key ? t(key) : detail
  }
  // `onMutateCapability` is optional in tests and reduced wiring, so the fallback
  // is built here instead of as a default parameter where `t` is not yet bound.
  const mutateCapability = onMutateCapability ?? (async () => ({ ok: false, output: t('plugins.mutationUnavailable') }))
  const [tab, setTab] = useState<DirectoryTab>('plugins')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<AddKind | null>(null)
  const [source, setSource] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpScope, setMcpScope] = useState<McpScope>('user')
  const [result, setResult] = useState('')
  const [adding, setAdding] = useState(false)
  const [askUserUpdating, setAskUserUpdating] = useState(false)
  const [browserUpdating, setBrowserUpdating] = useState(false)
  const [computerUseUpdating, setComputerUseUpdating] = useState(false)
  const [computerUseAlert, setComputerUseAlert] = useState('')
  const [mcpSupportUpdating, setMcpSupportUpdating] = useState(false)
  const [mcpSupportAlert, setMcpSupportAlert] = useState('')
  const [mcpSupportNotice, setMcpSupportNotice] = useState('')
  const [capabilityUpdating, setCapabilityUpdating] = useState('')
  const [confirmDisable, setConfirmDisable] = useState<SkillRecord | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SkillRecord | null>(null)
  const [capabilityAlert, setCapabilityAlert] = useState('')
  const piMcpAdapterInstalled = skills.some((skill) => skill.id === 'gooeypi-pi-mcp' && skill.enabled)
  const primeLimits = harness === 'prime' ? primeUnavailableCapabilitiesNotice(primeImplementation) : undefined
  const extensionsOffered = harness !== 'prime' || primeCapabilityAvailable(primeImplementation, 'typescriptExtensions')
  const canConfigureMcp = harness === 'omp' || harness === 'pi' && piMcpAdapterInstalled

  const visible = useMemo(() => skills.map((skill) => skill.id === 'gooeypi-ask-user'
    ? { ...skill, enabled: askUserEnabled }
    : skill.id === 'prime-work-browser' || skill.id === 'omp-work-browser' ? { ...skill, enabled: browserEnabled }
    : skill.id === 'gooeypi-computer-use' ? { ...skill, enabled: computerUseEnabled } : skill).filter((skill) => {
    const capability = skill.id === 'prime-work-browser' || skill.id === 'omp-work-browser' || skill.kind !== 'skill' && skill.kind !== 'prompt'
    return (tab === 'plugins' ? capability : !capability)
      && (filter === 'all' || filter === 'installed' && skill.enabled || filter === skill.location)
      && `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
  }), [askUserEnabled, browserEnabled, computerUseEnabled, skills, tab, filter, query])

  const canAdd = addKind === 'bundle'
    ? Boolean(source.trim())
    : addKind === 'extension'
      ? Boolean(source.trim() && (mcpScope !== 'project' || activeProjectPath))
    : addKind === 'mcp' && canConfigureMcp && Boolean(
      mcpName.trim()
      && mcpCommand.trim()
      && (mcpScope !== 'project' || activeProjectPath),
    )

  const add = async () => {
    if (!canAdd) return
    setAdding(true)
    setResult('')
    try {
      const response = addKind === 'bundle'
        ? await onInstall(source.trim())
        : addKind === 'extension'
          ? await onInstallExtension({ source: source.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined })
          : await onConnectMcp({ name: mcpName.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined, type: 'stdio', command: mcpCommand.trim(), args: mcpArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) })
      setResult(response.output)
      if (response.ok) {
        setSource('')
        setMcpName('')
        setMcpCommand('')
        setMcpArgs('')
        if (addKind === 'mcp' || addKind === 'bundle') await onRefresh()
      }
    } finally {
      setAdding(false)
    }
  }

  const selectAddKind = (value: AddKind | null) => { setAddKind(value); setSource(''); setResult('') }
  const openAdd = () => { setResult(''); setAddKind(null); setAddOpen(true) }
  const setAskUser = async (enabled: boolean) => {
    if (askUserUpdating) return
    setAskUserUpdating(true)
    try {
      await onSetAskUserEnabled(enabled)
      await onRefresh()
    } finally {
      setAskUserUpdating(false)
    }
  }
  const setBrowser = async (enabled: boolean) => {
    if (browserUpdating) return
    setBrowserUpdating(true)
    try {
      await onSetBrowserEnabled(enabled)
      await onRefresh()
    } finally {
      setBrowserUpdating(false)
    }
  }
  const setComputerUse = async (skill: SkillRecord, enabled: boolean) => {
    if (computerUseUpdating) return
    if (enabled && skill.availability?.available === false) {
      setComputerUseAlert(describeDetail(skill.availability.detail))
      if (skill.availability.actionUrl) onOpenExternal(skill.availability.actionUrl)
      return
    }
    setComputerUseAlert('')
    setComputerUseUpdating(true)
    try {
      await onSetComputerUseEnabled(enabled)
      await onRefresh()
    } finally {
      setComputerUseUpdating(false)
    }
  }
  const setMcpSupport = async (_skill: SkillRecord, enabling: boolean) => {
    if (mcpSupportUpdating) return
    setMcpSupportUpdating(true)
    setMcpSupportAlert('')
    setMcpSupportNotice(enabling ? t('plugins.mcp.adapterInstalling') : t('plugins.mcp.adapterDisabling'))
    try {
      const response = await onSetMcpSupport(enabling)
      if (!response.ok) {
        const busy = /lock file is already being held|settings are busy/i.test(response.output)
        setMcpSupportAlert(busy ? t('plugins.mcp.settingsBusy') : describeDetail(response.output))
        setMcpSupportNotice('')
      } else {
        setMcpSupportNotice(enabling ? t('plugins.mcp.adapterInstalled') : t('plugins.mcp.adapterDisabled'))
      }
    } finally {
      setMcpSupportUpdating(false)
    }
  }
  const mcpServerName = (skill: SkillRecord): string => skill.id.startsWith('prime-mcp-') ? skill.id.slice('prime-mcp-'.length) : skill.name
  const setMcp = async (skill: SkillRecord, enabled: boolean) => {
    if (capabilityUpdating) return
    setCapabilityUpdating(skill.id)
    setCapabilityAlert('')
    try {
      if (skill.id.startsWith('prime-mcp-')) {
        const response = await mutateCapability({ kind: 'mcp', action: enabled ? 'enable' : 'disable', name: mcpServerName(skill), scope: 'user' })
        if (!response.ok) setCapabilityAlert(describeDetail(response.output))
      } else {
        const response = await onSetMcpEnabled({ name: skill.name, scope: skill.location === 'project' ? 'project' : 'user', projectPath: skill.location === 'project' ? activeProjectPath : undefined, enabled })
        if (!response.ok) setCapabilityAlert(describeDetail(response.output))
      }
    } finally {
      setCapabilityUpdating('')
    }
  }
  const disableCapability = async (skill: SkillRecord) => {
    setConfirmDisable(null)
    if (skill.id === 'gooeypi-ask-user') await setAskUser(false)
    else if (skill.id === 'prime-work-browser' || skill.id === 'omp-work-browser') await setBrowser(false)
    else if (skill.id === 'gooeypi-computer-use') await setComputerUse(skill, false)
    else if (skill.id === 'gooeypi-pi-mcp') await setMcpSupport(skill, false)
    else if (skill.kind === 'mcp') await setMcp(skill, false)
    else if (skill.kind === 'package') await mutate(skill, 'disable')
  }
  const mutate = async (skill: SkillRecord, action: CapabilityMutationInput['action']) => {
    setCapabilityUpdating(skill.id)
    setCapabilityAlert('')
    try {
      const response = await mutateCapability({
        kind: skill.kind === 'mcp' ? 'mcp' : 'package',
        action,
        name: skill.kind === 'mcp' ? mcpServerName(skill) : skill.name,
        ...(skill.kind === 'mcp' && action === 'remove' && skill.definitionKey !== undefined ? { definitionKey: skill.definitionKey } : {}),
        ...(skill.kind === 'package' ? { source: skill.source } : {}),
        scope: skill.location === 'project' ? 'project' : 'user',
        projectPath: skill.location === 'project' ? activeProjectPath : undefined,
      })
      if (!response.ok) setCapabilityAlert(describeDetail(response.output))
    } finally {
      setCapabilityUpdating('')
    }
  }
  const removeCapability = async (skill: SkillRecord) => {
    setConfirmRemove(null)
    await mutate(skill, 'remove')
  }
  const capabilityStatusDetail = (skill: SkillRecord): string | undefined => {
    const unavailable = unavailableDetail(skill)
    if (unavailable) return unavailable
    if (skill.kind === 'mcp' && harness === 'pi' && !piMcpAdapterInstalled) return 'Enable Pi MCP Adapter before changing this local MCP server.'
    return undefined
  }
  const capabilityControl = (skill: SkillRecord) => {
    const unavailable = unavailableDetail(skill)
    if (unavailable) {
      const external = unavailable.includes('managed outside GooeyPi')
      const label = external ? `Externally managed ${skill.name}` : harness === 'pi' && skill.kind === 'mcp' ? `Pi MCP Adapter required for ${skill.name}` : `Unavailable ${skill.name}`
      return <span className="plugin-toggle" role="img" aria-label={label} aria-describedby={capabilityDetailId(skill)}><ShieldCheck aria-hidden="true" size={14}/></span>
    }
    if (harness === 'pi' && skill.kind === 'mcp' && !piMcpAdapterInstalled) {
      return <span className="plugin-toggle" role="img" aria-label={t('plugins.aria.adapterRequired', { name: skill.name })} aria-describedby={capabilityDetailId(skill)}><ShieldCheck aria-hidden="true" size={14}/></span>
    }
    const isBrowser = skill.id === 'prime-work-browser' || skill.id === 'omp-work-browser'
    const actionable = skill.id === 'gooeypi-ask-user' || isBrowser || skill.id === 'gooeypi-computer-use' || skill.id === 'gooeypi-pi-mcp' || skill.kind === 'mcp' || skill.kind === 'package'
    if (!actionable) return <span className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={skill.enabled ? t('plugins.aria.enabled', { name: skill.name }) : t('plugins.aria.unavailable', { name: skill.name })}>{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</span>
    const updating = skill.id === 'gooeypi-ask-user' ? askUserUpdating
      : isBrowser ? browserUpdating
        : skill.id === 'gooeypi-computer-use' ? computerUseUpdating
          : skill.id === 'gooeypi-pi-mcp' ? mcpSupportUpdating
            : capabilityUpdating === skill.id
    const enable = () => {
      if (skill.id === 'gooeypi-ask-user') return setAskUser(true)
      if (isBrowser) return setBrowser(true)
      if (skill.id === 'gooeypi-computer-use') return setComputerUse(skill, true)
      if (skill.id === 'gooeypi-pi-mcp') return setMcpSupport(skill, true)
      if (skill.kind === 'package') return mutate(skill, 'enable')
      return setMcp(skill, true)
    }
    return <button type="button" className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={skill.enabled ? t('plugins.aria.disable', { name: skill.name }) : t('plugins.aria.enable', { name: skill.name })} aria-pressed={skill.enabled} disabled={updating} title={skill.availability?.detail ? describeDetail(skill.availability.detail) : undefined} onClick={() => { if (skill.enabled) setConfirmDisable(skill); else void enable() }}>{updating ? <RefreshCw className="spin" size={14}/> : skill.enabled ? <><Check className="plugin-toggle__check" size={14}/><X className="plugin-toggle__disable" size={14}/></> : <Plus className="plugin-toggle__plus" size={14}/>}</button>
  }

  return (
    <div className="page plugin-page scroll-area">
      <div className="page-container plugin-container">
        <header className="plugin-header">
          <div><span className="eyebrow">{t('plugins.header.eyebrow', { name: HARNESS_SHORT_NAMES[harness] })}</span><h1>{t('plugins.header.title', { name: HARNESS_SHORT_NAMES[harness] })}</h1><p>{t('plugins.header.description')}</p></div>
          <div>
            <button type="button" className="button" onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={13}/> {t('common.refresh')}</button>
            <button type="button" className="button" onClick={() => setFilter('installed')}><Settings2 size={13}/> {t('plugins.header.manage')}</button>
            <button type="button" className="button button--primary" onClick={openAdd}><Plus size={14}/> {t('common.add')}</button>
          </div>
        </header>
        <div className="directory-tabs">
          <button type="button" className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>{t('nav.capabilities')}</button>
          <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => setTab('skills')}>{t('plugins.tab.skills')}</button>
        </div>
        <div className="directory-tools">
          <label className="page-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === 'plugins' ? t('plugins.search.capabilities') : t('plugins.search.skills')}/></label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t('plugins.filter.aria')}>
            <option value="all">{t('plugins.filter.all')}</option><option value="installed">{t('plugins.filter.installed')}</option><option value="bundled">{t('plugins.filter.bundled')}</option><option value="user">{t('plugins.filter.personal')}</option><option value="project">{t('plugins.filter.project')}</option><option value="system">{t('plugins.filter.system')}</option>
          </select>
        </div>
        {warnings.map((warning) => (
          <p key={`${warning.scope}:${warning.path}`} className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {warning.scope === 'project' ? t('plugins.filter.project') : t('plugins.filter.personal')} {warning.message} ({warning.path})
          </p>
        ))}
        {capabilityAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {capabilityAlert}</p> : null}
        {computerUseAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {computerUseAlert}</p> : null}
        {harness === 'pi' && mcpSupportAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {mcpSupportAlert}</p> : null}
        {harness === 'pi' && mcpSupportNotice ? <p className="connection-warning" role="status">{mcpSupportUpdating ? <RefreshCw className="spin" size={13}/> : <ShieldCheck size={13}/>} {mcpSupportNotice}</p> : null}
        {harness === 'pi' && !piMcpAdapterInstalled ? <p className="connection-warning"><ShieldCheck size={13}/> Pi core has no MCP client. Enable Pi MCP Adapter below before adding servers.</p> : null}
        {onSetAskUserTimeoutMs ? <label className="settings-row">
          <span><strong>{t('plugins.askUser.timeoutLabel')}</strong><small>{t('plugins.askUser.timeoutDescription')}</small></span>
          <select value={askUserTimeoutMs} onChange={(event) => { void onSetAskUserTimeoutMs(Number(event.target.value)) }} aria-label={t('plugins.askUser.timeoutLabel')}>
            <option value="0">{t('plugins.askUser.never')}</option><option value="60000">{t('plugins.askUser.minutes', { count: 1 })}</option><option value="120000">{t('plugins.askUser.minutes', { count: 2 })}</option><option value="300000">{t('plugins.askUser.minutes', { count: 5 })}</option><option value="600000">{t('plugins.askUser.minutes', { count: 10 })}</option><option value="1800000">{t('plugins.askUser.minutes', { count: 30 })}</option>
          </select>
        </label> : null}
        {primeLimits ? <p className="connection-warning"><ShieldCheck size={13}/> {primeLimits}</p> : null}
        <p className="connection-warning"><ShieldCheck size={13}/> {t('plugins.warning.networkMcpUnavailable')}</p>
        <div className="directory-heading"><h2>{filter === 'installed' ? t('plugins.filter.installed') : tab === 'plugins' ? t('nav.capabilities') : t('plugins.tab.skills')}</h2><span>{t('plugins.shownCount', { count: visible.length })}</span></div>
        {visible.length ? (
          <div className="directory-list">{visible.map((skill) => {
            const statusDetail = capabilityStatusDetail(skill)
            return <article key={skill.id}>
              <span className={`directory-icon directory-icon--${skill.kind}`}><SkillIcon skill={skill}/></span>
              <div><div><h3>{skill.name}</h3><span>{t(LOCATION_KEYS[skill.location])}</span></div><p id={statusDetail ? capabilityDetailId(skill) : undefined}>{skill.description}{statusDetail ? ` ${describeDetail(statusDetail)}` : ''}</p></div>
              <div className="capability-actions">
                {skill.kind === 'package' || skill.kind === 'mcp' && skill.location !== 'bundled' && skill.location !== 'system' && skill.definitionRemovalAvailable !== false ? <button type="button" className="plugin-remove" aria-label={t('plugins.aria.remove', { name: skill.name })} disabled={capabilityUpdating === skill.id} onClick={() => setConfirmRemove(skill)}><Trash2 size={13}/></button> : null}
                {capabilityControl(skill)}
              </div>
            </article>
          })}</div>
        ) : <EmptyState icon={<Sparkles size={23}/>} title={t('plugins.empty.title')}>{t('plugins.empty.description', { name: HARNESS_SHORT_NAMES[harness] })}</EmptyState>}

        {confirmDisable ? <Modal title={t('plugins.confirm.disable.title', { name: confirmDisable.name })} onClose={() => setConfirmDisable(null)} footer={<><button type="button" className="button" onClick={() => setConfirmDisable(null)}>{t('common.cancel')}</button><button type="button" className="button button--danger" onClick={() => void disableCapability(confirmDisable)}>{t('plugins.confirm.disable.action')}</button></>}><p className="modal-intro">{t('plugins.confirm.disable.body')}</p></Modal> : null}
        {confirmRemove ? <Modal title={t('plugins.confirm.remove.title', { name: confirmRemove.name })} onClose={() => setConfirmRemove(null)} footer={<><button type="button" className="button" onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</button><button type="button" className="button button--danger" onClick={() => void removeCapability(confirmRemove)}>{t('plugins.confirm.remove.action')}</button></>}><p className="modal-intro">{t('plugins.confirm.remove.body', { detail: confirmRemove.kind === 'mcp' ? harness === 'prime' ? t('plugins.confirm.remove.detail.primeMcp') : t('plugins.confirm.remove.detail.mcp') : t('plugins.confirm.remove.detail.package') })}</p></Modal> : null}

        {addOpen ? (
          <Modal
            title={addKind ? addKind === 'mcp' ? t('plugins.add.title.mcp') : addKind === 'extension' ? t('plugins.add.title.extension') : t(ADD_BUNDLE_TITLE_KEYS[harness]) : t('plugins.add.title.root', { name: HARNESS_SHORT_NAMES[harness] })}
            onClose={() => setAddOpen(false)}
            footer={addKind
              ? <><button type="button" className="button" onClick={() => selectAddKind(null)}><ArrowLeft size={13}/> {t('common.back')}</button><button type="button" className="button button--primary" disabled={!canAdd || adding} onClick={() => void add()}>{adding ? (addKind === 'mcp' ? t('plugins.add.saving') : t('plugins.add.installing')) : (addKind === 'mcp' ? t('plugins.add.saveServer') : addKind === 'extension' ? t('plugins.add.installExtension') : harness === 'omp' ? t('plugins.add.installPlugin') : t('plugins.add.installPackage'))}</button></>
              : <button type="button" className="button" onClick={() => setAddOpen(false)}>{t('common.cancel')}</button>}
          >
            {addKind === null ? (
              <div className="capability-choice-list">
                <button type="button" disabled={harness === 'prime' || harness === 'pi' && !piMcpAdapterInstalled} onClick={() => selectAddKind('mcp')}>
                  <span><Globe2 size={17}/></span><span><strong>{t('plugins.add.card.mcp.title')}</strong><small>{harness === 'prime' ? t('plugins.add.card.mcp.prime') : harness === 'pi' && !piMcpAdapterInstalled ? t('plugins.add.card.mcp.adapterFirst') : t('plugins.add.card.mcp.default')}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" onClick={() => selectAddKind('bundle')}>
                  <span><Package size={17}/></span><span><strong>{harness === 'omp' ? t('plugins.add.card.bundle.plugin') : t('plugins.add.card.bundle.package')}</strong><small>{t(PACKAGE_HELP_KEYS[harness])}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" disabled={!extensionsOffered} onClick={() => selectAddKind('extension')}>
                  <span><FileCode2 size={17}/></span><span><strong>Add Extension</strong><small>{extensionsOffered ? `Install one local JavaScript or TypeScript extension module for ${HARNESS_SHORT_NAMES[harness]}.` : RUST_PRIME_EXTENSIONS_DETAIL}</small></span><ChevronRight size={15}/>
                </button>
                <p className="capability-compatibility-note"><AlertTriangle size={13}/><span>{t('plugins.add.compatibility.note')} <button type="button" onClick={() => onOpenExternal(GITHUB_ISSUES_URL)}>{t('plugins.add.compatibility.link')}</button>{t('plugins.add.compatibility.period')}</span></p>
              </div>
            ) : addKind === 'bundle' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{t('plugins.add.bundle.intro', { help: t(PACKAGE_HELP_KEYS[harness]) })}</p>
                <label className="field"><span>{t('plugins.form.sourceLabel', { package: t(PACKAGE_LABEL_KEYS[harness]) })}</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder={harness === 'omp' ? 'plugin-name@marketplace' : 'npm:@scope/package'}/></label>
                <small className="field-help">{harness === 'omp' ? <>{t('plugins.form.bundleHelp.ompPrefix')} <code>name@marketplace</code>{t('plugins.form.bundleHelp.ompSuffix')}</> : <>{t('plugins.form.bundleHelp.defaultPrefix')} <code>npm:@scope/package</code>{t('plugins.form.bundleHelp.defaultSuffix')}</>}</small>
              </div>
            ) : addKind === 'extension' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'omp'
                  ? t('plugins.add.extension.intro.omp')
                  : t('plugins.add.extension.intro', { name: HARNESS_SHORT_NAMES[harness] })}</p>
                <label className="field"><span>{t('plugins.form.extensionFile')}</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="/absolute/path/to/my-extension.ts"/></label>
                <small className="field-help">{t('plugins.form.extensionHelp.prefix')} <code>.ts</code>{t('plugins.form.listSeparator')}<code>.js</code>{t('plugins.form.listSeparator')}<code>.mjs</code>{t('plugins.form.listOrSeparator')}<code>.cjs</code>{t('plugins.form.extensionHelp.suffix')}</small>
                <label className="field"><span>{t('plugins.form.availableIn')}</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">{t('plugins.form.scope.allProjects')}</option><option value="project" disabled={!activeProjectPath}>{t('plugins.form.scope.currentProject')}</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> {t('plugins.add.extension.warning')}</p>
              </div>
            ) : (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'omp'
                  ? t('plugins.add.mcp.intro.omp')
                  : t('plugins.add.mcp.intro')}</p>
                <label className="field"><span>{t('plugins.form.serverName')}</span><input autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="my-local-tools"/></label>
                <p className="field-help">{t(MCP_STDIO_HELP_KEYS[harness])}</p>
                <label className="field"><span>{t('plugins.form.executable')}</span><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx"/></label>
                <label className="field"><span>{t('plugins.form.arguments')} <small>{t('plugins.form.argumentsHint')}</small></span><textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'}/></label>
                <label className="field"><span>{t('plugins.form.availableIn')}</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">{t('plugins.form.scope.allProjects')}</option><option value="project" disabled={!activeProjectPath}>{t('plugins.form.scope.currentProject')}</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> {t('plugins.add.mcp.warning')}</p>
              </div>
            )}
            {result ? <pre className="install-output" role="status">{result}</pre> : null}
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
