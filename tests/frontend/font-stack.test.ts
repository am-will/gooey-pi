import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Vazirmatn font stack', () => {
  const css = readFileSync('src/styles/base.css', 'utf8')
  const fontFace = css.match(/@font-face\s*\{[\s\S]*?font-family:\s*['"]Vazirmatn['"][\s\S]*?\}/)?.[0] ?? ''
  const fontUrl = fontFace.match(/src:\s*url\(\s*['"]?([^'")\s]+)['"]?\s*\)/)?.[1] ?? ''
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

  it('keeps the font in the renderer inputs that are packaged into the asar', () => {
    const rendererConfig = readFileSync('electron.vite.config.ts', 'utf8')
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { build: { files: string[] } }
    const publicFontPath = join('public', fontUrl.replace(/^\/+/, ''))

    // The publicDir, outDir, and electron-builder inputs must stay aligned for the font to reach the asar.
    expect(fontUrl).toMatch(/^\/fonts\//)
    expect(existsSync(publicFontPath)).toBe(true)
    expect(rendererConfig).toMatch(/renderer:\s*\{[\s\S]*?\broot:\s*['"]\.['"]/)
    expect(rendererConfig).not.toMatch(/\bpublicDir\s*:/)
    expect(rendererConfig).not.toMatch(/\boutDir\s*:/)
    expect(packageJson.build.files).toContain('out/**/*')
  })
})
