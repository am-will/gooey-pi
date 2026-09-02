import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/components/MarkdownText'

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownText, { text }))
}

describe('Markdown text direction', () => {
  it('lets each paragraph of a mixed English and Persian message pick its own direction', () => {
    const html = render('**Cursor**\n\nاین فایل را ببینید (`file-name.md`):')

    expect(html).not.toContain('class="prose" dir=')
    expect(html).toContain('<p dir="auto"><strong>Cursor</strong></p>')
    expect(html).toContain('<p dir="auto">این فایل را ببینید (<code dir="ltr">file-name.md</code>):</p>')
  })

  it('renders RTL prose with isolated LTR code, URLs, and code blocks', () => {
    const html = render('مسیر `src/App.tsx` و https://example.com را بررسی کنید.\n\n```ts\nconst answer = true\n```')

    expect(html).toContain('<p dir="auto">مسیر <code dir="ltr">src/App.tsx</code>')
    expect(html).toContain('<bdi>https://example.com</bdi>')
    expect(html).toContain('<pre dir="ltr"><code class="language-ts" dir="ltr">const answer = true')
  })

  it('keeps code-first paragraphs auto-directed so the LTR code does not decide the base direction', () => {
    const html = render('`src/App.tsx` سپس ادامه دهید.')

    expect(html).toContain('<p dir="auto"><code dir="ltr">src/App.tsx</code> سپس ادامه دهید.</p>')
  })

  it('auto-directs lists, headings, blockquotes, and table cells', () => {
    const html = render([
      '# عنوان',
      '',
      '- مورد اول',
      '',
      '1. First item',
      '',
      '> نقل قول',
      '',
      '| Header | سرستون |',
      '| --- | --- |',
      '| cell | سلول |',
    ].join('\n'))

    expect(html).toContain('<h1 dir="auto">عنوان</h1>')
    expect(html).toContain('<ul dir="auto">')
    expect(html).toContain('<li dir="auto">مورد اول</li>')
    expect(html).toContain('<ol dir="auto">')
    expect(html).toContain('<li dir="auto">First item</li>')
    expect(html).toContain('<blockquote dir="auto">')
    expect(html).toContain('<th dir="auto">Header</th>')
    expect(html).toContain('<th dir="auto">سرستون</th>')
    expect(html).toContain('<td dir="auto">cell</td>')
    expect(html).toContain('<td dir="auto">سلول</td>')
  })
})
