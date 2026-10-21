import { Check, Laptop, Moon, Sun } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { LOCALE_PREFERENCES, type InterfaceFontScale, type LocalePreference, type ThemeMode } from '@/types/api'
import type { SettingsSectionProps } from './contracts'
import { SettingsToggle } from './SettingsToggle'

const themes: Array<{ id: ThemeMode; label: MessageKey; icon: typeof Sun }> = [
  { id: 'system', label: 'appearance.theme.system', icon: Laptop },
  { id: 'light', label: 'appearance.theme.light', icon: Sun },
  { id: 'dark', label: 'appearance.theme.dark', icon: Moon },
]

const fontScales: Array<{ value: InterfaceFontScale; label: MessageKey }> = [
  { value: 105, label: 'appearance.text.smaller' },
  { value: 110, label: 'appearance.text.default' },
  { value: 115, label: 'appearance.text.larger' },
]

// Language names are endonyms: every option is written in its own language, so a
// user who cannot read the current interface language can still find their own
// and switch back. Only the system entry is translated, because it names a
// behaviour rather than a language. Adding a locale to LOCALE_PREFERENCES is a
// compile error until its endonym is listed here.
type SwitchableLocale = Exclude<LocalePreference, 'system'>
const localeEndonyms = {
  en: 'English',
  'zh-CN': '简体中文',
  ja: '日本語',
} as const satisfies Record<SwitchableLocale, string>
const locales = LOCALE_PREFERENCES.filter((value): value is SwitchableLocale => value !== 'system')

/** Arrow/Home/End movement inside a radio group selects as it moves. */
function nextScaleIndex(key: string, current: number, count: number): number | null {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

export function AppearanceSettings({ settings, onUpdate }: SettingsSectionProps) {
  const { t } = useI18n()
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
      <header><h1>{t('appearance.title')}</h1><p>{t('appearance.description')}</p></header>
      <section className="settings-group">
        <h2>{t('appearance.theme.title')}</h2>
        <div className="theme-options">
          {themes.map((item) => {
            const Icon = item.icon
            return (
              <button type="button" key={item.id} className={settings.theme === item.id ? 'is-active' : ''} onClick={() => { void onUpdate({ theme: item.id }) }}>
                <span><Icon size={17} /></span><strong>{t(item.label)}</strong>{settings.theme === item.id ? <Check size={13} /> : null}
              </button>
            )
          })}
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.language.title')}</h2>
        <label className="settings-row">
          <span><strong>{t('appearance.language.label')}</strong><small>{t('appearance.language.description')} {t('appearance.language.available', { count: locales.length })}</small></span>
          <select value={settings.locale} onChange={(event) => { void onUpdate({ locale: event.target.value as LocalePreference }) }}>
            <option value="system">{t('appearance.language.system')}</option>
            {locales.map((value) => <option key={value} value={value}>{localeEndonyms[value]}</option>)}
          </select>
        </label>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.text.title')}</h2>
        <div className="settings-row settings-row--text-size">
          <span><strong>{t('appearance.text.label')}</strong><small>{t('appearance.text.description')}</small></span>
          <div className="text-size-options" role="radiogroup" aria-label={t('appearance.text.aria')} onKeyDown={onScaleKeyDown}>
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
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="settings-group">
        <h2>{t('appearance.motion.title')}</h2>
        <SettingsToggle checked={settings.reduceMotion} onChange={(reduceMotion) => { void onUpdate({ reduceMotion }) }} label={t('appearance.motion.reduce')} description={t('appearance.motion.description')} />
      </section>
    </>
  )
}
