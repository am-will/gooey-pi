// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { PrimeContextUsage, PrimeModelDescriptor, PrimeProviderDescriptor, SkillRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const models: PrimeModelDescriptor[] = [{
  key: 'provider/vision', provider: 'provider', id: 'vision', name: 'Vision', reasoning: true,
  input: ['text', 'image'], contextWindow: 100_000, maxTokens: 8_000,
  availableThinkingLevels: ['medium'], fastModeSupported: false, available: true,
}]
const providers: PrimeProviderDescriptor[] = [{
  id: 'provider', name: 'Provider', authMethod: 'api_key', configured: true,
  modelCount: 1, availableModelCount: 1, enabled: true,
}]
const modelsByProvider = groupModelsByProvider(models)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  let id = 0
  vi.stubGlobal('crypto', { randomUUID: () => {
    id += 1
    return `image-${id}`
  } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderComposer(onSend = vi.fn(), imageInputSupported = true, busy = false, messageEnterAction: 'queue' | 'steer' = 'queue', contextUsage?: PrimeContextUsage) {
  act(() => root.render(<Composer
    busy={busy}
    model="provider/vision"
    effort="medium"
    modelsByProvider={modelsByProvider}
    providers={providers}
    reasoningLevels={['medium']}
    fast={false}
    fastSupported={false}
    fastAvailable
    imageInputSupported={imageInputSupported}
    messageEnterAction={messageEnterAction}
    contextUsage={contextUsage}
    skills={[]}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={vi.fn()}
    onSend={onSend}
    onStop={vi.fn()}
  />))
  return onSend
}

function pastedPng(read?: () => Promise<ArrayBuffer>): File {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], 'pasted.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: read ?? (async () => bytes.buffer) })
  return file
}

function dispatchPasteFiles(files: File[], text = ''): void {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
  container.querySelector('textarea')?.dispatchEvent(event)
}

async function pasteFiles(files: File[], text = ''): Promise<void> {
  await act(async () => {
    dispatchPasteFiles(files, text)
    await Promise.resolve()
    await Promise.resolve()
  })
}

const paste = (file: File) => pasteFiles([file])

async function pickFiles(files: File[]): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => {
    input?.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function dispatchDrag(type: string, target: Element, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  })
  target.dispatchEvent(event)
  return event
}

