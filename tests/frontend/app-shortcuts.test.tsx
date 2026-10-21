// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../src/App'
import { detectRendererPlatform } from '../../src/lib/platform-shortcuts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderReady(root: Root, container: HTMLElement) {
  await act(async () => { root.render(<App />) })
  for (let attempt = 0; attempt < 100 && !container.querySelector('.app-shell[data-ready="true"]'); attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })
  }
  expect(container.querySelector('.app-shell[data-ready="true"]')).not.toBeNull()
}

const primaryModifier = detectRendererPlatform() === 'darwin' ? { metaKey: true } : { ctrlKey: true }

describe('app keyboard shortcuts lifecycle', () => {
  it('subscribes the window keydown handler once and keeps it across re-renders', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await renderReady(root, container)
    const keydownAdds = () => addSpy.mock.calls.filter(([type]) => type === 'keydown').length
    const keydownRemoves = () => removeSpy.mock.calls.filter(([type]) => type === 'keydown').length
    const initialAdds = keydownAdds()
    expect(initialAdds).toBeGreaterThan(0)

    // Force state-driven re-renders through the shortcut itself.
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ...primaryModifier })) })
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ...primaryModifier })) })

    expect(keydownAdds()).toBe(initialAdds)
    expect(keydownRemoves()).toBe(0)
    await act(async () => root.unmount())
    expect(keydownRemoves()).toBeGreaterThan(0)
    container.remove()
  })

  it('auto-closes the sidebar on entering the smallest breakpoint but still allows toggling it', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 721 })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)

    await renderReady(root, container)
    expect(container.querySelector('.sidebar')).not.toBeNull()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(container.querySelector('.sidebar')).toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ...primaryModifier })) })
    expect(container.querySelector('.sidebar')).not.toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ...primaryModifier })) })
    expect(container.querySelector('.sidebar')).toBeNull()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ...primaryModifier })) })
    expect(container.querySelector('.sidebar')).not.toBeNull()

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 721 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(container.querySelector('.sidebar')).not.toBeNull()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(container.querySelector('.sidebar')).toBeNull()

    await act(async () => root.unmount())
    container.remove()
  })
})
