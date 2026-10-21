// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appShortcutForKey, createAppKeydownHandler, isOverlayOpen, type AppShortcutAction } from '../../src/lib/app-shortcuts'

function installHandler() {
  const calls: AppShortcutAction[] = []
  const actions = Object.fromEntries(
    (['open-palette', 'new-session', 'open-browser', 'toggle-sidebar', 'toggle-terminal', 'open-settings', 'close-settings'] as const).map((action) => [
      action,
      () => { calls.push(action) },
    ]),
  ) as Record<AppShortcutAction, () => void>
  const handler = createAppKeydownHandler(actions, document, false, 'darwin')
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
      const newSession = dispatchKey({ key: 'n', metaKey: true })
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

  it.each(['darwin', 'win32', 'linux'] as const)('uses the native primary modifier on %s', (platform) => {
    const primary = platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }
    const map = (key: string, shiftKey = false) => appShortcutForKey(event({ key, shiftKey, ...primary }), false, false, platform)
    expect(map('k')).toBe('open-palette')
    expect(map('n')).toBe('new-session')
    expect(map('B', true)).toBe('open-browser')
    expect(map('b')).toBe('toggle-sidebar')
    expect(map('j')).toBe('toggle-terminal')
    expect(map(',')).toBe('open-settings')
    expect(map('v')).toBeNull()
    expect(map('k', true)).toBeNull()
    const otherModifier = platform === 'darwin' ? { ctrlKey: true } : { metaKey: true }
    expect(appShortcutForKey(event({ key: 'b', ...otherModifier }), false, false, platform)).toBeNull()
  })

  it('leaves macOS Ctrl text-editing and AltGr combinations alone', () => {
    expect(appShortcutForKey(event({ key: 'n', ctrlKey: true }), false, false, 'darwin')).toBeNull()
    expect(appShortcutForKey(event({ key: 'j', ctrlKey: true, altKey: true }), false, false, 'win32')).toBeNull()
    expect(appShortcutForKey(event({ key: 'k', metaKey: true, ctrlKey: true }), false, false, 'darwin')).toBeNull()
  })

  it('closes Settings with Escape or native primary W and leaves unrelated Escape alone', () => {
    expect(appShortcutForKey(event({ key: 'Escape' }), false, true, 'darwin')).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'w', ctrlKey: true }), false, true, 'win32')).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'w', metaKey: true }), false, true, 'darwin')).toBe('close-settings')
    expect(appShortcutForKey(event({ key: 'Escape' }), false, false, 'darwin')).toBeNull()
    expect(appShortcutForKey(event({ key: 'w', ctrlKey: true }), false, false, 'win32')).toBeNull()
  })

  it('owns no shortcuts while an overlay is open', () => {
    expect(appShortcutForKey(event({ key: 'k', metaKey: true }), true, false, 'darwin')).toBeNull()
    expect(appShortcutForKey(event({ key: 'Escape' }), true, true, 'darwin')).toBeNull()
  })

  it('detects every modal dialog, including an image lightbox without the modal class', () => {
    expect(isOverlayOpen(document)).toBe(false)
    const modal = openModal()
    modal.className = 'image-lightbox'
    expect(isOverlayOpen(document)).toBe(true)
    modal.remove()
    expect(isOverlayOpen(document)).toBe(false)
    openPalette()
    expect(isOverlayOpen(document)).toBe(true)
  })
})
