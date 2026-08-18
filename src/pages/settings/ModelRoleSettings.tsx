import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES } from '@/lib/harness'
import { formatModelRoleSelector, parseModelRoleSelector } from '@/lib/model-roles'
import {
  ADVISOR_MAX_IMMUNE_TURNS,
  ADVISOR_SYNC_BACKLOGS,
  AGENT_MODEL_ROLES,
  type AdvisorSyncBacklog,
  type AgentAdvisorSettings,
  type AgentModelRole,
  type AgentRoleConfig,
  type AgentRoleConfigPatch,
  type HarnessId,
  type PrimeModelCatalog,
  type PrimeThinkingLevel,
  type PrimeWorkApi,
} from '@/types/api'
import { SettingsToggle } from './SettingsToggle'

const ROLE_LABELS: Record<AgentModelRole, { title: string; description: string }> = {
  default: { title: 'Default', description: 'Handles ordinary turns unless another role is selected.' },
  slow: { title: 'Slow', description: 'Reserved for thorough, reasoning-heavy analysis.' },
  plan: { title: 'Plan', description: 'Used for architectural planning turns.' },
  smol: { title: 'Smol', description: 'Lightweight model for cheap, mechanical work.' },
  task: { title: 'Task', description: 'Runs spawned task subagents.' },
  advisor: { title: 'Advisor', description: 'Reviews each turn when the advisor below is enabled.' },
}

const SYNC_BACKLOG_LABELS: Record<AdvisorSyncBacklog, string> = {
  'off': 'Off (never wait)',
  '1': '1 turn behind',
  '3': '3 turns behind',
  '5': '5 turns behind',
}

interface ModelRoleSettingsProps {
  harness: HarnessId
  agentConfig: PrimeWorkApi['agentConfig'] | null
  catalog: PrimeModelCatalog | null
}

/**
 * Reads and writes the active harness's own model-role and advisor
 * configuration. The values live in the harness's configuration, not in
 * GooeyPi settings, so the section reads the live configuration on mount and
 * writes only on an explicit save rather than holding optimistic local state.
 * A harness whose adapter declares no agent-config CLI answers `supported:
 * false` and this renders nothing at all.
 */
