import { Bot, ExternalLink, Keyboard, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useState } from 'react'
import { HARNESS_IDS, OMP_APPROVAL_MODES, type HarnessChangelog, type HarnessId, type OmpApprovalMode } from '@/types/api'
import { errorMessage } from '@/lib/errors'
import { HARNESS_AGENT_NAMES, HARNESS_PRODUCT_NAMES } from '@/lib/harness'
import { detectRendererPlatform, shortcutLabel } from '@/lib/platform-shortcuts'
import { useHarnessUpdates } from '@/hooks/useHarnessUpdates'
import { MarkdownText } from '@/components/MarkdownText'
import { Modal } from '@/components/ui'
import type { SettingsMetaSectionProps } from './contracts'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

const hasBridge = () => typeof window !== 'undefined' && typeof window.prime !== 'undefined'

const OMP_RELEASES_URL = 'https://github.com/can1357/oh-my-pi/releases'
const SAFE_VERSION = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/

const APPROVAL_MODE_LABELS: Record<OmpApprovalMode, string> = {
  'inherit': 'Inherit omp config',
  'always-ask': 'Always ask',
  'write': 'Prompt for exec only (write)',
  'yolo': 'YOLO (never prompt)',
}

export function AgentSettings({ settings, meta, onUpdate, onRefreshHarnesses }: SettingsMetaSectionProps) {
  const activeHarness = settings.activeHarness
  const detectedHarnesses = HARNESS_IDS.filter((harness) => Boolean(meta?.harnesses[harness].path))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [updateError, setUpdateError] = useState('')
  const [whatsNew, setWhatsNew] = useState<HarnessChangelog | null>(null)
  const reportUpdateError = useCallback((error: unknown) => setUpdateError(errorMessage(error)), [])
  const bridge = hasBridge() ? window.prime : null
  const harnessUpdates = useHarnessUpdates(bridge, reportUpdateError)
  const openWhatsNew = useCallback(async (sinceVersion?: string) => {
    if (!bridge) return
    try {
      const notes = await bridge.harnessUpdates.changelog('pi', sinceVersion || undefined)
      if (notes) setWhatsNew(notes)
      else setUpdateError('No release notes were found in the installed Pi package.')
    } catch (error) { setUpdateError(errorMessage(error)) }
  }, [bridge])
  const closeWhatsNew = useCallback(() => {
    if (whatsNew) void onUpdate({ lastSeenHarnessNotes: { ...settings.lastSeenHarnessNotes, pi: whatsNew.toVersion } })
    setWhatsNew(null)
  }, [whatsNew, onUpdate, settings.lastSeenHarnessNotes])
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
    return absolute ? '' : `${HARNESS_AGENT_NAMES[harness]} path must be absolute (or blank for automatic discovery)`
  }
  return (
    <>
      <header><h1>Harness</h1><p>Runtime discovery, model providers, and workspace permissions.</p></header>
      <section className="settings-group">
        <h2>Harness</h2>
        <label className="settings-row">
          <span><strong>Default harness</strong><small>The harness opened by default; mirrors the current choice in the Harness menu.</small></span>
          <select value={detectedHarnesses.includes(activeHarness) ? activeHarness : ''} disabled={!detectedHarnesses.length} onChange={(event) => { void onUpdate({ activeHarness: event.target.value as HarnessId }) }}>
            {!detectedHarnesses.length ? <option value="">No harness detected</option> : null}
            {detectedHarnesses.map((harness) => <option key={harness} value={harness}>{HARNESS_PRODUCT_NAMES[harness]}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <span><strong>OMP approval mode</strong><small>How OMP asks before running tools; Inherit leaves your omp configuration in charge.</small></span>
          <select value={settings.ompApprovalMode} onChange={(event) => { void onUpdate({ ompApprovalMode: event.target.value as OmpApprovalMode }) }}>
            {OMP_APPROVAL_MODES.map((mode) => <option key={mode} value={mode}>{APPROVAL_MODE_LABELS[mode]}</option>)}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <div className="settings-group__heading">
          <h2>Runtime</h2>
          <button type="button" className="button button--compact" disabled={refreshing} onClick={() => { void refreshHarnesses() }}>
            <RefreshCw className={refreshing ? 'spin' : ''} size={13} />{refreshing ? 'Refreshing…' : 'Refresh harnesses'}
          </button>
        </div>
        {refreshError ? <p className="settings-error" role="alert">{refreshError}</p> : null}
        {updateError ? <p className="settings-error" role="alert">{updateError}</p> : null}
        {HARNESS_IDS.map((harness) => {
          const name = HARNESS_AGENT_NAMES[harness]
          const status = meta?.harnesses[harness]
          const updateState = settings.harnessUpdateChecks ? harnessUpdates.states?.[harness] : undefined
          const hasUnseenNotes = harness === 'pi' && Boolean(status?.version && SAFE_VERSION.test(status.version))
            && settings.lastSeenHarnessNotes.pi !== status?.version
          return (
            <div className="runtime-card" key={harness}>
              <span className={status?.path ? 'is-online' : ''}><Bot size={17} /></span>
              <div>
                <strong>{status?.path ? `${name} is ready` : `${name} not detected`}</strong>
                <small>{status?.path ?? `Install ${name}, then refresh harnesses.`}</small>
              </div>
              {status?.version ? <code>v{status.version}</code> : null}
              {hasUnseenNotes ? (
                <button type="button" className="button button--compact" onClick={() => { void openWhatsNew(settings.lastSeenHarnessNotes.pi) }}>What’s new</button>
              ) : null}
              {updateState?.phase === 'available' ? (
                <>
                  {harness === 'omp' ? (
                    <button type="button" className="button button--compact" onClick={() => { void bridge?.app.openExternal(OMP_RELEASES_URL) }}>
                      <ExternalLink size={13} />Release notes
                    </button>
                  ) : null}
                  <button type="button" className="button button--compact" onClick={() => {
                    setUpdateError('')
                    const previousVersion = updateState.installedVersion
                    void harnessUpdates.update(harness).then(async (result) => {
                      if (result?.phase === 'error') setUpdateError(result.message ?? `The ${name} update failed.`)
                      // The main process already re-ran discovery; pull the
                      // refreshed meta so the version badge updates.
                      await onRefreshHarnesses()
                      if (harness === 'pi' && result && result.phase !== 'error') await openWhatsNew(previousVersion)
                    })
                  }}>Update to v{updateState.latestVersion}</button>
                </>
              ) : updateState?.phase === 'updating' ? (
                <button type="button" className="button button--compact" disabled>Updating…</button>
              ) : updateState?.phase === 'error' && updateState.message ? (
                <small className="settings-error">{updateState.message}</small>
              ) : null}
            </div>
          )
        })}
        <p className="settings-group__description">Discovery checks a saved override first, then the harness environment variable, bundled files, PATH, and standard install directories. Refreshing updates future sessions without restarting GooeyPi.</p>
        <SettingsToggle
          checked={settings.harnessUpdateChecks}
          onChange={(harnessUpdateChecks) => {
            void (async () => {
              await onUpdate({ harnessUpdateChecks })
              // The check reads the persisted toggle, so it must run after the
              // settings update lands.
              await harnessUpdates.check(true)
            })()
          }}
          label="Check for harness updates"
          description="Offers one-click updates through each harness's own updater: Pi is compared against its npm registry entry, OMP answers through omp update --check. Prime Agent is not yet supported."
        />
        {HARNESS_IDS.map((harness) => <DraftSettingField
          key={harness}
          id={`runtime-path-${harness}`}
          label={`${HARNESS_AGENT_NAMES[harness]} executable override`}
          description="Optional absolute path. Leave blank to keep automatic discovery."
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
        <h2>Transcript</h2>
        <SettingsToggle checked={settings.showReasoningSummaries} onChange={(showReasoningSummaries) => { void onUpdate({ showReasoningSummaries }) }} label="Show reasoning summaries" description="Display reasoning summaries and traces while an agent works. Completed work stays collapsed." />
        <SettingsToggle checked={settings.showToolCalls} onChange={(showToolCalls) => { void onUpdate({ showToolCalls }) }} label="Show tool calls" description="Display compact tool activity, arguments, and expandable results." />
      </section>
      <section className="settings-group">
        <h2>Message shortcuts</h2>
        <label className="settings-row">
          <span><strong>Primary Enter action while an agent is working</strong><small>{oppositeActionShortcut} always uses the opposite action. {newLineShortcut} adds a new line.</small></span>
          <span className="shortcut-choice" role="radiogroup" aria-label="Primary Enter action">
            {(['queue', 'steer'] as const).map((action) => <button key={action} type="button" className={`button button--compact ${settings.messageEnterAction === action ? 'is-active' : ''}`} role="radio" aria-checked={settings.messageEnterAction === action} onClick={() => { void onUpdate({ messageEnterAction: action }) }}>{action === 'queue' ? 'Queue' : 'Steer'}</button>)}
          </span>
        </label>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? 'Queue message' : 'Steer current turn'}</span><kbd>Enter</kbd></div>
        <div className="shortcut-row"><span><Keyboard size={14} />{settings.messageEnterAction === 'queue' ? 'Steer current turn' : 'Queue message'}</span><kbd>{oppositeActionShortcut}</kbd></div>
      </section>
      <section className="settings-group">
        <h2>Permissions</h2>
        <div className="info-row"><ShieldCheck size={15} /><div><strong>Workspace access</strong><small>The active agent only receives the project folders attached to a session.</small></div></div>
      </section>
      {whatsNew ? (
        <Modal title={`What’s new in Pi ${whatsNew.toVersion}`} onClose={closeWhatsNew}>
          <div className="whats-new"><MarkdownText text={whatsNew.markdown} /></div>
        </Modal>
      ) : null}
    </>
  )
}
