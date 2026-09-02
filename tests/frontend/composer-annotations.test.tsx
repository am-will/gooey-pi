// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { BrowserAnnotation, PrimeModelDescriptor, PrimeProviderDescriptor, PromptDeliveryIntent, PromptImage, SessionRecord, TerminalPromptContext, TerminalSelectionContext } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [
  {
    key: 'provider/vision',
    provider: 'provider',
    id: 'vision',
    name: 'Vision',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 100_000,
    maxTokens: 8_000,
    availableThinkingLevels: ['medium'],
    fastModeSupported: false,
    available: true,
  },
]
const providers: PrimeProviderDescriptor[] = [
  {
    id: 'provider',
    name: 'Provider',
    authMethod: 'api_key',
    configured: true,
    modelCount: 1,
    availableModelCount: 1,
    enabled: true,
  },
]
const modelsByProvider = groupModelsByProvider(models)

const annotation = (id: string, overrides: Partial<BrowserAnnotation> = {}): BrowserAnnotation => ({
  id,
  comment: `Comment ${id}`,
  element: { selector: `#${id}`, tagName: 'button', id, classes: ['btn'], text: 'Sign up', rect: { x: 1, y: 2, width: 30, height: 20 } },
  pageUrl: 'https://example.com/',
  pageTitle: 'Example Page',
  stale: false,
  createdAt: 1,
  ...overrides,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

interface RenderOptions {
  annotations?: BrowserAnnotation[]
  sendSignal?: number
  onSend?: Mock<(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent) => Promise<void>>
  onRemoveAnnotation?: Mock<(id: string) => void>
  onClearAnnotations?: Mock<() => void>
  terminalSelection?: TerminalSelectionContext
  getTerminalContext?: () => TerminalPromptContext | undefined
  onClearTerminalSelection?: Mock<() => void>
  sessions?: SessionRecord[]
}

function renderComposer({ annotations = [], sendSignal = 0, onSend = vi.fn(async () => undefined), onRemoveAnnotation = vi.fn(), onClearAnnotations = vi.fn(), terminalSelection, getTerminalContext, onClearTerminalSelection = vi.fn(), sessions = [] }: RenderOptions = {}) {
  act(() =>
    root.render(
      <Composer
        busy={false}
        model="provider/vision"
        effort="medium"
        modelsByProvider={modelsByProvider}
        providers={providers}
        reasoningLevels={['medium']}
        fast={false}
        fastSupported={false}
        fastAvailable
        imageInputSupported
        messageEnterAction="queue"
        skills={[]}
        sessions={sessions}
        annotations={annotations}
        terminalSelection={terminalSelection}
        getTerminalContext={getTerminalContext}
        sendSignal={sendSignal}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onFastChange={vi.fn()}
        onSend={onSend}
        onStop={vi.fn()}
        onRemoveAnnotation={onRemoveAnnotation}
        onClearAnnotations={onClearAnnotations}
        onClearTerminalSelection={onClearTerminalSelection}
      />,
    ),
  )
  return { onSend, onRemoveAnnotation, onClearAnnotations, onClearTerminalSelection }
}

const setDraft = async (value: string) => {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const clickSend = async () => {
  await act(async () => {
    ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
    await Promise.resolve()
  })
}

describe('Composer session mentions', () => {
  it('closes an accepted mention and only reopens it after editing back into the query', async () => {
    const sessions: SessionRecord[] = [{
      id: '019f0000-0000-7000-8000-000000000001', harness: 'prime', filePath: '/sessions/browser.jsonl', projectPath: '/project', title: 'Browser',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'idle', depth: 0,
    }]
    renderComposer({ sessions })
    await setDraft('@brow')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.getAttribute('aria-expanded')).toBe('true')

    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(textarea.value).toBe('@Browser ')
    expect(textarea.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.composer-menu')).toBeNull()

    await act(async () => {
      textarea.setRangeText('keep typing', textarea.selectionStart, textarea.selectionEnd, 'end')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.getAttribute('aria-expanded')).toBe('false')

    await setDraft('@brow')
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }))
      textarea.setRangeText('', '@Browser'.length, '@Browser '.length, 'end')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe('@Browser')
    expect(textarea.getAttribute('aria-expanded')).toBe('true')
  })

  it('suggests sidebar sessions by title and sends a stable UUID routing block', async () => {
    const sessions: SessionRecord[] = [{
      id: '019f0000-0000-7000-8000-000000000002', harness: 'pi', filePath: '/sessions/api.jsonl', projectPath: '/project', title: 'API owner',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', status: 'running', depth: 0,
    }]
    const { onSend } = renderComposer({ sessions })
    await setDraft('Coordinate with @API')
    const option = [...container.querySelectorAll('[role="option"]')].find((item) => item.textContent?.includes('@API owner')) as HTMLButtonElement
    expect(option).toBeDefined()
    await act(async () => option.click())
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('Coordinate with @API owner ')
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(textarea.selectionEnd).toBe(textarea.value.length)
    await act(async () => {
      textarea.setRangeText('continue', textarea.selectionStart, textarea.selectionEnd, 'end')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(textarea.value).toBe('Coordinate with @API owner continue')
    await clickSend()

    const [prompt] = onSend.mock.calls[0]
    expect(prompt.startsWith('Coordinate with @API owner continue\n\n')).toBe(true)
    expect(prompt).toContain('pi session UUID 019f0000-0000-7000-8000-000000000002')
    expect(prompt).toContain('Use gooeypi_session_read, gooeypi_session_send, and gooeypi_session_wait')
  })
})

describe('Composer annotation attachment', () => {
  it('auto-attaches a chip showing the annotation count while any exist', () => {
    renderComposer({ annotations: [annotation('a'), annotation('b')] })
    const chip = container.querySelector('.composer-attachment--annotations')
    expect(chip?.textContent).toContain('2')
    expect(chip?.getAttribute('title')).toBe('2 page annotations')
    expect(chip?.querySelector('.composer-attachment__expand')?.getAttribute('aria-label')).toContain('2 page annotations')
    expect(container.querySelector('.composer-annotations')).toBeNull()
  })

  it('expands to inspect each annotation as plain text and deletes individually', async () => {
    const hostile = annotation('a', { comment: '<img src=x onerror=alert(1)> fix this' })
    const { onRemoveAnnotation } = renderComposer({ annotations: [hostile, annotation('b', { stale: true })] })

    await act(async () => {
      ;(container.querySelector('.composer-attachment__expand') as HTMLButtonElement).click()
    })
    const panel = container.querySelector('.composer-annotations')
    expect(panel).not.toBeNull()
    // Untrusted text renders as text, never as markup.
    expect(panel?.querySelector('img')).toBeNull()
    expect(panel?.textContent).toContain('<img src=x onerror=alert(1)> fix this')
    // Rows show only the comment (plus staleness); DOM labels are intentionally omitted.
    expect(panel?.textContent).not.toContain('button#a.btn')
    expect(panel?.textContent).toContain('page changed')

    await act(async () => {
      ;(container.querySelector('button[aria-label="Remove annotation 2"]') as HTMLButtonElement).click()
    })
    expect(onRemoveAnnotation).toHaveBeenCalledWith('b')
  })

  it('removes the whole attachment through the chip control', async () => {
    const { onClearAnnotations } = renderComposer({ annotations: [annotation('a')] })
    await act(async () => {
      ;(container.querySelector('button[aria-label="Remove page annotations"]') as HTMLButtonElement).click()
    })
    expect(onClearAnnotations).toHaveBeenCalledTimes(1)
  })

  it('appends the serialized annotation block to the sent prompt and clears afterwards', async () => {
    const { onSend, onClearAnnotations } = renderComposer({ annotations: [annotation('a')] })
    await setDraft('Please fix the signup flow')
    await clickSend()

    expect(onSend).toHaveBeenCalledTimes(1)
    const [prompt, images, intent] = onSend.mock.calls[0]
    expect(intent).toBe('queue')
    expect(images).toEqual([])
    expect(prompt.startsWith('Please fix the signup flow\n\n===== BEGIN BROWSER ANNOTATIONS =====')).toBe(true)
    expect(prompt).toContain('Comment: Comment a')
    expect(prompt).toContain('Selector: #a')
    expect(prompt).toContain('Page URL: https://example.com/')
    expect(prompt.endsWith('===== END BROWSER ANNOTATIONS =====')).toBe(true)
    expect(onClearAnnotations).toHaveBeenCalledTimes(1)
  })

  it('allows sending with annotations alone using a placeholder prompt', async () => {
    const { onSend } = renderComposer({ annotations: [annotation('a')] })
    const send = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement
    expect(send.disabled).toBe(false)
    await clickSend()
    const [prompt] = onSend.mock.calls[0]
    expect(prompt.startsWith('[Page annotations]\n\n===== BEGIN BROWSER ANNOTATIONS =====')).toBe(true)
  })

  it('keeps the annotations attached when the send fails', async () => {
    const onSend = vi.fn(async () => {
      throw new Error('rejected')
    })
    const { onClearAnnotations } = renderComposer({ annotations: [annotation('a')], onSend })
    await setDraft('Keep these')
    await clickSend()

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onClearAnnotations).not.toHaveBeenCalled()
    expect(container.querySelector('.composer-attachment--annotations')).not.toBeNull()
  })

  it('disables send and hides the chip without annotations', () => {
    renderComposer()
    expect(container.querySelector('.composer-attachment--annotations')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
  })
})

describe('Composer terminal context attachment', () => {
  const selection: TerminalSelectionContext = { tabId: 'terminal-2', label: 'zsh 2', text: 'npm test\n1 failed', truncated: false }
  const terminalContext: TerminalPromptContext = { ...selection, cwd: '/workspace' }

  it('does not show an attachment or enable send without selected terminal text', () => {
    renderComposer({ terminalSelection: { ...selection, text: '' } })
    expect(container.querySelector('.composer-attachment--terminal')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
  })

  it('expands and clears highlighted terminal text through its live attachment', async () => {
    const { onClearTerminalSelection } = renderComposer({ terminalSelection: selection })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false)
    await act(async () => {
      ;(container.querySelector('button[aria-label="Inspect selected text from zsh 2"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('.composer-terminal-selection')?.textContent).toContain('npm test')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Clear terminal selection"]') as HTMLButtonElement).click()
    })
    expect(onClearTerminalSelection).toHaveBeenCalledTimes(1)
    await act(async () => {
      renderComposer({ terminalSelection: { ...selection, text: '' }, onClearTerminalSelection })
    })
    expect(container.querySelector('.composer-terminal-selection')).toBeNull()
    expect(container.querySelector('button[aria-label="Clear terminal selection"]')).toBeNull()
  })

  it('reads and appends only the current terminal selection when submitting', async () => {
    const getTerminalContext = vi.fn(() => terminalContext)
    const { onSend } = renderComposer({ terminalSelection: selection, getTerminalContext })
    expect(getTerminalContext).not.toHaveBeenCalled()
    await setDraft('Explain the failure')
    await clickSend()
    expect(getTerminalContext).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toContain('Explain the failure\n\n===== BEGIN TERMINAL SELECTION CONTEXT =====')
    expect(onSend.mock.calls[0][0]).toContain('--- Selected text ---\nnpm test\n1 failed')
    expect(onSend.mock.calls[0][0]).not.toContain('Terminal buffer')
  })
})

describe('Composer sendSignal', () => {
  it('submits the attached annotations immediately when the signal bumps', async () => {
    const onSend = vi.fn<(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent) => Promise<void>>(async () => undefined)
    const onClearAnnotations = vi.fn()
    const options = { annotations: [annotation('a', { comment: 'ship it' })], onSend, onClearAnnotations }
    renderComposer({ ...options, sendSignal: 0 })
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      renderComposer({ ...options, sendSignal: 1 })
    })
    expect(onSend).toHaveBeenCalledTimes(1)
    const [prompt] = onSend.mock.calls[0]
    expect(prompt).toContain('[Page annotations]')
    expect(prompt).toContain('ship it')
    expect(onClearAnnotations).toHaveBeenCalledTimes(1)
  })

  it('ignores an unchanged signal on re-render', async () => {
    const onSend = vi.fn<(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent) => Promise<void>>(async () => undefined)
    const options = { annotations: [annotation('a')], onSend, sendSignal: 2 }
    renderComposer(options)
    await act(async () => {
      renderComposer(options)
    })
    expect(onSend).not.toHaveBeenCalled()
  })
})
