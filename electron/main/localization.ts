import type { LocalePreference } from '../../src/types/api'
import { formatMessage, resolveLocale, type MessageValues, type ResolvedLocale } from '../../src/lib/i18n-core'
import { englishCatalog } from '../../src/lib/locales/english'
import { japaneseCatalog } from '../../src/lib/locales/japanese'
import { simplifiedChineseCatalog } from '../../src/lib/locales/simplified-chinese'
import type { Message, MessageKey } from '../../src/lib/locales/types'

/**
 * Main-process localization. The renderer loads catalogs lazily, but native
 * menus and dialogs must render synchronously, so the main process bundles all
 * three catalogs and keeps the resolved locale in a module-level mirror.
 */
const catalogs: Record<ResolvedLocale, Record<MessageKey, Message>> = {
  en: englishCatalog,
  ja: japaneseCatalog,
  'zh-CN': simplifiedChineseCatalog,
}

let activeLocale: ResolvedLocale = 'en'

export function setMainLocale(preference: LocalePreference, systemLanguages: readonly string[] = []): ResolvedLocale {
  activeLocale = resolveLocale(preference, systemLanguages)
  return activeLocale
}

export function mainLocale(): ResolvedLocale {
  return activeLocale
}

/** Translate native copy; English is the fallback for an unexpected missing key. */
export function mt(key: MessageKey, values: MessageValues = {}): string {
  const message = catalogs[activeLocale][key] ?? englishCatalog[key]
  return formatMessage(activeLocale, message, values)
}
