// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import {
  annotationMarkersScript,
  annotationPickerScript,
  annotationTakeScript,
  boundInnerText,
  buildSelectorPath,
} from '../../src/lib/annotation-picker'
import { sanitizeCapturedElement } from '../../src/lib/browser-annotations'

// Runs an injected-picker script the same way webview.executeJavaScript would:
// as plain page-level code against the (jsdom) document.
function runScript(source: string): unknown {
  // biome-ignore lint/security/noGlobalEval: tests execute the injected picker script against jsdom exactly as the webview would
  return globalThis.eval(source)
}

afterEach(() => {
  runScript(`${annotationPickerScript('stop')}\n${annotationMarkersScript([])}\ndelete window.__primeAnnotator;`)
  document.body.innerHTML = ''
})

describe('buildSelectorPath', () => {
  it('prefers the nearest unique id and stops there', () => {
    document.body.innerHTML = '<div id="app"><ul><li>a</li><li><span>target</span></li></ul></div>'
    const span = document.querySelector('span') as Element
    const selector = buildSelectorPath(span)
    expect(selector).toBe('#app > ul > li:nth-of-type(2) > span')
    expect(document.querySelector(selector)).toBe(span)
  })

  it('falls back to a full nth-of-type path when ids are duplicated', () => {
    document.body.innerHTML = '<div id="dup"></div><div id="dup"><p>first</p><p>second</p></div>'
    const second = document.querySelectorAll('p')[1] as Element
    const selector = buildSelectorPath(second)
    expect(selector).toBe('html > body > div:nth-of-type(2) > p:nth-of-type(2)')
    expect(document.querySelector(selector)).toBe(second)
  })

  it('escapes ids that are not plain identifiers', () => {
    document.body.innerHTML = '<div id="my target"><b>x</b></div>'
    const bold = document.querySelector('b') as Element
    const selector = buildSelectorPath(bold)
    expect(document.querySelector(selector)).toBe(bold)
  })

  it('omits nth-of-type for only children of their tag', () => {
    document.body.innerHTML = '<main><section><button>go</button></section></main>'
    const button = document.querySelector('button') as Element
    expect(buildSelectorPath(button)).toBe('html > body > main > section > button')
  })
})

describe('boundInnerText', () => {
  it('collapses whitespace and truncates to the bound', () => {
    expect(boundInnerText('  Sign\n\n  up\tnow  ', 100)).toBe('Sign up now')
    expect(boundInnerText('x'.repeat(50), 10)).toHaveLength(10)
    expect(boundInnerText(null, 10)).toBe('')
  })
})

describe('injected picker script', () => {
  it('is idempotent and captures a bounded element payload on click', () => {
    document.body.innerHTML = '<div id="app"><a id="cta" class="btn primary" href="https://example.com/signup">Join   now</a></div>'
    runScript(annotationPickerScript('start'))
    runScript(annotationPickerScript('start'))
    // A second injection must not duplicate overlays or listeners.
    expect(document.querySelectorAll('div[style*="2147483646"]')).toHaveLength(1)

    const anchor = document.querySelector('#cta') as HTMLElement
    anchor.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    const hover = document.querySelector('div[style*="2147483646"]') as HTMLElement
    expect(hover.style.display).toBe('block')

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(click)
    // The picker swallows the click so the page does not navigate.
    expect(click.defaultPrevented).toBe(true)

    const payload = runScript(annotationTakeScript()) as string
    const parsed = JSON.parse(payload) as unknown[]
    expect(parsed).toHaveLength(1)
    const clean = sanitizeCapturedElement(parsed[0])
    expect(clean).not.toBeNull()
    expect(clean!.selector).toBe('#cta')
    expect(clean!.tagName).toBe('a')
    expect(clean!.classes).toEqual(['btn', 'primary'])
    expect(clean!.text).toBe('Join now')
    expect(clean!.href).toBe('https://example.com/signup')
    // Drained: a second take returns null.
    expect(runScript(annotationTakeScript())).toBeNull()
  })

  it('stop removes the hover overlay and its listeners but keeps markers', () => {
    document.body.innerHTML = '<p id="note">hello</p>'
    runScript(annotationPickerScript('start'))
    runScript(annotationMarkersScript([{ selector: '#note', index: 3 }]))
    runScript(annotationPickerScript('stop'))

    expect(document.querySelector('div[style*="2147483646"]')).toBeNull()
    const marker = document.querySelector('div[style*="2147483645"]')
    expect(marker).not.toBeNull()
    expect(marker?.textContent).toBe('3')

    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    ;(document.querySelector('#note') as HTMLElement).dispatchEvent(click)
    expect(click.defaultPrevented).toBe(false)
    expect(runScript(annotationTakeScript())).toBeNull()
  })

  it('re-renders markers on update, skips unresolvable selectors, and clears on empty', () => {
    document.body.innerHTML = '<p id="a">a</p><p id="b">b</p>'
    runScript(annotationMarkersScript([
      { selector: '#a', index: 1 },
      { selector: '#missing', index: 2 },
      { selector: ']]] invalid', index: 3 },
      { selector: '#b', index: 4 },
    ]))
    const badges = [...document.querySelectorAll('div[style*="2147483645"] div > div')].map((badge) => badge.textContent)
    expect(badges).toEqual(['1', '4'])

    runScript(annotationMarkersScript([{ selector: '#b', index: 1 }]))
    expect(document.querySelectorAll('div[style*="2147483645"]')).toHaveLength(1)
    expect(document.querySelector('div[style*="2147483645"]')?.textContent).toBe('1')

    runScript(annotationMarkersScript([]))
    expect(document.querySelector('div[style*="2147483645"]')).toBeNull()
  })

  it('clears picker and marker overlays through the production stop APIs', () => {
    document.body.innerHTML = '<p id="a">a</p>'
    runScript(annotationPickerScript('start'))
    runScript(annotationMarkersScript([{ selector: '#a', index: 1 }]))
    runScript(annotationPickerScript('stop'))
    runScript(annotationMarkersScript([]))
    expect(document.querySelector('div[style*="2147483646"]')).toBeNull()
    expect(document.querySelector('div[style*="2147483645"]')).toBeNull()
  })

  it('embeds marker selectors safely even with hostile content', () => {
    document.body.innerHTML = '<p id="a">a</p>'
    const hostile = '</script><img src=x onerror=alert(1)>  '
    // Must not throw while evaluating: the payload is JSON-embedded, not concatenated markup.
    runScript(annotationMarkersScript([{ selector: hostile, index: 1 }]))
    expect(document.querySelector('div[style*="2147483645"]')).toBeNull()
  })
})
