// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { I18nProvider, loadLocale, translate, useI18n } from '../../src/lib/i18n'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Heading() {
  const { t } = useI18n()
  return <h1>{t('appearance.title')}</h1>
}

it('renders the English fallback immediately and updates after the real Japanese import', async () => {
  expect(translate('ja', 'appearance.title')).toBe('Appearance')
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<I18nProvider preference="ja"><Heading /></I18nProvider>))
    expect(container.textContent).toBe('Appearance')
    const pending = loadLocale('ja')
    expect(loadLocale('ja')).toBe(pending)
    await act(async () => { await pending })
    expect(container.textContent).toBe('外観')
    expect(translate('ja', 'appearance.title')).toBe('外観')
    await loadLocale('zh-CN')
    expect(translate('zh-CN', 'common.reload')).toBe('重新加载 GooeyPi')
    expect(translate('zh-CN', 'appearance.title')).toBe('外观')
  } finally {
    act(() => root.unmount())
  }
})