async function dropFiles(files: File[]): Promise<void> {
  const composer = container.querySelector('.composer') as HTMLElement
  await act(async () => {
    dispatchDrag('dragenter', composer, files)
    dispatchDrag('dragover', composer, files)
    dispatchDrag('drop', composer, files)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Composer image ingestion', () => {
  it('previews and sends a pasted image through the prompt callback', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined))
    await paste(pastedPng())

    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledWith('[Attached image]', [{
      type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=',
    }], 'queue')
    expect(container.querySelector('.composer-attachment')).toBeNull()
  })

  it('shows an actionable rejection for a known text-only model', async () => {
    const onSend = renderComposer(vi.fn(), false)
    await paste(pastedPng())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not accept images')
    expect(container.querySelector('.composer-attachment')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('waits for pending image reads and preserves mixed clipboard text', async () => {
    let resolveBuffer!: (value: ArrayBuffer) => void
    const file = pastedPng(() => new Promise<ArrayBuffer>((resolve) => { resolveBuffer = resolve }))
    const onSend = renderComposer(vi.fn(async () => undefined))
    await pasteFiles([file], 'clipboard note')

    await act(async () => { await Promise.resolve() })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('clipboard note')
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => {
      resolveBuffer(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false)
  })

  it('inserts mixed clipboard text at the caret instead of appending', async () => {
    renderComposer(vi.fn(async () => undefined))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(textarea, 'hello world')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    textarea.focus()
    textarea.setSelectionRange(5, 5)

    await pasteFiles([pastedPng()], ' pasted')

    expect(textarea.value).toBe('hello pasted world')
    expect(textarea.selectionStart).toBe('hello pasted'.length)
  })

  it('enforces the attachment count across concurrent paste completions', async () => {
    renderComposer()
    const files = Array.from({ length: 10 }, () => pastedPng())
    await act(async () => {
      dispatchPasteFiles(files.slice(0, 5))
      dispatchPasteFiles(files.slice(5))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(5)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('up to 8 images')
  })


  it('restores the text and image draft when prompt admission fails', async () => {
    const onSend = renderComposer(vi.fn(async () => { throw new Error('rejected') }))
    await pasteFiles([pastedPng()], 'Keep this draft')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })

    expect(onSend).toHaveBeenCalledOnce()
    expect(textarea.value).toBe('Keep this draft')
    expect(container.querySelector('.composer-attachment')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('restored')
  })

  it('opens an image-only picker and attaches its selection', async () => {
    renderComposer()
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Choose images to attach"]')
    const click = vi.spyOn(input as HTMLInputElement, 'click')

    ;(container.querySelector('button[aria-label="Attach images"]') as HTMLButtonElement).click()
    expect(click).toHaveBeenCalledOnce()
    expect(input?.multiple).toBe(true)
    expect(input?.accept).toBe('image/png,image/jpeg,image/gif,image/webp')

    await pickFiles([pastedPng()])
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
  })

  it('attaches dropped images and keeps nested drag feedback stable', async () => {
    renderComposer()
    const composer = container.querySelector('.composer') as HTMLElement
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement

    act(() => {
      dispatchDrag('dragenter', composer, [pastedPng()])
      dispatchDrag('dragenter', textarea, [pastedPng()])
      dispatchDrag('dragleave', textarea, [pastedPng()])
    })
    expect(container.querySelector('.composer-drop-feedback')?.textContent).toContain('Drop images')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Drop images')

    await act(async () => {
      dispatchDrag('drop', composer, [pastedPng()])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('.composer-drop-feedback')).toBeNull()
    expect(container.querySelector('.composer-attachment')?.textContent).toContain('pasted.png')
  })

  it('rejects mixed supported and unsupported payloads atomically', async () => {
    renderComposer()
    const unsupported = new File(['plain text'], 'notes.txt', { type: 'text/plain' })

    await pasteFiles([pastedPng(), unsupported], 'keep this text')

    expect(container.querySelector('.composer-attachment')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('PNG, JPEG, GIF, and WebP')
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('keep this text')
  })

  it('shares count and byte limits across picker, paste, and drop', async () => {
    renderComposer()
    await pickFiles(Array.from({ length: 4 }, () => pastedPng()))
    await dropFiles(Array.from({ length: 5 }, () => pastedPng()))
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(4)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('up to 8 images')

    const removeButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('.composer-attachment > button'))
    act(() => removeButtons.forEach((button) => { button.click() }))
    const largeImage = () => new File([new Uint8Array(700_000)], 'large.png', { type: 'image/png' })
    await paste(largeImage())
    await pickFiles([largeImage()])
    expect(container.querySelectorAll('.composer-attachment')).toHaveLength(1)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('too large')
  })

  it('rejects picker and drop input for text-only models', async () => {
    renderComposer(vi.fn(), false)
    await pickFiles([pastedPng()])
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('does not accept images')
    await dropFiles([pastedPng()])
    expect(container.querySelector('.composer-attachment')).toBeNull()
  })

  it('removes a chosen image and exposes accessible picker and attachment status labels', async () => {
    renderComposer()
    await pickFiles([pastedPng()])
    expect(container.querySelector('[role="status"]')?.textContent).toContain('1 image attached')

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove pasted.png"]')
    expect(remove).not.toBeNull()
    act(() => remove?.click())
    expect(container.querySelector('.composer-attachment')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('')
    expect(container.querySelector('button[aria-label="Attach images"]')?.getAttribute('title')).toBe('Attach images')
  })

})


describe('Composer message delivery shortcuts', () => {
  const enterDraft = async (value: string, init: KeyboardEventInit = {}) => {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
      await Promise.resolve()
    })
  }

  it('queues with Enter and steers with Ctrl+Enter while Prime is working', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined), true, true)
    await enterDraft('Queue this')
    await enterDraft('Steer with this', { ctrlKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Steer with this', [], 'steer')
  })

  it('allows Ctrl+Enter steering while an earlier delivery callback is still pending', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const onSend = renderComposer(vi.fn(() => pending), true, true)

    await enterDraft('Queue this')
    await enterDraft('Steer immediately', { ctrlKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Steer immediately', [], 'steer')
    await act(async () => { release?.(); await pending })
  })

  it('uses the shared persisted Enter action regardless of the active harness', async () => {
    const onSend = renderComposer(vi.fn(async () => undefined), true, true, 'steer')
    await enterDraft('Steer this')
    await enterDraft('Queue this', { ctrlKey: true })
    await enterDraft('Keep editing', { shiftKey: true })

    expect(onSend).toHaveBeenNthCalledWith(1, 'Steer this', [], 'steer')
    expect(onSend).toHaveBeenNthCalledWith(2, 'Queue this', [], 'queue')
    expect(onSend).toHaveBeenCalledTimes(2)
  })
})


describe('Composer submission lifecycle', () => {
  const setDraft = async (value: string) => {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, value)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    return textarea
  }
  const pressEnter = async (textarea: HTMLTextAreaElement) => {
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  }

  it('keeps the textarea editable while a submission is starting', () => {
    act(() => root.render(<Composer
      busy={false} submitting model="provider/vision" effort="medium" modelsByProvider={modelsByProvider} providers={providers}
      reasoningLevels={['medium']} fast={false} fastSupported={false} fastAvailable imageInputSupported
      messageEnterAction="queue" skills={[]}
      onModelChange={vi.fn()} onEffortChange={vi.fn()} onFastChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()}
    />))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.disabled).toBe(false)
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true)
  })

  it('guards double submission in the handler and refocuses after send resolves', async () => {
    let resolveSend!: () => void
    const onSend = vi.fn(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    renderComposer(onSend)
    const textarea = await setDraft('First message')
    await pressEnter(textarea)
    // Typing and pressing Enter again while the first send is in flight must
    // not double-submit, because the textarea stays enabled.
    await setDraft('Second attempt')
    await pressEnter(textarea)
    expect(onSend).toHaveBeenCalledTimes(1)

    await act(async () => { resolveSend(); await Promise.resolve() })
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })
})

