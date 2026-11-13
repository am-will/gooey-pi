import type { LocalePreference } from '../types/api'

export type MessageValues = Record<string, string | number>

/** Locales this build can render; `en` is the base and the fallback for all. */
export type ResolvedLocale = 'en' | 'zh-CN' | 'ja'

/** Every locale this build can render; `englishCatalog` is the fallback for all. */
const RESOLVED_LOCALES = ['en', 'zh-CN', 'ja'] as const satisfies readonly ResolvedLocale[]

export function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages.length ? navigator.languages : [navigator.language]
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[] = browserLanguages()): ResolvedLocale {
  // The preference type already restricts this to the locales below, but the
  // value can still arrive from a newer build's state file or a hand-edited one.
  // Falling back to English keeps `Intl` formatters and `document.lang` valid
  // instead of propagating an unknown tag through the whole renderer.
  if (preference !== 'system') return RESOLVED_LOCALES.includes(preference) ? preference : 'en'
  for (const language of languages) {
    const normalized = language.toLowerCase()
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-CN'
    if (normalized === 'ja' || normalized.startsWith('ja-')) return 'ja'
  }
  return 'en'
}

/** Picks a plural form and substitutes `{name}` placeholders. */
export function formatMessage(locale: ResolvedLocale, message: string | { one: string; other: string }, values: MessageValues = {}): string {
  const template = typeof message === 'string'
    ? message
    : message[new Intl.PluralRules(locale).select(Number(values.count)) === 'one' ? 'one' : 'other']
  return Object.entries(values).reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), template)
}
