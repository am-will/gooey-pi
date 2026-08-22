import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText, markdownTextDirection } from '../../src/components/MarkdownText'

describe('Markdown text direction', () => {
  it('finds the first strong prose character while ignoring Markdown code', () => {
    expect(markdownTextDirection('`src/App.tsx` سپس ادامه دهید.')).toBe('rtl')
    expect(markdownTextDirection('```ts\nconst answer = true\n```\n\nسلام دنیا')).toBe('rtl')
    expect(markdownTextDirection('مرحبا بالعالم')).toBe('rtl')
    expect(markdownTextDirection('שלום עולם')).toBe('rtl')
    expect(markdownTextDirection('Read this: سلام')).toBe('ltr')
    expect(markdownTextDirection('۱۲۳')).toBe('ltr')
  })

  it('renders RTL prose with isolated LTR code, URLs, and code blocks', () => {
    const html = renderToStaticMarkup(createElement(MarkdownText, {
      text: 'مسیر `src/App.tsx` و https://example.com را بررسی کنید.\n\n```ts\nconst answer = true\n```',
    }))

    expect(html).toContain('class="prose" dir="rtl"')
    expect(html).toContain('<code dir="ltr">src/App.tsx</code>')
    expect(html).toContain('<bdi>https://example.com</bdi>')
    expect(html).toContain('<pre dir="ltr"><code class="language-ts" dir="ltr">const answer = true')
  })
})
