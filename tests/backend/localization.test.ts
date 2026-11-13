import { afterEach, describe, expect, it } from 'vitest'
import { mainLocale, mt, setMainLocale } from '../../electron/main/localization'

afterEach(() => { setMainLocale('en', []) })

describe('main-process localization', () => {
  it('defaults to English', () => {
    expect(mainLocale()).toBe('en')
    expect(mt('menu.checkForUpdates')).toBe('Check for Updates…')
  })

  it('resolves the saved preference and translates native copy', () => {
    expect(setMainLocale('zh-CN', ['en-US'])).toBe('zh-CN')
    expect(mainLocale()).toBe('zh-CN')
    expect(mt('menu.checkForUpdates')).toBe('检查更新…')
    expect(mt('dialog.closeApp')).toBe('关闭 GooeyPi')
  })

  it('falls back to the system language for the system preference', () => {
    expect(setMainLocale('system', ['zh-Hans-CN'])).toBe('zh-CN')
    expect(mt('tray.quit')).toBe('退出')
    expect(setMainLocale('system', ['ja-JP'])).toBe('ja')
    expect(mt('tray.quit')).toBe('終了')
  })

  it('selects plural forms and interpolates values', () => {
    setMainLocale('zh-CN')
    expect(mt('shutdown.agentRuns', { count: 2 })).toContain('2')
    expect(mt('menu.quit', { appName: 'GooeyPi' })).toBe('退出 GooeyPi')
  })
})
