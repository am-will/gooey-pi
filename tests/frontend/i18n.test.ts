import { beforeAll, describe, expect, it } from 'vitest'
import { englishCatalog, loadLocale, resolveLocale, translate, type Message, type MessageKey } from '../../src/lib/i18n'

import { japaneseCatalog } from '../../src/lib/locales/japanese'
import { simplifiedChineseCatalog } from '../../src/lib/locales/simplified-chinese'

beforeAll(async () => { await Promise.all([loadLocale('ja'), loadLocale('zh-CN')]) })

const localizedCatalogs = [
  ['ja', japaneseCatalog],
  ['zh-CN', simplifiedChineseCatalog],
] as const

function placeholders(message: Message): string[] {
  const texts = typeof message === 'string' ? [message] : [message.one, message.other]
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(/\{[A-Za-z0-9_]+\}/g)) found.add(match[0])
  }
  return [...found].sort()
}

function placeholdersByForm(message: Message): string[][] {
  return typeof message === 'string' ? [placeholders(message)] : [placeholders(message.one), placeholders(message.other)]
}

function isPlural(message: Message): boolean {
  return typeof message !== 'string'
}

describe('i18n', () => {
  // The catalog type already rejects a missing key; this pins the same invariant
  // at runtime so a future catalogs-in-JSON split cannot regress it.
  it('translates every English catalog key in every locale', () => {
    const englishKeys = Object.keys(englishCatalog).sort()
    expect(Object.keys(japaneseCatalog).sort()).toEqual(englishKeys)
    expect(Object.keys(simplifiedChineseCatalog).sort()).toEqual(englishKeys)
  })

  it('keeps every catalog key on an English key', () => {
    for (const [locale, catalog] of localizedCatalogs) {
      expect(Object.keys(catalog).filter((key) => !(key in englishCatalog)), `${locale} keys missing from the English catalog`).toEqual([])
    }
  })

  it('keeps interpolation placeholders in sync with English', () => {
    for (const [locale, catalog] of localizedCatalogs) {
      for (const key of Object.keys(englishCatalog) as MessageKey[]) {
        expect(placeholders(catalog[key]), `${locale} placeholder mismatch for ${key}`).toEqual(placeholders(englishCatalog[key]))
      }
    }
  })

  it('keeps placeholders identical in every plural form', () => {
    for (const key of Object.keys(englishCatalog) as MessageKey[]) {
      if (!isPlural(englishCatalog[key]) || !isPlural(simplifiedChineseCatalog[key])) continue
      expect(placeholdersByForm(simplifiedChineseCatalog[key]), `zh-CN plural placeholder mismatch for ${key}`).toEqual(placeholdersByForm(englishCatalog[key]))
    }
  })

  it('only uses plural entries where English does', () => {
    for (const [locale, catalog] of localizedCatalogs) {
      for (const key of Object.keys(englishCatalog) as MessageKey[]) {
        expect(isPlural(catalog[key]) && !isPlural(englishCatalog[key]), `${locale} has an unexpected plural entry for ${key}`).toBe(false)
      }
    }
  })

  it('has no empty translations', () => {
    for (const [locale, catalog] of localizedCatalogs) {
      for (const [key, message] of Object.entries(catalog)) {
        const texts = typeof message === 'string' ? [message] : [message.one, message.other]
        expect(texts.every((text) => text.trim().length > 0), `${locale} has an empty translation for ${key}`).toBe(true)
      }
    }
  })

  it('detects Simplified Chinese system locales without treating Traditional Chinese as Simplified', () => {
    expect(resolveLocale('system', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-Hans-US'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-TW', 'en-US'])).toBe('en')
    expect(resolveLocale('system', ['fr-FR', 'zh-SG'])).toBe('zh-CN')
  })

  it('detects Japanese system locales', () => {
    expect(resolveLocale('system', ['ja-JP'])).toBe('ja')
    expect(resolveLocale('system', ['ja'])).toBe('ja')
    expect(resolveLocale('system', ['fr-FR', 'ja-JP'])).toBe('ja')
  })

  it('uses the first supported system locale in preference order', () => {
    expect(resolveLocale('system', ['en-US', 'bg-US', 'zh-Hans-US'])).toBe('en')
    expect(resolveLocale('system', ['zh-Hans-US', 'en-US'])).toBe('zh-CN')
    expect(resolveLocale('system', ['ja-JP', 'en-US'])).toBe('ja')
    expect(resolveLocale('system', ['en-US', 'ja-JP'])).toBe('en')
    expect(resolveLocale('system', ['fr-FR', 'de-DE'])).toBe('en')
  })

  it('honors an explicit locale preference over the system locale', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(resolveLocale('ja', ['en-US'])).toBe('ja')
    expect(resolveLocale('ja', ['zh-CN'])).toBe('ja')
  })

  it('interpolates values and selects plural forms', () => {
    expect(translate('en', 'appearance.language.available', { count: 1 })).toBe('1 language available')
    expect(translate('en', 'appearance.language.available', { count: 2 })).toBe('2 languages available')
    expect(translate('zh-CN', 'appearance.language.available', { count: 2 })).toBe('支持 2 种语言')
    expect(translate('zh-CN', 'common.reload')).toBe('重新加载 GooeyPi')
    expect(translate('zh-CN', 'update.download', { version: ' 1.2.3' })).toBe('下载 1.2.3')
  })

  it('names the archive controls in both languages', () => {
    expect(translate('en', 'archive.doneToast')).toBe('Archived. Find it in Settings › Archived chats.')
    expect(translate('zh-CN', 'archive.doneToast')).toBe('已归档。可在“设置 › 已归档的聊天”中找到。')
    expect(translate('zh-CN', 'archive.restoredToast')).toBe('会话已恢复。')
    expect(translate('zh-CN', 'archive.running.body', { title: '重构登录页' })).toContain('“重构登录页”仍在工作')
    expect(translate('zh-CN', 'common.cancel')).toBe('取消')
  })
})
