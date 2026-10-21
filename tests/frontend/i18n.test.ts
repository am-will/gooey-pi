import { describe, expect, it } from 'vitest'
import { resolveLocale, translate } from '../../src/lib/i18n'

describe('i18n', () => {
  it('detects Simplified Chinese system locales without treating Traditional Chinese as Simplified', () => {
    expect(resolveLocale('system', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-Hans-US'])).toBe('zh-CN')
    expect(resolveLocale('system', ['zh-TW', 'en-US'])).toBe('en')
    expect(resolveLocale('system', ['fr-FR', 'zh-SG'])).toBe('zh-CN')
  })

  it('uses the first supported system locale in preference order', () => {
    expect(resolveLocale('system', ['en-US', 'bg-US', 'zh-Hans-US'])).toBe('en')
    expect(resolveLocale('system', ['zh-Hans-US', 'en-US'])).toBe('zh-CN')
  })

  it('honors an explicit locale preference over the system locale', () => {
    expect(resolveLocale('en', ['zh-CN'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
  })

  it('interpolates values, selects plural forms, and falls back to English', () => {
    expect(translate('en', 'appearance.language.available', { count: 1 })).toBe('1 language available')
    expect(translate('en', 'appearance.language.available', { count: 2 })).toBe('2 languages available')
    expect(translate('zh-CN', 'appearance.language.available', { count: 2 })).toBe('支持 2 种语言')
    expect(translate('zh-CN', 'common.reload')).toBe('Reload GooeyPi')
  })

  it('names the archive controls in both languages', () => {
    expect(translate('en', 'archive.doneToast')).toBe('Archived. Find it in Settings › Archived chats.')
    expect(translate('zh-CN', 'archive.doneToast')).toBe('已归档。可在「设置 › 已归档的聊天」里找到。')
    expect(translate('zh-CN', 'archive.restoredToast')).toBe('会话已恢复。')
    expect(translate('zh-CN', 'archive.running.body', { title: '重构登录页' })).toContain('「重构登录页」还在工作中')
    expect(translate('zh-CN', 'common.cancel')).toBe('取消')
  })
})
