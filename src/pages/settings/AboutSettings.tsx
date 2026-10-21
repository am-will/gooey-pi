import { CircleHelp } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { GooeyPiMark } from '@/components/ui'
import type { AppMeta } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  onOpenDocs(): void
}

export function AboutSettings({ meta, onOpenDocs }: AboutSettingsProps) {
  const { t } = useI18n()
  return (
    <>
      <header><h1>{t('settings.about.title')}</h1><p>{t('settings.about.description')}</p></header>
      <section className="about-card"><GooeyPiMark size={48} /><div><h2>GooeyPi</h2><p>{t('settings.about.version', { version: meta?.version ?? '0.1.0' })}</p></div></section>
      <section className="settings-group">
        <div className="settings-row"><span><strong>{t('settings.about.platform.label')}</strong><small>{meta?.platform ?? 'macOS'}</small></span></div>
        <div className="settings-row"><span><strong>{t('settings.about.homeDir.label')}</strong><small className="mono">{meta?.homeDir ?? '—'}</small></span></div>
        <div className="settings-row"><span><strong>{t('settings.about.docs.label')}</strong></span><button className="button" type="button" onClick={onOpenDocs}><CircleHelp size={13} /> {t('settings.about.docs.open')}</button></div>
      </section>
    </>
  )
}
