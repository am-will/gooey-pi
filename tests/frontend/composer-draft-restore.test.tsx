// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import { readComposerDraft } from '../../src/lib/composer-draft'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const DRAFT_KEY = 'draft-project:draft-session'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.sessionStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.sessionStorage.clear()
})

function renderComposer(onSend: () => Promise<void>) {
  act(() => root.render(
    <Composer
      busy={false}
      model="provider/model"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable
      imageInputSupported={false}
      skills={[]}
      draftKey={DRAFT_KEY}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
    />,
  ))
}

async function submitDraft(value: string) {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    ;(container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click()
  })
}

describe('Composer draft restoration after unmount', () => {
  it('saves the submitted draft when the send fails after the composer unmounted', async () => {
    let rejectSend!: (error: unknown) => void
    renderComposer(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
    await submitDraft('Keep this prompt')
    expect(readComposerDraft(DRAFT_KEY)).toBeNull()

    // Switching sessions remounts the composer under a different key.
    await act(async () => root.render(<div />))
    await act(async () => { rejectSend(new Error('not delivered')) })

    expect(readComposerDraft(DRAFT_KEY)).toEqual({ text: 'Keep this prompt', model: 'provider/model', effort: 'medium', fast: false })
    renderComposer(vi.fn(async () => undefined))
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Keep this prompt')
  })

  it('keeps a newer draft typed after returning when the earlier send fails', async () => {
    let rejectSend!: (error: unknown) => void
    renderComposer(() => new Promise<void>((_resolve, reject) => { rejectSend = reject }))
    await submitDraft('Earlier prompt')

    await act(async () => root.render(<div />))
    renderComposer(vi.fn(async () => undefined))
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Newer draft')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { rejectSend(new Error('not delivered')) })

    expect(readComposerDraft(DRAFT_KEY)?.text).toBe('Newer draft')
    expect(textarea.value).toBe('Newer draft')
  })

  it('keeps the draft cleared when the send succeeds after the composer unmounted', async () => {
    let resolveSend!: () => void
    renderComposer(() => new Promise<void>((resolve) => { resolveSend = resolve }))
    await submitDraft('Delivered prompt')

    await act(async () => root.render(<div />))
    await act(async () => { resolveSend() })

    expect(readComposerDraft(DRAFT_KEY)).toBeNull()
  })
})
