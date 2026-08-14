import { Check, Laptop, Moon, Sun } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { InterfaceFontScale, ThemeMode } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const themes: Array<{ id: ThemeMode; label: string; icon: typeof Sun }> = [
  { id: 'system', label: 'System', icon: Laptop },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

const fontScales: Array<{ value: InterfaceFontScale; label: string }> = [
  { value: 105, label: 'Smaller' },
  { value: 110, label: 'Default' },
  { value: 115, label: 'Larger' },
]

/** Arrow/Home/End movement inside a radio group selects as it moves. */
function nextScaleIndex(key: string, current: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function AppearanceSettings({ settings, onUpdate }: SettingsSectionProps) {
  const selectedScale = Math.max(0, fontScales.findIndex((option) => option.value === settings.interfaceFontScale))
  const onScaleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextScaleIndex(event.key, selectedScale, fontScales.length)
    if (next === null) return
    event.preventDefault()
    const target = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]
    target?.focus()
    void onUpdate({ interfaceFontScale: fontScales[next].value })
  }
  return (
    <>
      <header><h1>Appearance</h1><p>Keep the workspace comfortable in any environment.</p></header>
      <section className="settings-group">
        <h2>Theme</h2>
        <div className="theme-options">
          {themes.map((item) => {
            const Icon = item.icon
            return (
              <button type="button" key={item.id} className={settings.theme === item.id ? 'is-active' : ''} onClick={() => { void onUpdate({ theme: item.id }) }}>
                <span><Icon size={17} /></span><strong>{item.label}</strong>{settings.theme === item.id ? <Check size={13} /> : null}
              </button>
            )
          })}
        </div>
      </section>
      <section className="settings-group">
        <h2>Text size</h2>
        <div className="settings-row settings-row--text-size">
          <span><strong>Interface text</strong><small>Increase readability while keeping the workspace proportions intact.</small></span>
          <div className="text-size-options" role="radiogroup" aria-label="Interface text size" onKeyDown={onScaleKeyDown}>
            {fontScales.map((option, index) => (
              <button
                type="button"
                key={option.value}
                role="radio"
                aria-checked={settings.interfaceFontScale === option.value}
                tabIndex={index === selectedScale ? 0 : -1}
                className={settings.interfaceFontScale === option.value ? 'is-active' : ''}
                onClick={() => { void onUpdate({ interfaceFontScale: option.value }) }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>Motion</h2>
        <SettingsToggle checked={settings.reduceMotion} onChange={(reduceMotion) => { void onUpdate({ reduceMotion }) }} label="Reduce interface motion" description="Minimize panel transitions and animated status indicators." />
      </section>
    </>
  )
}
