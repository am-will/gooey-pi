import { AlertTriangle, ArrowLeft, BookOpen, Check, ChevronRight, FileCode2, FileText, GitFork, Globe2, Package, Palette, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CapabilityMutationInput, ExtensionInstallInput, HarnessId, McpConnectionInput, McpStateInput, PluginWarning, SkillRecord } from '@/types/api'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { NETWORK_MCP_UNAVAILABLE_DETAIL } from '@/lib/mcp-policy'
import { EmptyState, Modal } from '@/components/ui'

const MCP_STDIO_HELP: Record<HarnessId, string> = {
  omp: 'OMP starts this stdio MCP server directly in each new session.',
  prime: 'Prime Agent MCP setup is managed outside GooeyPi.',
  pi: 'Pi starts this stdio MCP server through the pi-mcp-adapter extension (pi install npm:pi-mcp-adapter) in each new session.',
}

type DirectoryTab = 'plugins' | 'skills'
type AddKind = 'mcp' | 'bundle' | 'extension'
type McpScope = 'user' | 'project'

const PACKAGE_LABELS: Record<HarnessId, string> = { prime: 'Prime package', omp: 'OMP plugin', pi: 'Pi package' }
const PACKAGE_HELP: Record<HarnessId, string> = {
  prime: 'Install a Prime package containing extensions, skills, prompts, or themes with Prime Agent’s package manager.',
  omp: 'Install an OMP plugin bundle with OMP’s native plugin manager. Marketplace targets use name@marketplace.',
  pi: 'Install a Pi package containing extensions, skills, prompts, or themes with Pi’s package manager.',
}
const GITHUB_ISSUES_URL = 'https://github.com/am-will/gooey-pi/issues/new'

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
  skills: SkillRecord[]
  warnings: PluginWarning[]
  loading: boolean
  activeProjectPath?: string
  onRefresh(): Promise<void>
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

