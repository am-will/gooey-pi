import { Bot, LockKeyhole } from 'lucide-react'
import type { SettingsSectionProps } from './contracts'

export function PrivacySettings(_props: SettingsSectionProps) {
  return (
    <>
      <header><h1>Privacy</h1><p>Understand how GooeyPi stores settings and connects to agents.</p></header>
      <section className="settings-group">
        <h2>Local data</h2>
        <div className="info-row"><LockKeyhole size={15} /><div><strong>Settings stay on this device</strong><small>Project metadata and interface settings are stored locally on this device.</small></div></div>
      </section>
      <section className="settings-group">
        <h2>Agent requests</h2>
        <div className="info-row"><Bot size={15} /><div><strong>Requests use your selected agent</strong><small>Session requests follow the selected agent and its provider configuration.</small></div></div>
      </section>
    </>
  )
}
