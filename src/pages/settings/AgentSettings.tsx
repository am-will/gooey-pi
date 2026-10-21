import { Bot, Keyboard, RefreshCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { HARNESS_IDS, OMP_APPROVAL_MODES, type HarnessId, type HarnessStatus, type OmpApprovalMode } from '@/types/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES } from '@/lib/harness'
import { PRIME_IMPLEMENTATION_LABELS, primeUnavailableCapabilitiesNotice } from '@/lib/prime-compat'
import { detectRendererPlatform, shortcutLabel } from '@/lib/platform-shortcuts'
import type { SettingsMetaSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

const APPROVAL_MODE_LABELS: Record<OmpApprovalMode, MessageKey> = {
  'inherit': 'settings.agent.approval.inherit',
  'always-ask': 'settings.agent.approval.alwaysAsk',
  'write': 'settings.agent.approval.write',
  'yolo': 'settings.agent.approval.yolo',
}

/** Version and, for Prime, the detected implementation: "v0.10.0 · Rust". */
function runtimeBadge(status: HarnessStatus | undefined): string | undefined {
  const parts = [status?.version ? `v${status.version}` : '', status?.implementation ? PRIME_IMPLEMENTATION_LABELS[status.implementation] : '']
  return parts.filter(Boolean).join(' · ') || undefined
}

export function AgentSettings({ settings, meta, onUpdate, onRefreshHarnesses }: SettingsMetaSectionProps) {
  const { t } = useI18n()
  const activeHarness = settings.activeHarness
  const detectedHarnesses = HARNESS_IDS.filter((harness) => Boolean(meta?.harnesses[harness].path))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const platform = meta?.platform ?? detectRendererPlatform()
  const oppositeActionShortcut = shortcutLabel(platform, ['Primary', 'Enter'])
  const newLineShortcut = shortcutLabel(platform, ['Shift', 'Enter'])
  const refreshHarnesses = async () => {
    if (refreshing) return
    setRefreshing(true)
    setRefreshError('')
    try { await onRefreshHarnesses() } catch (error) { setRefreshError(errorMessage(error)) }
    finally { setRefreshing(false) }
  }
  const runtimePathValidation = (value: string, harness: HarnessId): string => {
    if (!value) return ''
    const absolute = meta?.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') : value.startsWith('/')
    return absolute ? '' : t('settings.agent.runtime.pathError', { name: HARNESS_AGENT_NAMES[harness] })
  }
  return (
    <>
      <header><h1>{t('settings.harness')}</h1><p>{t('settings.agent.description')}</p></header>
      <section className="settings-group">
        <h2>{t('settings.harness')}</h2>
        <label className="settings-row">
          <span><strong>{t('settings.agent.defaultHarness.label')}</strong><small>{t('settings.agent.defaultHarness.description')}</small></span>
          <select value={detectedHarnesses.includes(activeHarness) ? activeHarness : ''} disabled={!detectedHarnesses.length} onChange={(event) => { void onUpdate({ activeHarness: event.target.value as HarnessId }) }}>
            {!detectedHarnesses.length ? <option value="">{t('settings.agent.defaultHarness.none')}</option> : null}
            {detectedHarnesses.map((harness) => <option key={harness} value={harness}>{HARNESS_PRODUCT_NAMES[harness]}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <span><strong>{t('settings.agent.approval.label')}</strong><small>{t('settings.agent.approval.description')}</small></span>
          <select value={settings.ompApprovalMode} onChange={(event) => { void onUpdate({ ompApprovalMode: event.target.value as OmpApprovalMode }) }}>
            {OMP_APPROVAL_MODES.map((mode) => <option key={mode} value={mode}>{t(APPROVAL_MODE_LABELS[mode])}</option>)}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <div className="settings-group__heading">
          <h2>{t('settings.agent.runtime.title')}</h2>
          <button type="button" className="button button--compact" disabled={refreshing} onClick={() => { void refreshHarnesses() }}>
            <RefreshCw className={refreshing ? 'spin' : ''} size={13} />{refreshing ? t('settings.agent.runtime.refreshing') : t('settings.agent.runtime.refresh')}
          </button>
        </div>
        {refreshError ? <p className="settings-error" role="alert">{refreshError}</p> : null}
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_AGENT_NAMES[harness]
          const status = meta?.harnesses[harness]
          const badge = runtimeBadge(status)
          const unavailable = primeUnavailableCapabilitiesNotice(status?.implementation)
          return (
            <div className="runtime-card" key={harness}>
              <span className={status?.path ? 'is-online' : ''}><Bot size={17} /></span>
              <div>
                <strong>{status?.path ? t('settings.agent.runtime.ready', { name }) : t('settings.agent.runtime.notDetected', { name })}</strong>
                <small title={status?.problem ? `${status.problem.path}: ${status.problem.reason}` : undefined}>{status?.path ?? (status?.problem ? `${status.problem.path}: ${status.problem.reason}` : t('settings.agent.runtime.install', { name }))}</small>
                {unavailable ? <small className="runtime-card__limits">{unavailable}</small> : null}
              </div>
              {badge ? <code>{badge}</code> : null}
            </div>
          )
        })}
        <p className="settings-group__description">{t('settings.agent.runtime.description')}</p>
        {HARNESS_IDS.map((harness) => <DraftSettingField
          key={harness}
          id={`runtime-path-${harness}`}
          label={t('settings.agent.runtime.pathLabel', { name: HARNESS_AGENT_NAMES[harness] })}
          description={t('settings.agent.runtime.pathDescription')}
          committedValue={settings.runtimePaths[harness]}
          validate={(value) => runtimePathValidation(value.trim(), harness)}
          normalize={(value) => value.trim()}
          onCommit={async (value) => {
            await onUpdate({ runtimePaths: { ...settings.runtimePaths, [harness]: value } })
            await refreshHarnesses()
          }}
        />)}
      </section>
      <section className="settings-group">
        <h2>{t('settings.agent.transcript.title')}</h2>
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label={t('settings.agent.transcript.reasoning.label')} description={t('settings.agent.transcript.reasoning.description')} />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label={t('settings.agent.transcript.toolCalls.label')} description={t('settings.agent.transcript.toolCalls.description')} />
      </section>
      <section className="settings-group">
        <h2>{t('settings.agent.shortcuts.title')}</h2>
        <label className="settings-row">
          <span><strong>{t('settings.agent.shortcuts.enterLabel')}</strong><small>{t('settings.agent.shortcuts.enterDescription', { opposite: oppositeActionShortcut, newLine: newLineShortcut })}</small></span>
          <span className="shortcut-choice" role="radiogroup" aria-label={t('settings.agent.shortcuts.enterAria')}>
            {(['queue', 'steer'] as const).map((action) => <button key={action} type="button" className={`button button--compact ${settings.messageEnterAction === action ? 'is-active' : ''}`} role="radio" aria-checked={settings.messageEnterAction === action} onClick={() => { void onUpdate({ messageEnterAction: action }) }}>{action === 'queue' ? t('settings.agent.shortcuts.queue') : t('settings.agent.shortcuts.steer')}</button>)}
          </span>
        </label>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? t('settings.agent.shortcuts.queueMessage') : t('settings.agent.shortcuts.steerTurn')}</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? t('settings.agent.shortcuts.steerTurn') : t('settings.agent.shortcuts.queueMessage')}</span><kbd>{oppositeActionShortcut}</kbd></div>
      </section>
      <section className="settings-group">
        <h2>{t('settings.agent.permissions.title')}</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>{t('settings.agent.permissions.workspace.label')}</strong><small>{t('settings.agent.permissions.workspace.description')}</small></div></div>
      </section>
    </>
  )
}
