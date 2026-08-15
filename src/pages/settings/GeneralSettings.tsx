import type { AppSettings } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

export function GeneralSettings({ settings, onUpdate, platform }: SettingsSectionProps & { platform: NodeJS.Platform }) {
  return (
    <>
      <header><h1>General</h1><p>Choose how GooeyPi behaves across projects.</p></header>
      <section className="settings-group">
        <h2>Window</h2>
        <SettingsToggle checked={settings.sidebarOpen} onChange={(sidebarOpen) => { void onUpdate({ sidebarOpen }) }} label="Show project sidebar" description="Keep projects and sessions visible when the app opens." />
        <SettingsToggle checked={settings.inspectorOpen} onChange={(inspectorOpen) => { void onUpdate({ inspectorOpen }) }} label="Open session inspector" description="Show the summary pane for newly opened sessions." />
        <SettingsToggle checked={settings.showFileChangesPopup} onChange={(showFileChangesPopup) => { void onUpdate({ showFileChangesPopup }) }} label="Show file changes popup" description="Show the review card above the composer when the workspace has uncommitted changes." />
      </section>
      {platform === 'darwin' ? (
        <section className="settings-group">
          <h2>Startup &amp; background</h2>
          <SettingsToggle checked={settings.keepRunningInBackground} onChange={(keepRunningInBackground) => { void onUpdate({ keepRunningInBackground }) }} label="Keep GooeyPi running after closing the window" description="Keep scheduled work running from the menu bar until you quit GooeyPi." />
          <SettingsToggle checked={settings.launchAtLogin} onChange={(launchAtLogin) => { void onUpdate({ launchAtLogin }) }} label="Launch GooeyPi at login" description="Start GooeyPi in the background when you log in to this Mac." />
        </section>
      ) : null}
      <section className="settings-group">
        <h2>Session defaults</h2>
        <label className="settings-row">
          <span><strong>Default inspector tab</strong><small>The first detail surface shown in a session.</small></span>
          <select value={settings.defaultInspectorTab} onChange={(event) => { void onUpdate({ defaultInspectorTab: event.target.value as AppSettings['defaultInspectorTab'] }) }}>
            <option value="summary">Summary</option>
            <option value="changes">Changes</option>
            <option value="browser">Browser</option>
            <option value="files">Files</option>
          </select>
        </label>
      </section>
    </>
  )
}
