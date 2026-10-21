import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { LocalePreference } from '@/types/api'
import { englishCatalog } from './locales/english'
import { japaneseCatalog } from './locales/japanese'
import { simplifiedChineseCatalog } from './locales/simplified-chinese'
import type { Message, MessageKey } from './locales/types'

type MessageValues = Record<string, string | number>

// The catalogs are data modules under `src/lib/locales`; they are re-exported
// here so every consumer keeps one import site for interface copy and only this
// module needs React.
export { englishCatalog, japaneseCatalog, simplifiedChineseCatalog }
export type { Message, MessageKey }

/** Locales this build can render; `en` is the base and the fallback for all. */
export type ResolvedLocale = 'en' | 'zh-CN' | 'ja'

/** Localised catalogs keyed by resolved locale; English is the base and fallback. */
const catalogs: Partial<Record<ResolvedLocale, Partial<Record<MessageKey, Message>>>> = {
  'zh-CN': simplifiedChineseCatalog,
  ja: japaneseCatalog,
}

/** Every locale this build can render; `englishCatalog` is the fallback for all. */
const RESOLVED_LOCALES = ['en', 'zh-CN', 'ja'] as const satisfies readonly ResolvedLocale[]

function browserLanguages(): readonly string[] {
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

export function translate(locale: ResolvedLocale, key: MessageKey, values: MessageValues = {}): string {
  const translated = catalogs[locale]?.[key]
  const message = translated ?? englishCatalog[key]
  const template = typeof message === 'string'
    ? message
    : message[new Intl.PluralRules(locale).select(Number(values.count)) === 'one' ? 'one' : 'other']
  return Object.entries(values).reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), template)
}

function copyMatches(message: Message | undefined, text: string): boolean {
  if (typeof message === 'string') return message === text
  return message !== undefined && (message.one === text || message.other === text)
}

/**
 * True when `text` is this key's copy in any locale.
 *
 * A few plain-module strings are not merely rendered but compared by value —
 * the transcript's empty-turn fallback row is dropped again when the turn is
 * retried. Comparing against one locale's translation breaks as soon as the
 * interface language changes between the write and the comparison (replay is
 * incremental), so those call sites match against every catalog instead. New
 * locales are covered automatically.
 */
export function matchesLocalizedCopy(text: string, key: MessageKey): boolean {
  if (copyMatches(englishCatalog[key], text)) return true
  return Object.values(catalogs).some((catalog) => copyMatches(catalog?.[key], text))
}

interface I18nContextValue {
  locale: ResolvedLocale
  t(key: MessageKey, values?: MessageValues): string
}

const I18nContext = createContext<I18nContextValue>({ locale: 'en', t: (key, values) => translate('en', key, values) })

// `Intl` formatters and other plain modules cannot read the React context, so the
// resolved locale is mirrored here. Without it a user who picks Japanese on an
// English OS still sees English relative timestamps ("2 hours ago") in the UI.
let formattingLocale: ResolvedLocale = 'en'

/** Locale tag for plain-module `Intl` formatting; mirrors the active interface locale. */
export function formattingLocaleTag(): ResolvedLocale {
  return formattingLocale
}

/**
 * Overrides the plain-module locale mirror.
 *
 * Reserved for tests: in the app the mirror is written by `useLocaleTranslator`
 * during render, which is what keeps plain-module copy (relative timestamps,
 * cost lines, validation messages, reducer rows) in the same language as the
 * render pass that produced it. Tests that mount no provider use this to
 * exercise the non-English paths and must restore `'en'`.
 */
export function setFormattingLocaleForTests(locale: ResolvedLocale): void {
  formattingLocale = locale
}

/**
 * Locale + translator for components that render ABOVE `I18nProvider` — the app
 * shell owns the settings state, so it cannot consume the context it provides.
 * Components inside the provider must use `useI18n` so they re-render on change.
 */
export function useLocaleTranslator(preference: LocalePreference): I18nContextValue {
  const locale = resolveLocale(preference)
  // Written during render on purpose. Plain modules read the mirror while the
  // same render pass builds their output, so moving this into an effect would
  // keep the previous language for a frame; and because the mirror is not state,
  // that stale frame would not re-render on its own. A discarded concurrent render
  // can only leave a locale that the next committed render overwrites again.
  formattingLocale = locale
  return useMemo<I18nContextValue>(() => ({ locale, t: (key, values) => translate(locale, key, values) }), [locale])
}

export function I18nProvider({ preference, children }: { preference: LocalePreference; children: ReactNode }) {
  const value = useLocaleTranslator(preference)
  useEffect(() => {
    document.documentElement.lang = value.locale
  }, [value.locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}

