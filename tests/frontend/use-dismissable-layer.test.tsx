// @vitest-environment jsdom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDismissableLayer, type DismissableLayerOptions } from '../../src/hooks/useDismissableLayer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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

interface ProbeProps { open: boolean; onDismiss(): void; options?: DismissableLayerOptions }

function Probe({ open, onDismiss, options }: ProbeProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  useDismissableLayer(open, (target) => target instanceof Node && Boolean(menuRef.current?.contains(target)), onDismiss, options)
  return (
    <>
      <div ref={menuRef} data-testid="menu"><button type="button" data-testid="inside">Item</button></div>
      <button type="button" data-testid="outside">Elsewhere</button>
    </>
  )
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const pointerDown = (target: EventTarget) => act(() => { target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true })) })
function keyDown(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  act(() => { target.dispatchEvent(event) })
  return event
}

async function render(props: ProbeProps) {
  await act(async () => { root.render(<Probe {...props} />) })
}

describe('useDismissableLayer', () => {
  it('dismisses on an outside pointerdown but not on one inside the layer', async () => {
    const onDismiss = vi.fn()
    await render({ open: true, onDismiss })

    pointerDown(byTestId('inside'))
    pointerDown(byTestId('menu'))
    expect(onDismiss).not.toHaveBeenCalled()

    pointerDown(byTestId('outside'))
    pointerDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(2)
  })

  it('handles the outside pointerdown in the capture phase', async () => {
    const onDismiss = vi.fn()
    await render({ open: true, onDismiss })
    const outside = byTestId('outside')
    outside.addEventListener('pointerdown', (event) => event.stopPropagation())

    pointerDown(outside)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('dismisses on Escape and marks the event as handled', async () => {
    const onDismiss = vi.fn()
    await render({ open: true, onDismiss })

    const other = keyDown(byTestId('inside'), 'Enter')
    expect(other.defaultPrevented).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()

    const escapeEvent = keyDown(byTestId('inside'), 'Escape')
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape when escape is disabled but still dismisses on outside pointerdown', async () => {
    const onDismiss = vi.fn()
    await render({ open: true, onDismiss, options: { escape: false } })

    const escapeEvent = keyDown(document.body, 'Escape')
    expect(escapeEvent.defaultPrevented).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()

    pointerDown(byTestId('outside'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does nothing while closed and stops listening once closed', async () => {
    const onDismiss = vi.fn()
    await render({ open: false, onDismiss })

    pointerDown(byTestId('outside'))
    expect(keyDown(document.body, 'Escape').defaultPrevented).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()

    await render({ open: true, onDismiss })
    await render({ open: false, onDismiss })
    pointerDown(byTestId('outside'))
    expect(keyDown(document.body, 'Escape').defaultPrevented).toBe(false)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('calls the latest onDismiss without re-registering listeners on re-render', async () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const first = vi.fn()
    const second = vi.fn()
    await render({ open: true, onDismiss: first })
    const registrations = addListener.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown').length
    expect(registrations).toBe(2)

    await render({ open: true, onDismiss: second })
    expect(addListener.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown')).toHaveLength(registrations)

    pointerDown(byTestId('outside'))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
