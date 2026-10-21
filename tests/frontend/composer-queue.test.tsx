// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function queueProps(overrides: Partial<ComponentProps<typeof Composer>> = {}): ComponentProps<typeof Composer> {
  return { busy: true, model: '', effort: 'medium', modelsByProvider: new Map(), providers: [], reasoningLevels: ['medium'], fast: false, fastSupported: false, fastAvailable: false, imageInputSupported: true, skills: [], onModelChange: vi.fn(), onEffortChange: vi.fn(), onFastChange: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), ...overrides }
}

describe('composer queue tray', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows queued messages with immediate send, edit, and delete actions', () => {
    const onSend = vi.fn()
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const queued = { id: 'queue-1', text: 'run tests', intent: 'queue' as const }
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      imageInputSupported={true}
      messageEnterAction="queue"
      skills={[]}
      queuedMessages={[queued]}
      onDeleteQueuedMessage={onDelete}
      onEditQueuedMessage={onEdit}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={onSend}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    expect(tray?.querySelectorAll('.composer-queue__item')).toHaveLength(1)
    expect(tray?.textContent).toContain('run tests')
    expect(tray?.nextElementSibling?.classList.contains('composer')).toBe(true)
    const actions = [...(tray?.querySelectorAll<HTMLButtonElement>('.composer-queue__action') ?? [])]
    expect(actions.map((action) => action.title)).toEqual([
      'Send queued message immediately',
      'Edit queued message',
      'Delete queued message',
    ])

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Send queued message immediately"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
    expect(onSend).toHaveBeenCalledWith('run tests', [], 'steer')

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Edit queued message"]')?.click())
    expect(onEdit).toHaveBeenCalledWith(queued)
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('run tests')

    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Delete queued message"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
  })

  it('shows messages held by a count-only harness queue', () => {
    act(() => root.render(<Composer
      busy
      submitting={false}
      loading={false}
      disabled={false}
      model="auto"
      effort="medium"
      modelsByProvider={new Map()}
      providers={[]}
      reasoningLevels={['medium']}
      fast={false}
      fastSupported={false}
      fastAvailable={false}
      agentName="OMP"
      imageInputSupported={true}
      skills={[]}
      harnessQueuedMessageCount={2}
      onModelChange={vi.fn()}
      onEffortChange={vi.fn()}
      onFastChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />))

    const tray = container.querySelector('.composer-queue')
    expect(tray?.querySelector('.composer-queue__header strong')?.textContent).toBe('2')
    expect(tray?.textContent).toContain('OMP is holding 2 messages for the next turn.')
  })

  it('restores a failed immediate steer beside an existing draft', async () => {
    const queued = { id: 'queued', text: 'run tests', intent: 'queue' as const }
    const onDelete = vi.fn()
    act(() => root.render(<Composer {...queueProps({ queuedMessages: [queued], onDeleteQueuedMessage: onDelete, onSend: vi.fn().mockRejectedValue(new Error('steer failed')) })} />))
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'unsent')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label^="Send queued message immediately"]')?.click())
    expect(onDelete).toHaveBeenCalledWith(queued)
    expect(textarea.value).toBe('unsent\n\nrun tests')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Queued message was not sent')
  })

})
