import { CircleHelp } from 'lucide-react'
import { GooeyPiMark } from '@/components/ui'
import type { AppMeta } from '@/types/api'

interface AboutSettingsProps {
  meta?: AppMeta | null
  onOpenDocs(): void
}

export function AboutSettings({ meta, onOpenDocs }: AboutSettingsProps) {
  return (
    <>
      <header><h1>About GooeyPi</h1><p>A playful desktop workspace for Pi, OMP, and Prime Agent.</p></header>
      <section className="about-card"><GooeyPiMark size={48} /><div><h2>GooeyPi</h2><p>Pi + OMP + Prime Agent workspace · Version {meta?.version ?? '0.1.0'}</p></div></section>
      <section className="settings-group">
        <div className="settings-row"><span><strong>Platform</strong><small>{meta?.platform ?? 'macOS'}</small></span></div>
        <div className="settings-row"><span><strong>Home directory</strong><small className="mono">{meta?.homeDir ?? '—'}</small></span></div>
        <div className="settings-row"><span><strong>Help and documentation</strong></span><button className="button" type="button" onClick={onOpenDocs}><CircleHelp size={13} /> Open docs</button></div>
      </section>
    </>
  )
}