export function ModelRoleSettings({ harness, agentConfig, catalog }: ModelRoleSettingsProps) {
  const [config, setConfig] = useState<AgentRoleConfig | null>(null)
  const [roles, setRoles] = useState<Partial<Record<AgentModelRole, string>>>({})
  const [advisor, setAdvisor] = useState<AgentAdvisorSettings | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!agentConfig) return
    let cancelled = false
    setConfig(null)
    setLoadError('')
    setSaveError('')
    setSaved(false)
    void agentConfig.get(harness).then((next) => {
      if (cancelled) return
      setConfig(next)
      setRoles(next.roles)
      setAdvisor(next.advisor)
    }).catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)) })
    return () => { cancelled = true }
  }, [agentConfig, harness])

  // Only genuinely changed settings are sent: a save must never rewrite a role
  // the operator did not touch.
  const rolePatch = useMemo(() => {
    const patch: Partial<Record<AgentModelRole, string>> = {}
    for (const role of AGENT_MODEL_ROLES) {
      const next = roles[role] ?? ''
      if (next && next !== (config?.roles[role] ?? '')) patch[role] = next
    }
    return patch
  }, [config, roles])

  const advisorPatch = useMemo(() => {
    const patch: Partial<AgentAdvisorSettings> = {}
    if (!advisor || !config?.advisor) return patch
    if (advisor.enabled !== config.advisor.enabled) patch.enabled = advisor.enabled
    if (advisor.subagents !== config.advisor.subagents) patch.subagents = advisor.subagents
    if (advisor.syncBacklog !== config.advisor.syncBacklog) patch.syncBacklog = advisor.syncBacklog
    if (advisor.immuneTurns !== config.advisor.immuneTurns) patch.immuneTurns = advisor.immuneTurns
    return patch
  }, [advisor, config])

  const dirty = Object.keys(rolePatch).length > 0 || Object.keys(advisorPatch).length > 0

  if (!agentConfig || (config && !config.supported)) return null

  const agentName = HARNESS_AGENT_NAMES[harness]
  const editable = Boolean(config?.installed)

  const changeRole = (role: AgentModelRole, key: string, thinkingLevel: PrimeThinkingLevel | '') => {
    setSaved(false)
    setRoles((current) => ({ ...current, [role]: formatModelRoleSelector(key, thinkingLevel) }))
  }

  const changeAdvisor = (patch: Partial<AgentAdvisorSettings>) => {
    setSaved(false)
    setAdvisor((current) => current ? { ...current, ...patch } : current)
  }

  const revert = () => {
    if (!config) return
    setRoles(config.roles)
    setAdvisor(config.advisor)
    setSaveError('')
    setSaved(false)
  }

  const save = async () => {
    if (!agentConfig || !dirty || saving) return
    setSaving(true)
    setSaveError('')
    setSaved(false)
    const patch: AgentRoleConfigPatch = {}
    if (Object.keys(rolePatch).length) patch.roles = rolePatch
    if (Object.keys(advisorPatch).length) patch.advisor = advisorPatch
    try {
      const next = await agentConfig.set(patch, harness)
      setConfig(next)
      setRoles(next.roles)
      setAdvisor(next.advisor)
      setSaved(true)
    } catch (error) {
      setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <section className="settings-group">
        <div className="settings-group__heading">
          <h2>Model roles</h2>
          {editable ? (
            <span className="shortcut-choice">
              <button type="button" className="button button--compact" disabled={!dirty || saving} onClick={revert}>Discard</button>
              <button type="button" className="button button--compact button--primary" disabled={!dirty || saving} onClick={() => { void save() }}>
                {saving ? <><RefreshCw className="spin" size={13} />Saving…</> : 'Save model roles'}
              </button>
            </span>
          ) : null}
        </div>
        <p className="settings-group__description">
          {agentName} assigns each turn a role and resolves that role to a model. These values are read from and written to {agentName}&apos;s own global configuration, so changes apply to {agentName} everywhere, not only inside GooeyPi. Project-level overrides are not shown or changed here.
        </p>
        {loadError ? <p className="settings-error" role="alert">{loadError}</p> : null}
        {config?.warning ? <p className="settings-error" role="alert">{config.warning}</p> : null}
        {!config && !loadError ? <p className="settings-empty">Reading {agentName} configuration…</p> : null}
        {editable ? AGENT_MODEL_ROLES.map((role) => (
          <ModelRoleRow key={role} role={role} selector={roles[role] ?? ''} catalog={catalog} disabled={saving} onChange={changeRole} />
        )) : null}
        {editable && !catalog ? <p className="settings-group__description">The {agentName} model catalog has not loaded yet, so model choices are unavailable.</p> : null}
        {saveError ? <p className="settings-error" role="alert">{saveError}</p> : null}
        {saved && !dirty ? <p className="settings-group__description" role="status">Saved to {agentName} configuration.</p> : null}
      </section>
      {editable && advisor ? (
        <section className="settings-group">
          <h2>Advisor</h2>
          <p className="settings-group__description">
            The advisor pairs a second model, assigned to the Advisor role above, that reviews each turn and injects notes. Saving uses the same Save button as model roles.
          </p>
          <SettingsToggle
            checked={advisor.enabled}
            onChange={(enabled) => changeAdvisor({ enabled })}
            label="Enable the advisor"
            description="Pair a reviewer model that passively reviews each turn and injects notes."
          />
          <SettingsToggle
            checked={advisor.subagents}
            onChange={(subagents) => changeAdvisor({ subagents })}
            label="Advise subagents too"
            description="Also run the advisor on spawned task and eval subagents."
          />
          <label className="settings-row">
            <span><strong>Catch-up threshold</strong><small>Pause the main agent briefly when the advisor falls this many turns behind.</small></span>
            <select
              value={advisor.syncBacklog}
              disabled={saving}
              onChange={(event) => changeAdvisor({ syncBacklog: event.target.value as AdvisorSyncBacklog })}
            >
              {ADVISOR_SYNC_BACKLOGS.map((value) => <option key={value} value={value}>{SYNC_BACKLOG_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="settings-row">
            <span><strong>Immune turns</strong><small>After an advisor interruption, route further concerns non-interruptingly for this many turns.</small></span>
            <input
              type="number"
              min={0}
              max={ADVISOR_MAX_IMMUNE_TURNS}
              step={1}
              value={advisor.immuneTurns}
              disabled={saving}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (Number.isInteger(parsed) && parsed >= 0 && parsed <= ADVISOR_MAX_IMMUNE_TURNS) changeAdvisor({ immuneTurns: parsed })
              }}
            />
          </label>
        </section>
      ) : null}
    </>
  )
}

interface ModelRoleRowProps {
  role: AgentModelRole
  selector: string
  catalog: PrimeModelCatalog | null
  disabled: boolean
  onChange(role: AgentModelRole, key: string, thinkingLevel: PrimeThinkingLevel | ''): void
}

function ModelRoleRow({ role, selector, catalog, disabled, onChange }: ModelRoleRowProps) {
  const parsed = catalog ? parseModelRoleSelector(selector, catalog) : null
  // An unresolved selector is shown verbatim rather than silently rewritten to
  // some other model the operator never chose.
  const modelKey = parsed?.key ?? selector
  const thinkingLevel = parsed?.thinkingLevel ?? ''
  const model = catalog?.models.find((candidate) => candidate.key === modelKey)
  const levels = model?.availableThinkingLevels ?? []
  const providers = useMemo(() => {
    const grouped = new Map<string, PrimeModelCatalog['models']>()
    for (const candidate of catalog?.models ?? []) {
      if (candidate.enabled === false) continue
      const bucket = grouped.get(candidate.provider)
      if (bucket) bucket.push(candidate)
      else grouped.set(candidate.provider, [candidate])
    }
    return [...grouped]
  }, [catalog])
  const { title, description } = ROLE_LABELS[role]

  return (
    <label className="settings-row">
      <span><strong>{title}</strong><small>{description}</small></span>
      <span className="model-role-choice">
        <select
          aria-label={`${title} model`}
          value={modelKey}
          disabled={disabled || !catalog}
          // Switching model drops a thinking level the new model does not offer.
          onChange={(event) => {
            const nextKey = event.target.value
            const next = catalog?.models.find((candidate) => candidate.key === nextKey)
            const keptLevel = thinkingLevel && next?.availableThinkingLevels.includes(thinkingLevel) ? thinkingLevel : ''
            onChange(role, nextKey, keptLevel)
          }}
        >
          {!selector ? <option value="">Not set</option> : null}
          {modelKey && !model ? <option value={modelKey}>{modelKey} (not in catalog)</option> : null}
          {providers.map(([provider, models]) => (
            <optgroup key={provider} label={provider}>
              {models.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}
            </optgroup>
          ))}
        </select>
        <select
          aria-label={`${title} thinking level`}
          value={thinkingLevel}
          disabled={disabled || !modelKey || !levels.length}
          onChange={(event) => onChange(role, modelKey, event.target.value as PrimeThinkingLevel | '')}
        >
          <option value="">Harness default</option>
          {levels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </span>
    </label>
  )
}
