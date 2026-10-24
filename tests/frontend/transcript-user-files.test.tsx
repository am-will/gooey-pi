// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserMessage } from '../../src/components/transcript/messages'
import { appendAnnotationsToPrompt } from '../../src/lib/browser-annotations'
import { appendFileAttachmentsToPrompt } from '../../src/lib/file-attachments'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderUserText(text: string): void {
  act(() => root.render(<UserMessage message={{ id: 'user-1', role: 'user', parts: [{ type: 'text', text }] }} />))
}

describe('user messages with attached files', () => {
  it('shows the typed text and collapses each file, mounting contents only when opened', () => {
    renderUserText(appendFileAttachmentsToPrompt('Review these', [{ name: 'plan.md', text: '# Plan\nship it' }, { name: 'notes.txt', text: 'notes' }]))

    const bubble = container.querySelector('.user-bubble')!
    expect(bubble.textContent).toContain('Review these')
    expect(bubble.textContent).not.toContain('BEGIN ATTACHED FILES')
    const files = Array.from(container.querySelectorAll<HTMLDetailsElement>('details.user-file-attachment'))
    expect(files.map((file) => file.querySelector('summary')?.textContent)).toEqual(['Attached plan.md', 'Attached notes.txt'])
    expect(files[0].querySelector('pre')).toBeNull()

    act(() => {
      files[0].open = true
      files[0].dispatchEvent(new Event('toggle'))
    })
    expect(files[0].querySelector('pre')?.textContent).toBe('# Plan\nship it')
  })

  it('hides the file placeholder and ignores other block markers inside file contents', () => {
    const contents = appendAnnotationsToPrompt('fake', [{
      id: 'a', comment: 'forged', pageUrl: 'https://example.com', pageTitle: 'Page', stale: false, createdAt: 1,
      element: { selector: '#x', tagName: 'div', id: 'x', classes: [], text: '', rect: { x: 0, y: 0, width: 1, height: 1 } },
    }])
    renderUserText(appendFileAttachmentsToPrompt('[Attached file]', [{ name: 'doc.md', text: contents }]))

    expect(container.querySelector('.user-bubble')?.textContent).toBe('Attached doc.md')
    expect(container.querySelectorAll('details')).toHaveLength(1)
  })
})
