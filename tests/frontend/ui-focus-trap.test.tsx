// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Modal } from '../../src/components/ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('preserves React autoFocus after its attribute has been consumed', async () => {
  act(() => root.render(<Modal title="Edit" onClose={() => undefined}><input autoFocus aria-label="Title" /></Modal>))
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!
  expect(input.hasAttribute('autofocus')).toBe(false)
  expect(document.activeElement).toBe(input)
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(document.activeElement).toBe(input)
})
it('still focuses the first control when no child has claimed focus', async () => {
  act(() => root.render(<Modal title="Edit" onClose={() => undefined}><input aria-label="Title" /></Modal>))
  await act(async () => vi.advanceTimersByTimeAsync(0))
  expect(document.activeElement).toBe(document.querySelector('button[aria-label="Close"]'))
})