export function PluginsPage({ harness, skills, warnings, loading, activeProjectPath, askUserEnabled, onSetAskUserEnabled, browserEnabled, onSetBrowserEnabled, computerUseEnabled, onSetComputerUseEnabled, onOpenExternal, onRefresh, onInstall, onInstallExtension, onSetMcpSupport, onConnectMcp, onSetMcpEnabled, onMutateCapability = async () => ({ ok: false, output: 'Capability changes are unavailable.' }) }: PluginsPageProps) {
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
      setComputerUseAlert(skill.availability.detail)
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
    setMcpSupportNotice(enabling ? 'Installing Pi MCP Adapter…' : 'Disabling Pi MCP Adapter…')
    try {
      const response = await onSetMcpSupport(enabling)
      if (!response.ok) {
        const busy = /lock file is already being held|settings are busy/i.test(response.output)
        setMcpSupportAlert(busy ? 'Pi settings are busy. Close any other Pi package operation and try again.' : response.output)
        setMcpSupportNotice('')
      } else {
        setMcpSupportNotice(enabling ? 'Pi MCP Adapter installed.' : 'Pi MCP Adapter disabled.')
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
        const response = await onMutateCapability({ kind: 'mcp', action: enabled ? 'enable' : 'disable', name: mcpServerName(skill), scope: 'user' })
        if (!response.ok) setCapabilityAlert(response.output)
      } else {
        const response = await onSetMcpEnabled({ name: skill.name, scope: skill.location === 'project' ? 'project' : 'user', projectPath: skill.location === 'project' ? activeProjectPath : undefined, enabled })
        if (!response.ok) setCapabilityAlert(response.output)
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
      const response = await onMutateCapability({
        kind: skill.kind === 'mcp' ? 'mcp' : 'package',
        action,
        name: skill.kind === 'mcp' ? mcpServerName(skill) : skill.name,
        ...(skill.kind === 'mcp' && action === 'remove' && skill.definitionKey !== undefined ? { definitionKey: skill.definitionKey } : {}),
        ...(skill.kind === 'package' ? { source: skill.source } : {}),
        scope: skill.location === 'project' ? 'project' : 'user',
        projectPath: skill.location === 'project' ? activeProjectPath : undefined,
      })
      if (!response.ok) setCapabilityAlert(response.output)
    } finally {
      setCapabilityUpdating('')
    }
  }
  const removeCapability = async (skill: SkillRecord) => {
    setConfirmRemove(null)
    await mutate(skill, 'remove')
  }
  const mcpStatusDetail = (skill: SkillRecord): string | undefined => {
    if (skill.kind !== 'mcp') return undefined
    if (skill.availability?.available === false) return skill.availability.detail
    if (harness === 'pi' && !piMcpAdapterInstalled) return 'Enable Pi MCP Adapter before changing this local MCP server.'
    return undefined
  }
  const capabilityControl = (skill: SkillRecord) => {
    if (skill.kind === 'mcp' && skill.availability?.available === false) {
      const external = skill.availability.detail.includes('managed outside GooeyPi')
      const label = external ? `Externally managed ${skill.name}` : harness === 'pi' ? `Pi MCP Adapter required for ${skill.name}` : `Unavailable ${skill.name}`
      return <span className="plugin-toggle" role="img" aria-label={label} aria-describedby={capabilityDetailId(skill)}><ShieldCheck aria-hidden="true" size={14}/></span>
    }
    if (harness === 'pi' && skill.kind === 'mcp' && !piMcpAdapterInstalled) {
      return <span className="plugin-toggle" role="img" aria-label={`Pi MCP Adapter required for ${skill.name}`} aria-describedby={capabilityDetailId(skill)}><ShieldCheck aria-hidden="true" size={14}/></span>
    }
    const isBrowser = skill.id === 'prime-work-browser' || skill.id === 'omp-work-browser'
    const actionable = skill.id === 'gooeypi-ask-user' || isBrowser || skill.id === 'gooeypi-computer-use' || skill.id === 'gooeypi-pi-mcp' || skill.kind === 'mcp' || skill.kind === 'package'
    if (!actionable) return <span className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={`${skill.enabled ? 'Enabled' : 'Unavailable'} ${skill.name}`}>{skill.enabled ? <Check size={14}/> : <Plus size={14}/>}</span>
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
    return <button type="button" className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'} aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`} aria-pressed={skill.enabled} disabled={updating} title={skill.availability?.detail} onClick={() => { if (skill.enabled) setConfirmDisable(skill); else void enable() }}>{updating ? <RefreshCw className="spin" size={14}/> : skill.enabled ? <><Check className="plugin-toggle__check" size={14}/><X className="plugin-toggle__disable" size={14}/></> : <Plus className="plugin-toggle__plus" size={14}/>}</button>
  }

  return (
    <div className="page plugin-page scroll-area">
      <div className="page-container plugin-container">
        <header className="plugin-header">
          <div><span className="eyebrow">{HARNESS_SHORT_NAMES[harness]} capabilities</span><h1>Extend {HARNESS_SHORT_NAMES[harness]}</h1><p>Manage packages, extensions, MCP servers, and reusable skills for this harness.</p></div>
          <div>
            <button type="button" className="button" onClick={() => void onRefresh()}><RefreshCw className={loading ? 'spin' : ''} size={13}/> Refresh</button>
            <button type="button" className="button" onClick={() => setFilter('installed')}><Settings2 size={13}/> Manage</button>
            <button type="button" className="button button--primary" onClick={openAdd}><Plus size={14}/> Add</button>
          </div>
        </header>
        <div className="directory-tabs">
          <button type="button" className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>Capabilities</button>
          <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => setTab('skills')}>Skills</button>
        </div>
        <div className="directory-tools">
          <label className="page-search"><Search size={14}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${tab === 'plugins' ? 'capabilities' : 'skills'}`}/></label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Directory filter">
            <option value="all">All sources</option><option value="installed">Installed</option><option value="bundled">Bundled</option><option value="user">Personal</option><option value="project">Project</option><option value="system">System</option>
          </select>
        </div>
        {warnings.map((warning) => (
          <p key={`${warning.scope}:${warning.path}`} className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {warning.scope === 'project' ? 'Project' : 'Personal'} {warning.message} ({warning.path})
          </p>
        ))}
        {capabilityAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {capabilityAlert}</p> : null}
        {computerUseAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {computerUseAlert}</p> : null}
        {harness === 'pi' && mcpSupportAlert ? <p className="page-inline-error" role="alert"><AlertTriangle size={13}/> {mcpSupportAlert}</p> : null}
        {harness === 'pi' && mcpSupportNotice ? <p className="connection-warning" role="status">{mcpSupportUpdating ? <RefreshCw className="spin" size={13}/> : <ShieldCheck size={13}/>} {mcpSupportNotice}</p> : null}
        {harness === 'pi' && !piMcpAdapterInstalled ? <p className="connection-warning"><ShieldCheck size={13}/> Pi core has no MCP client. Enable Pi MCP Adapter below before adding servers.</p> : null}
        <p className="connection-warning"><ShieldCheck size={13}/> {NETWORK_MCP_UNAVAILABLE_DETAIL}</p>
        <div className="directory-heading"><h2>{filter === 'installed' ? 'Installed' : tab === 'plugins' ? 'Capabilities' : 'Skills'}</h2><span>{visible.length} shown</span></div>
        {visible.length ? (
          <div className="directory-list">{visible.map((skill) => {
            const statusDetail = mcpStatusDetail(skill)
            return <article key={skill.id}>
              <span className={`directory-icon directory-icon--${skill.kind}`}><SkillIcon skill={skill}/></span>
              <div><div><h3>{skill.name}</h3><span>{skill.location}</span></div><p id={statusDetail ? capabilityDetailId(skill) : undefined}>{skill.description}{statusDetail ? ` ${statusDetail}` : ''}</p></div>
              <div className="capability-actions">
                {skill.kind === 'package' || skill.kind === 'mcp' && skill.location !== 'bundled' && skill.location !== 'system' && skill.definitionRemovalAvailable !== false ? <button type="button" className="plugin-remove" aria-label={`Remove ${skill.name}`} disabled={capabilityUpdating === skill.id} onClick={() => setConfirmRemove(skill)}><Trash2 size={13}/></button> : null}
                {capabilityControl(skill)}
              </div>
            </article>
          })}</div>
        ) : <EmptyState icon={<Sparkles size={23}/>} title="Nothing here yet">Try another filter or add a capability package supported by {HARNESS_SHORT_NAMES[harness]}.</EmptyState>}

        {confirmDisable ? <Modal title={`Disable ${confirmDisable.name}?`} onClose={() => setConfirmDisable(null)} footer={<><button type="button" className="button" onClick={() => setConfirmDisable(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => void disableCapability(confirmDisable)}>Yes, disable</button></>}><p className="modal-intro">Are you sure? New sessions will no longer receive this capability until you enable it again. Installed files, server settings, and saved authorization are kept.</p></Modal> : null}
        {confirmRemove ? <Modal title={`Remove ${confirmRemove.name}?`} onClose={() => setConfirmRemove(null)} footer={<><button type="button" className="button" onClick={() => setConfirmRemove(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => void removeCapability(confirmRemove)}>Yes, remove completely</button></>}><p className="modal-intro">Are you sure? This removes {confirmRemove.kind === 'mcp' ? harness === 'prime' ? 'only the server definition. Prime authorization is unchanged and must be managed directly in Prime Agent.' : 'only the server definition; harness-owned authorization is not changed.' : 'the package registration and harness-managed files.'} Other packages and MCP entries will be kept.</p></Modal> : null}

        {addOpen ? (
          <Modal
            title={addKind ? `Add ${addKind === 'mcp' ? 'MCP server' : addKind === 'extension' ? 'extension' : PACKAGE_LABELS[harness].toLowerCase()}` : `Add a ${HARNESS_SHORT_NAMES[harness]} capability`}
            onClose={() => setAddOpen(false)}
            footer={addKind
              ? <><button type="button" className="button" onClick={() => selectAddKind(null)}><ArrowLeft size={13}/> Back</button><button type="button" className="button button--primary" disabled={!canAdd || adding} onClick={() => void add()}>{adding ? (addKind === 'mcp' ? 'Saving…' : 'Installing…') : (addKind === 'mcp' ? 'Save local server' : addKind === 'extension' ? 'Install extension' : `Install ${harness === 'omp' ? 'plugin' : 'package'}`)}</button></>
              : <button type="button" className="button" onClick={() => setAddOpen(false)}>Cancel</button>}
          >
            {addKind === null ? (
              <div className="capability-choice-list">
                <button type="button" disabled={harness === 'prime' || harness === 'pi' && !piMcpAdapterInstalled} onClick={() => selectAddKind('mcp')}>
                  <span><Globe2 size={17}/></span><span><strong>Add MCP</strong><small>{harness === 'prime' ? 'Prime MCP setup is managed outside GooeyPi' : harness === 'pi' && !piMcpAdapterInstalled ? 'Enable Pi MCP Adapter first' : 'Add a local stdio server; network servers stay externally managed'}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" onClick={() => selectAddKind('bundle')}>
                  <span><Package size={17}/></span><span><strong>Add {harness === 'omp' ? 'Plugin' : 'Package'}</strong><small>{PACKAGE_HELP[harness]}</small></span><ChevronRight size={15}/>
                </button>
                <button type="button" onClick={() => selectAddKind('extension')}>
                  <span><FileCode2 size={17}/></span><span><strong>Add Extension</strong><small>Install one local JavaScript or TypeScript extension module for {HARNESS_SHORT_NAMES[harness]}.</small></span><ChevronRight size={15}/>
                </button>
                <p className="capability-compatibility-note"><AlertTriangle size={13}/><span>Not every third-party package, plugin, or extension will work in GooeyPi. If something fails, <button type="button" onClick={() => onOpenExternal(GITHUB_ISSUES_URL)}>create a GitHub issue</button>.</span></p>
              </div>
            ) : addKind === 'bundle' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{PACKAGE_HELP[harness]} This installs executable code; it does not connect to an arbitrary MCP endpoint.</p>
                <label className="field"><span>{PACKAGE_LABELS[harness]} source</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder={harness === 'omp' ? 'plugin-name@marketplace' : 'npm:@scope/package'}/></label>
                <small className="field-help">{harness === 'omp' ? <>Examples: <code>name@marketplace</code>, a Git URL, or an absolute local folder path.</> : <>Examples: a Git URL, <code>npm:@scope/package</code>, or an absolute local folder path.</>}</small>
              </div>
            ) : addKind === 'extension' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'omp'
                  ? 'OMP installs standalone modules into its native extensions directory. Use Add Plugin instead when the source is a bundle with a package.json manifest.'
                  : `${HARNESS_SHORT_NAMES[harness]} records a standalone local extension file through its native package manager. The original file remains the source of truth.`}</p>
                <label className="field"><span>Extension file</span><input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="/absolute/path/to/my-extension.ts"/></label>
                <small className="field-help">Choose an absolute local <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, or <code>.cjs</code> file. Extensions run with your user permissions.</small>
                <label className="field"><span>Available in</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">All projects (personal)</option><option value="project" disabled={!activeProjectPath}>Current project</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> Extension APIs differ between harnesses. GooeyPi installs the file correctly, but CLI-specific UI may not render in the desktop app.</p>
              </div>
            ) : (
              <div className="add-tool-form">
                <p className="modal-intro">{harness === 'omp'
                  ? 'Add a local stdio server to OMP’s native MCP configuration. HTTP/SSE servers and OAuth are managed directly in OMP, outside GooeyPi.'
                  : 'Add a local stdio server to pi-mcp-adapter’s configuration. HTTP/SSE servers and OAuth are managed outside GooeyPi.'}</p>
                <label className="field"><span>Server name</span><input autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="my-local-tools"/></label>
                <p className="field-help">{MCP_STDIO_HELP[harness]}</p>
                <label className="field"><span>Executable</span><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx"/></label>
                <label className="field"><span>Arguments <small>(one per line)</small></span><textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'}/></label>
                <label className="field"><span>Available in</span><select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}><option value="user">All projects (personal)</option><option value="project" disabled={!activeProjectPath}>Current project</option></select></label>
                <p className="connection-warning"><ShieldCheck size={13}/> Only connect servers you trust. MCP tools can read data or run actions with your user permissions.</p>
              </div>
            )}
            {result ? <pre className="install-output" role="status">{result}</pre> : null}
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
