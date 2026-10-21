// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOAST_DURATION_MS, useToast } from '../../src/hooks/useToast'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useToast', () => {
  it.each(['Session restored.', 'Session archived.'])('restarts the notification duration when the next message is %s', async (nextMessage) => {
    let setToast!: (toast: string | null) => void
    function ToastProbe() {
      const state = useToast()
      setToast = state.setToast
      return <>{state.toast}</>
    }

    await act(async () => { root.render(<ToastProbe />) })
    await act(async () => { setToast('Session archived.') })
    expect(container.textContent).toBe('Session archived.')

    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS - 1) })
    expect(container.textContent).toBe('Session archived.')

    await act(async () => { setToast(nextMessage) })
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(container.textContent).toBe(nextMessage)

    await act(async () => { vi.advanceTimersByTime(TOAST_DURATION_MS) })
    expect(container.textContent).toBe('')
  })
})
