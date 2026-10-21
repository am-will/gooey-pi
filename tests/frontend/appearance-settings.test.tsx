// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { I18nProvider } from '../../src/lib/i18n'
import { AppearanceSettings } from '../../src/pages/settings/AppearanceSettings'
import type { LocalePreference } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppearanceSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers only the bounded interface text sizes and persists the selected choice', () => {
    const update = vi.fn()
    act(() => root.render(<AppearanceSettings settings={DEFAULT_SETTINGS} onUpdate={update} />))

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Smaller', 'Default', 'Larger'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])

    act(() => options[2].click())
    expect(update).toHaveBeenCalledWith({ interfaceFontScale: 115 })
  })

  it('renders Simplified Chinese, translates accessibility text, and persists a locale override', () => {
    const update = vi.fn()
    act(() => root.render(
      <I18nProvider preference="zh-CN">
        <AppearanceSettings settings={{ ...DEFAULT_SETTINGS, locale: 'zh-CN' }} onUpdate={update} />
      </I18nProvider>,
    ))

    expect(container.querySelector('h1')?.textContent).toBe('外观')
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('界面文本大小')
    expect(container.textContent).toContain('支持 3 种语言')
    const locale = container.querySelector<HTMLSelectElement>('select')!
    expect([...locale.options].map((option) => option.textContent)).toEqual(['跟随系统', 'English', '简体中文', '日本語'])
    act(() => {
      locale.value = 'en'
      locale.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ locale: 'en' })

    act(() => {
      locale.value = 'ja'
      locale.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenLastCalledWith({ locale: 'ja' })
  })

  it('renders Japanese, offers the Japanese option, and persists it', () => {
    const update = vi.fn()
    act(() => root.render(
      <I18nProvider preference="ja">
        <AppearanceSettings settings={{ ...DEFAULT_SETTINGS, locale: 'ja' }} onUpdate={update} />
      </I18nProvider>,
    ))

    expect(container.querySelector('h1')?.textContent).toBe('外観')
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('表示テキストのサイズ')
    expect([...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].map((option) => option.textContent)).toEqual(['小', '標準', '大'])
    expect(container.textContent).toContain('3 言語に対応')
    const locale = container.querySelector<HTMLSelectElement>('select')!
    expect(locale.value).toBe('ja')
    expect([...locale.options].map((option) => option.textContent)).toEqual(['システム設定に従う', 'English', '简体中文', '日本語'])
    act(() => {
      locale.value = 'zh-CN'
      locale.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ locale: 'zh-CN' })
  })

  it('keeps every language name readable from any interface language', () => {
    const update = vi.fn()
    const renderIn = (preference: LocalePreference) => act(() => root.render(
      <I18nProvider preference={preference}>
        <AppearanceSettings settings={{ ...DEFAULT_SETTINGS, locale: preference }} onUpdate={update} />
      </I18nProvider>,
    ))
    const languageNames = () => [...container.querySelectorAll<HTMLOptionElement>('option')].slice(1).map((option) => option.textContent)

    // Endonyms never follow the interface language: a user who switched by
    // mistake must still recognise their own language in the list.
    renderIn('ja')
    expect(languageNames()).toEqual(['English', '简体中文', '日本語'])
    renderIn('zh-CN')
    expect(languageNames()).toEqual(['English', '简体中文', '日本語'])
    renderIn('en')
    expect(languageNames()).toEqual(['English', '简体中文', '日本語'])
  })

  it('exposes one tab stop and selects the interface size with arrow, Home, and End keys', () => {
    const update = vi.fn()
    act(() => root.render(<AppearanceSettings settings={DEFAULT_SETTINGS} onUpdate={update} />))

    const group = container.querySelector<HTMLDivElement>('[role="radiogroup"]')!
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0, -1])

    const press = (key: string) => {
      act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }

    press('ArrowRight')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 115 })
    expect(document.activeElement).toBe(options[2])

    press('ArrowLeft')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 105 })
    expect(document.activeElement).toBe(options[0])

    press('Home')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 105 })

    press('End')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 115 })
    expect(update).toHaveBeenCalledTimes(4)
  })
})
