// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ChildHistoryMessage } from '../../src/components/ChildHistoryMessage'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('keeps available thinking, tool input and output readable without child controls', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ChildHistoryMessage message={{ id: 'child-reply', role: 'assistant', parts: [
      { type: 'thinking', text: 'The available summary.' },
      { type: 'toolCall', id: 'read', name: 'read_file', args: { path: 'src/App.tsx' } },
      { type: 'toolResult', name: 'read_file', text: 'File content returned by the child.' },
      { type: 'text', text: 'The child result.' },
    ] }} />))
    expect(host.querySelector('details[open]')?.textContent).toContain('The available summary.')
    const tool = host.querySelector<HTMLDetailsElement>('.child-history-tool')!
    expect(tool.open).toBe(false)
    await act(async () => tool.querySelector('summary')!.click())
    expect(tool.open).toBe(true)
    expect(tool.textContent).toContain('Input')
    expect(tool.textContent).toContain('"path": "src/App.tsx"')
    expect(tool.textContent).toContain('Output')
    expect(tool.textContent).toContain('File content returned by the child.')
    expect(host.textContent).toContain('The child result.')
    expect(host.querySelector('textarea')).toBeNull()
    expect([...host.querySelectorAll('button')].some((button) => /send|stop|steer/i.test(button.textContent ?? ''))).toBe(false)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
