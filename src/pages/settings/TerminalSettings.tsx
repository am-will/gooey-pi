import { Keyboard } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { SettingsSectionProps } from './contracts'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { terminalShellValidation } from './draft-state'
import { DraftSettingField } from './DraftSettingField'
import { SettingsToggle } from './SettingsToggle'

export function TerminalSettings({ settings, onUpdate, platform = 'darwin' }: SettingsSectionProps & { platform?: NodeJS.Platform }) {
  const { t } = useI18n()
  return (
    <>
      <header><h1>{t('settings.terminal')}</h1><p>{t('settings.terminal.description')}</p></header>
      <section className="settings-group">
        <h2>{t('settings.terminal.shell.title')}</h2>
        <DraftSettingField
          id="terminal-shell"
          label={t('settings.terminal.shell.label')}
          description={t('settings.terminal.shell.description')}
          committedValue={settings.terminalShell}
          validate={terminalShellValidation}
          onCommit={(terminalShell) => onUpdate({ terminalShell })}
          className="mono"
        />
        <SettingsToggle checked={settings.terminalOpen} onChange={(terminalOpen) => { void onUpdate({ terminalOpen }) }} label={t('settings.terminal.openWithSessions.label')} description={t('settings.terminal.openWithSessions.description')} />
      </section>
      <section className="settings-group">
        <h2>{t('settings.terminal.shortcut.title')}</h2>
        <div className="shortcut-row"><span><Keyboard size={14} />{t('settings.terminal.shortcut.toggle')}</span><kbd>{shortcutLabel(platform, ['Primary', 'J'])}</kbd></div>
      </section>
    </>
  )
}
