// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessId } from '../../src/types/api'
import { HarnessMark } from '../../src/components/HarnessMark'
import { useCopyFeedback, type CopyFeedback } from '../../src/hooks/useCopyFeedback'

const clipboard = vi.hoisted(() => ({ writeClipboardText: vi.fn<(text: string) => Promise<void>>() }))
vi.mock('@/lib/clipboard', () => clipboard)

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let feedback: CopyFeedback

beforeEach(() => {
  vi.useFakeTimers()
  clipboard.writeClipboardText.mockReset()
  clipboard.writeClipboardText.mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

function Probe({ resetMs, onError }: { resetMs?: number; onError?(error: unknown): void }) {
  feedback = useCopyFeedback(resetMs, onError)
  return <span data-testid="state">{feedback.copied ? 'copied' : 'idle'}</span>
}

const state = () => container.querySelector('[data-testid="state"]')?.textContent
async function render(resetMs?: number) {
  await act(async () => { root.render(<Probe resetMs={resetMs} />) })
}
async function copy(text: string) {
  await act(async () => { await feedback.copy(text) })
}
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

describe('useCopyFeedback', () => {
  it('copies the text and shows copied until the reset delay passes', async () => {
    await render()
    expect(state()).toBe('idle')

    await copy('hello')
    expect(clipboard.writeClipboardText).toHaveBeenCalledWith('hello')
    expect(state()).toBe('copied')

    advance(1_499)
    expect(state()).toBe('copied')
    advance(1)
    expect(state()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honours a custom reset delay', async () => {
    await render(300)
    await copy('hello')
    advance(299)
    expect(state()).toBe('copied')
    advance(1)
    expect(state()).toBe('idle')
  })

  it('restarts the reset timer on each successful copy', async () => {
    await render()
    await copy('first')
    advance(1_000)
    await copy('second')
    expect(vi.getTimerCount()).toBe(1)

    advance(1_000)
    expect(state()).toBe('copied')
    advance(500)
    expect(state()).toBe('idle')
  })

  it('resolves without throwing and stays idle when the clipboard rejects', async () => {
    clipboard.writeClipboardText.mockRejectedValueOnce(new Error('Copy is unavailable'))
    await render()

    await expect(act(async () => { await feedback.copy('hello') })).resolves.toBeUndefined()
    expect(state()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears an earlier copied state and its pending reset when a later copy fails', async () => {
    await render()
    await copy('first')
    expect(state()).toBe('copied')

    clipboard.writeClipboardText.mockRejectedValueOnce(new Error('denied'))
    await copy('second')
    expect(state()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the pending reset on unmount', async () => {
    await render()
    await copy('hello')
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container)
  })

  it('leaves state and timers alone when a copy settles after unmount', async () => {
    let finish!: () => void
    clipboard.writeClipboardText.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await render()
    const pending = feedback.copy('slow')

    await act(async () => root.unmount())
    finish()
    await pending
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container)
  })

  it('reports a rejection to the latest committed callback without replacing copy', async () => {
    const first = vi.fn()
    const latest = vi.fn()
    await act(async () => { root.render(<Probe onError={first} />) })
    const originalCopy = feedback.copy
    await act(async () => { root.render(<Probe onError={latest} />) })
    expect(feedback.copy).toBe(originalCopy)
    const failure = new Error('denied')
    clipboard.writeClipboardText.mockRejectedValueOnce(failure)
    await copy('hello')
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('does not report a clipboard rejection after unmount', async () => {
    let reject!: (error: unknown) => void
    clipboard.writeClipboardText.mockImplementationOnce(() => new Promise<void>((_done, fail) => { reject = fail }))
    const onError = vi.fn()
    await act(async () => { root.render(<Probe onError={onError} />) })
    const pending = feedback.copy('slow')
    await act(async () => root.unmount())
    reject(new Error('denied'))
    await pending
    expect(onError).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it('keeps the copy callback stable across re-renders', async () => {
    await render()
    const first = feedback.copy
    await render()
    expect(feedback.copy).toBe(first)
  })
})

describe('HarnessMark', () => {
  it.each<[HarnessId, string, string]>([
    ['omp', 'omp-mark', 'OMP'],
    ['prime', 'prime-mark', 'Prime Intellect'],
    ['pi', 'pi-mark', 'Pi'],
  ])('renders the %s mark', async (harness, className, label) => {
    await act(async () => { root.render(<HarnessMark harness={harness} size={34} />) })
    const mark = container.querySelector<HTMLElement>(`.${className}`)
    expect(mark?.getAttribute('aria-label')).toBe(label)
    expect(mark?.style.width).toBe('34px')
    expect(container.querySelectorAll('[role="img"]')).toHaveLength(1)
  })

  it('defaults to a 24px mark', async () => {
    await act(async () => { root.render(<HarnessMark harness="pi" />) })
    expect(container.querySelector<HTMLElement>('.pi-mark')?.style.height).toBe('24px')
  })
})
