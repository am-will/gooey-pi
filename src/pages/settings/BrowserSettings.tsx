import { RotateCcw } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { SettingsSectionProps } from './contracts'
import { browserHomeValidation, normalizeBrowserHome } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

interface BrowserSettingsProps extends SettingsSectionProps {
  onRequestReset(): void
}

export function BrowserSettings({ settings, onUpdate, onRequestReset }: BrowserSettingsProps) {
  const { t } = useI18n()
  return (
    <>
      <header><h1>{t('settings.browser')}</h1><p>{t('settings.browser.description')}</p></header>
      <section className="settings-group">
        <h2>{t('settings.browser.startup.title')}</h2>
        <DraftSettingField
          id="browser-home"
          label={t('settings.browser.home.label')}
          description={t('settings.browser.home.description')}
          committedValue={settings.browserHome}
          validate={browserHomeValidation}
          normalize={normalizeBrowserHome}
          onCommit={(browserHome) => onUpdate({ browserHome })}
        />
        <SettingsToggle checked={settings.browserAskForDownloads} onChange={(browserAskForDownloads) => { void onUpdate({ browserAskForDownloads }) }} label={t('settings.browser.downloads.label')} description={t('settings.browser.downloads.description')} />
      </section>
      <section className="settings-group">
        <h2>{t('settings.browser.data.title')}</h2>
        <div className="danger-row">
          <span><strong>{t('settings.page.clearBrowserAction')}</strong><small>{t('settings.browser.data.description')}</small></span>
          <button type="button" className="button" onClick={onRequestReset}><RotateCcw size={13} /> {t('settings.browser.data.clear')}</button>
        </div>
      </section>
    </>
  )
}