describe('Composer context usage and stop control', () => {
  it('shows the exact context usage in a filled dial before the send button', () => {
    renderComposer(vi.fn(), true, false, 'queue', { tokens: 50_000, contextWindow: 100_000, percent: 50 })

    const dial = container.querySelector<HTMLElement>('[role="meter"]')
    const actions = container.querySelector('.composer__actions')
    expect(dial?.textContent).toBe('50')
    expect(dial?.title).toBe('50,000 / 100,000 tokens')
    expect(dial?.getAttribute('aria-valuenow')).toBe('50')
    expect(dial?.style.getPropertyValue('--context-percent')).toBe('50%')
    expect(actions?.firstElementChild).toBe(dial)
    expect(dial?.nextElementSibling?.getAttribute('aria-label')).toBe('Start dictation')
    expect(dial?.nextElementSibling?.nextElementSibling?.getAttribute('aria-label')).toBe('Send message')
  })

  it('shows unavailable usage honestly and uses a square stop icon', () => {
    renderComposer(vi.fn(), true, true, 'queue', { tokens: null, contextWindow: 100_000, percent: null })

    const dial = container.querySelector<HTMLElement>('[role="meter"]')
    expect(dial?.textContent).toBe('—')
    expect(dial?.hasAttribute('aria-valuenow')).toBe(false)
    expect(dial?.title).toContain('unavailable')
    expect(container.querySelector('button[aria-label="Stop Prime"] .lucide-square')).not.toBeNull()
    expect(container.querySelector('.lucide-circle-stop')).toBeNull()
  })
})

describe('Composer memoization', () => {
  const stableProps = {
    busy: false,
    model: 'provider/vision',
    effort: 'medium' as const,
    modelsByProvider,
    providers,
    reasoningLevels: ['medium' as const],
    fast: false,
    fastSupported: false,
    fastAvailable: true,
    imageInputSupported: true,
    messageEnterAction: 'queue' as const,
    skills: [],
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onFastChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
  }

  it('does not re-render when a streaming parent re-renders with identical props', () => {
    // Composer's render body scans `skills` for enabled entries, so counting
    // those scans counts Composer renders.
    let renderProbes = 0
    const probedSkills = new Proxy([] as SkillRecord[], {
      get(target, key, receiver) {
        if (key === 'filter') renderProbes += 1
        return Reflect.get(target, key, receiver)
      },
    })
    let forceParentRender: () => void = () => undefined
    function Parent() {
      const [, setTick] = useState(0)
      forceParentRender = () => setTick((value) => value + 1)
      return <Composer {...stableProps} skills={probedSkills} />
    }

    act(() => root.render(<Parent />))
    const initialRenders = renderProbes
    expect(initialRenders).toBeGreaterThan(0)

    act(() => forceParentRender())
    act(() => forceParentRender())
    // memo(Composer) bails out for identical props: no further renders.
    expect(renderProbes).toBe(initialRenders)

    expect(container.querySelectorAll('optgroup')).toHaveLength(1)
    expect(container.querySelectorAll('optgroup option')).toHaveLength(1)
  })
})
