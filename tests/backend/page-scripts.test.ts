// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateScript, readPageScript } from '../../electron/main/browser/page-scripts'

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

function visibleInputs(markup: string): unknown {
  document.body.innerHTML = markup
  const rects = Object.assign([new DOMRect(0, 0, 80, 24)], { item: () => null })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(rects)
  // biome-ignore lint/security/noGlobalEval: execute the actual generated guest script in the isolated JSDOM test document
  return JSON.parse(window.eval(readPageScript('interactive', 1000, 10)))
}

describe('generated page scripts', () => {
  it('reads ordinary input values with labels and bounded refs', () => {
    expect(visibleInputs('<input aria-label="Search" value="hello">')).toMatchObject({
      elements: [{ ref: 0, tag: 'input', name: 'Search', inputType: 'text', value: 'hello' }],
    })
  })

  it.each(['password', 'PASSWORD', 'PaSsWoRd'])('redacts values for input type %s', (type) => {
    const result = visibleInputs(`<input type="${type}" value="private-password">`)
    expect(JSON.stringify(result)).not.toContain('private-password')
  })

  it('evaluates async code and bounds its returned JSON', async () => {
    // biome-ignore lint/security/noGlobalEval: execute the actual generated guest script in the isolated JSDOM test document
    const payload = await window.eval(evaluateScript('return await Promise.resolve("abcdef")', 4))
    expect(JSON.parse(payload)).toEqual({ ok: true, value: '"abc' })
  })

  it('keeps a final line comment inside the agent-authored function body', async () => {
    // biome-ignore lint/security/noGlobalEval: execute the actual generated guest script in the isolated JSDOM test document
    const payload = await window.eval(evaluateScript('return 42 // agent note', 100))
    expect(JSON.parse(payload)).toEqual({ ok: true, value: '42' })
  })
})
