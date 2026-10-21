// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '../../src/components/CommandPalette'
import { Modal } from '../../src/components/ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let shell: HTMLDivElement
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  shell = document.createElement('div')
  shell.className = 'app-shell'
  document.body.append(shell)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  shell.remove()
  vi.restoreAllMocks()
})

const noop = () => undefined

function palette(open: boolean, platform: NodeJS.Platform = 'darwin') {
  return open ? <CommandPalette platform={platform} onClose={noop} onNavigate={noop} onNewSession={noop} onToggleSidebar={noop} onToggleTerminal={noop} onOpenBrowser={noop} /> : null
}

describe('app shell overlay refcount', () => {
  it('keeps the shell inert until the last overlay closes', async () => {
    await act(async () => {
      root.render(
        <>
          <Modal title="First" onClose={noop}>first</Modal>
          {palette(true)}
        </>,
      )
    })
    expect(shell.inert).toBe(true)
    expect(shell.getAttribute('aria-hidden')).toBe('true')

    // Closing one overlay while another stays open must not clear inert.
    await act(async () => {
      root.render(
        <>
          <Modal title="First" onClose={noop}>first</Modal>
          {palette(false)}
        </>,
      )
    })
    expect(shell.inert).toBe(true)
    expect(shell.getAttribute('aria-hidden')).toBe('true')

    await act(async () => { root.render(palette(false)) })
    expect(shell.inert).toBe(false)
    expect(shell.hasAttribute('aria-hidden')).toBe(false)
  })

  it('restores the shell after the palette closes', async () => {
    await act(async () => { root.render(palette(true)) })
    expect(shell.inert).toBe(true)
    await act(async () => { root.render(palette(false)) })
    expect(shell.inert).toBe(false)
    expect(shell.hasAttribute('aria-hidden')).toBe(false)
  })

  it('handles palette Escape exactly once through its focus trap', async () => {
    const onClose = vi.fn()
    await act(async () => { root.render(<CommandPalette onClose={onClose} onNavigate={noop} onNewSession={noop} onToggleSidebar={noop} onToggleTerminal={noop} onOpenBrowser={noop} />) })
    const input = document.querySelector<HTMLInputElement>('.command-palette input')
    if (!input) throw new Error('Palette input missing')
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows Windows shortcut names in the command palette on Windows', async () => {
    await act(async () => { root.render(palette(true, 'win32')) })
    expect(document.body.textContent).toContain('Ctrl+N')
    expect(document.body.textContent).toContain('Ctrl+Shift+B')
    expect(document.body.textContent).not.toContain('⌘')
  })
})
