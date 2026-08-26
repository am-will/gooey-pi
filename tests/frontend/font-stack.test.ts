import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Vazirmatn font stack', () => {
  const css = readFileSync('src/styles/base.css', 'utf8')
  const fontFace = css.match(/@font-face\s*\{[\s\S]*?font-family:\s*['"]Vazirmatn['"][\s\S]*?\}/)?.[0] ?? ''
  const root = css.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  const rootFontFamily = root.match(/font-family:\s*([^;]+);/)?.[1] ?? ''

  it('defines the bundled Arabic variable face and ships its source asset', () => {
    expect(fontFace).toMatch(/font-family:\s*['"]Vazirmatn['"]/)
    expect(fontFace).toMatch(/src:\s*url\(\s*['"]?\/fonts\/vazirmatn-arabic-var\.woff2['"]?\s*\)/)
    expect(fontFace).toMatch(/font-weight:\s*100\s+900/)
    expect(fontFace).toMatch(/unicode-range:[^;]*U\+0600-06FF/)
    expect(existsSync('public/fonts/vazirmatn-arabic-var.woff2')).toBe(true)
  })

  it('puts Vazirmatn before the system families in the root stack', () => {
    expect(rootFontFamily.indexOf('Vazirmatn')).toBeGreaterThanOrEqual(0)
    expect(rootFontFamily.indexOf('ui-sans-serif')).toBeGreaterThanOrEqual(0)
    expect(rootFontFamily.indexOf('Vazirmatn')).toBeLessThan(rootFontFamily.indexOf('ui-sans-serif'))
  })
})
