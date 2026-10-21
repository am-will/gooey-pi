import { Bot, LockKeyhole } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { SettingsSectionProps } from './contracts'

export function PrivacySettings(_props: SettingsSectionProps) {
  const { t } = useI18n()
  return (
    <>
      <header><h1>{t('settings.privacy')}</h1><p>{t('settings.privacy.description')}</p></header>
      <section className="settings-group">
        <h2>{t('settings.privacy.localData.title')}</h2>
        <div className="info-row"><LockKeyhole size={15} /><div><strong>{t('settings.privacy.localData.label')}</strong><small>{t('settings.privacy.localData.description')}</small></div></div>
      </section>
      <section className="settings-group">
        <h2>{t('settings.privacy.requests.title')}</h2>
        <div className="info-row"><Bot size={15} /><div><strong>{t('settings.privacy.requests.label')}</strong><small>{t('settings.privacy.requests.description')}</small></div></div>
      </section>
    </>
  )
}
