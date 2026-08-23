// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appShortcutForKey, createAppKeydownHandler, isOverlayOpen, type AppShortcutAction } from '../../src/lib/app-shortcuts'

function installHandler() {
  const calls: AppShortcutAction[] = []
  const actions = Object.fromEntries(
    (['open-palette', 'new-session', 'open-browser', 'toggle-sidebar', 'toggle-terminal', 'open-settings', 'close-palette', 'close-settings'] as const).map((action) => [
      action,
      () => { calls.push(action) },
    ]),
  ) as Record<AppShortcutAction, () => void>
  const handler = createAppKeydownHandler(actions)
  window.addEventListener('keydown', handler)
  return { calls, dispose: () => window.removeEventListener('keydown', handler) }
}

function openModal(): HTMLElement {
  const modal = document.createElement('section')
  modal.className = 'modal'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.appendChild(modal)
  return modal
}

function openPalette(): HTMLElement {
  const palette = document.createElement('div')
  palette.className = 'command-palette'
  palette.setAttribute('role', 'dialog')
  palette.setAttribute('aria-modal', 'true')
  document.body.appendChild(palette)
  return palette
}

function dispatchKey(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  window.dispatchEvent(event)
  return event
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('app keyboard shortcuts with overlays open', () => {
  it('never prevents default for combinations the app does not own (paste in a modal)', () => {
    const { calls, dispose } = installHandler()
    try {
      openModal()
      const paste = dispatchKey({ key: 'v', metaKey: true })
      expect(paste.defaultPrevented).toBe(false)
      const copy = dispatchKey({ key: 'c', ctrlKey: true })
      expect(copy.defaultPrevented).toBe(false)
      expect(calls).toEqual([])
    } finally {
      dispose()
    }
  })

  it('suppresses app shortcuts while a modal is open without hijacking the keys', () => {
    const { calls, dispose } = installHandler()
    try {
      openModal()
      const newSession = dispatchKey({ key: 'n', metaKey: true })
      expect(calls).toEqual([])
      expect(newSession.defaultPrevented).toBe(false)
      const palette = dispatchKey({ key: 'k', metaKey: true })
      expect(calls).toEqual([])
      expect(palette.defaultPrevented).toBe(false)
    } finally {
      dispose()
    }
  })

  it('treats the command palette as an overlay too', () => {
    const { calls, dispose } = installHandler()
    try {
      openPalette()
      dispatchKey({ key: 'n', metaKey: true })
      expect(calls).toEqual([])
      const paste = dispatchKey({ key: 'v', metaKey: true })
      expect(paste.defaultPrevented).toBe(false)
      const escapeKey = dispatchKey({ key: 'Escape' })
      expect(escapeKey.defaultPrevented).toBe(false)
      expect(calls).toEqual([])
    } finally {
      dispose()
    }
  })

  it('fires app shortcuts with preventDefault when no overlay is open', () => {
    const { calls, dispose } = installHandler()
    try {
      const palette = dispatchKey({ key: 'k', metaKey: true })
      expect(palette.defaultPrevented).toBe(true)
      const newSession = dispatchKey({ key: 'n', ctrlKey: true })
      expect(newSession.defaultPrevented).toBe(true)
      const browser = dispatchKey({ key: 'B', metaKey: true, shiftKey: true })
      expect(browser.defaultPrevented).toBe(true)
      const paste = dispatchKey({ key: 'v', metaKey: true })
      expect(paste.defaultPrevented).toBe(false)
      expect(calls).toEqual(['open-palette', 'new-session', 'open-browser'])
    } finally {
      dispose()
    }
  })

  it('does not act on a shortcut already handled by an overlay', () => {
    const { calls, dispose } = installHandler()
    try {
      const escapeKey = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      escapeKey.preventDefault()
      window.dispatchEvent(escapeKey)
      expect(calls).toEqual([])
    } finally {
      dispose()
    }
  })
})

describe('app shortcut key mapping', () => {
  const event = (overrides: Partial<Parameters<typeof appShortcutForKey>[0]> = {}) => ({ key: '', metaKey: false, ctrlKey: false, shiftKey: false, ...overrides })

  it('maps every owned combination when no overlay is open', () => {
    expect(appShortcutForKey(event({ key: 'k', metaKey: true }), false)).toBe('open-palette')
    expect(appShortcutForKey(event({ key: 'n', ctrlKey: true }), false)).toBe('new-session')
    expect(appShortcutForKey(event({ key: 'b', metaKey: true, shiftKey: true }), false)).toBe('open-browser')
    expect(appShortcutForKey(event({ key: 'b', metaKey: true }), false)).toBe('toggle-sidebar')
    expect(appShortcutForKey(event({ key: 'j', ctrlKey: true }), false)).toBe('toggle-terminal')
    expect(appShortcutForKey(event({ key: ',', metaKey: true }), false)).toBe('open-settings')
    expect(appShortcutForKey(event({ key: ',', ctrlKey: true }), false)).toBe('open-settings')
    expect(appShortcutForKey(event({ key: 'Escape' }), false)).toBe('close-palette')
    expect(appShortcutForKey(event({ key: 'v', metaKey: true }), false)).toBeNull()
  })

  it('closes settings with Escape or the primary W shortcut', () => {
    expect(appShortcutForKey(event({ key: 'Escape' }), false, true)).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'w', ctrlKey: true }), false, true)).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'w', metaKey: true }), false, true)).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'w', ctrlKey: true }), false)).toBeNull()
  })

  it('owns no shortcuts while an overlay is open', () => {
    expect(appShortcutForKey(event({ key: 'k', metaKey: true }), true)).toBeNull()
    expect(appShortcutForKey(event({ key: 'v', metaKey: true }), true)).toBeNull()
    expect(appShortcutForKey(event({ key: 'Escape' }), true)).toBeNull()
  })

  it('detects modal and palette overlays in the document', () => {
    expect(isOverlayOpen(document)).toBe(false)
    const modal = openModal()
    expect(isOverlayOpen(document)).toBe(true)
    modal.remove()
    expect(isOverlayOpen(document)).toBe(false)
    openPalette()
    expect(isOverlayOpen(document)).toBe(true)
  })
})
