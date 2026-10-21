import { useI18n, type MessageKey } from '@/lib/i18n'
import type { AppSettings } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

// Option tables carry keys so the English text stays in the catalog only.
const checkoutStrategies: Array<{ value: AppSettings['checkoutStrategy']; label: MessageKey }> = [
  { value: 'worktree', label: 'settings.general.checkout.worktrees' },
  { value: 'branch', label: 'settings.general.checkout.branches' },
]

const inspectorTabs: Array<{ value: AppSettings['defaultInspectorTab']; label: MessageKey }> = [
  { value: 'summary', label: 'settings.general.inspectorTab.summary' },
  { value: 'changes', label: 'settings.general.inspectorTab.changes' },
  { value: 'browser', label: 'settings.general.inspectorTab.browser' },
  { value: 'files', label: 'settings.general.inspectorTab.files' },
]

export function GeneralSettings({ settings, onUpdate, platform }: SettingsSectionProps & { platform: NodeJS.Platform }) {
  const { t } = useI18n()
  return (
    <>
      <header><h1>{t('settings.general')}</h1><p>{t('settings.general.description')}</p></header>
      <section className="settings-group">
        <h2>{t('settings.general.window.title')}</h2>
        <SettingsToggle checked={settings.sidebarOpen} onChange={(sidebarOpen) => { void onUpdate({ sidebarOpen }) }} label={t('settings.general.sidebar.label')} description={t('settings.general.sidebar.description')} />
        <SettingsToggle checked={settings.inspectorOpen} onChange={(inspectorOpen) => { void onUpdate({ inspectorOpen }) }} label={t('settings.general.inspector.label')} description={t('settings.general.inspector.description')} />
        <SettingsToggle checked={settings.showFileChangesPopup} onChange={(showFileChangesPopup) => { void onUpdate({ showFileChangesPopup }) }} label={t('settings.general.fileChanges.label')} description={t('settings.general.fileChanges.description')} />
      </section>
      {platform === 'darwin' ? (
        <section className="settings-group">
          <h2>{t('settings.general.startup.title')}</h2>
          <SettingsToggle checked={settings.keepRunningInBackground} onChange={(keepRunningInBackground) => { void onUpdate({ keepRunningInBackground }) }} label={t('settings.general.background.label')} description={t('settings.general.background.description')} />
          <SettingsToggle checked={settings.launchAtLogin} onChange={(launchAtLogin) => { void onUpdate({ launchAtLogin }) }} label={t('settings.general.launchAtLogin.label')} description={t('settings.general.launchAtLogin.description')} />
        </section>
      ) : null}
      <section className="settings-group">
        <h2>{t('settings.general.sessions.title')}</h2>
        <label className="settings-row">
          <span><strong>{t('settings.general.checkout.label')}</strong><small>{t('settings.general.checkout.description')}</small></span>
          <select value={settings.checkoutStrategy} onChange={(event) => {
            const checkoutStrategy = event.target.value
            if (checkoutStrategy === 'worktree' || checkoutStrategy === 'branch') void onUpdate({ checkoutStrategy })
          }}>
            {checkoutStrategies.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
          </select>
        </label>
        <label className="settings-row">
          <span><strong>{t('settings.general.inspectorTab.label')}</strong><small>{t('settings.general.inspectorTab.description')}</small></span>
          <select value={settings.defaultInspectorTab} onChange={(event) => { void onUpdate({ defaultInspectorTab: event.target.value as AppSettings['defaultInspectorTab'] }) }}>
            {inspectorTabs.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
          </select>
        </label>
      </section>
    </>
  )
}
