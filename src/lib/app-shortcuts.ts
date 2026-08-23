export interface AppShortcutEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export type AppShortcutAction = 'open-palette' | 'new-session' | 'open-browser' | 'toggle-sidebar' | 'toggle-terminal' | 'open-settings' | 'close-palette' | 'close-settings'

const OVERLAY_SELECTOR = '.modal[role="dialog"][aria-modal="true"], .command-palette[role="dialog"]'

/** True while a modal dialog or the command palette owns the keyboard. */
export function isOverlayOpen(root: Pick<Document, 'querySelector'> = document): boolean {
  return Boolean(root.querySelector(OVERLAY_SELECTOR))
}

/**
 * Maps a keydown to the app shortcut it triggers, or null when the app does not
 * own the combination. While an overlay is open every app shortcut is suppressed
 * so native editing keys (paste, copy, undo) keep working inside it. Escape
 * continues to be owned by the active overlay.
 */
export function appShortcutForKey(event: AppShortcutEvent, overlayOpen: boolean, settingsOpen = false): AppShortcutAction | null {
  if (overlayOpen) return event.key === 'Escape' ? 'close-palette' : null
  const command = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (settingsOpen && (event.key === 'Escape' || (command && key === 'w'))) return 'close-settings'
  if (command && key === 'k') return 'open-palette'
  if (command && key === 'n') return 'new-session'
  if (command && key === 'b' && event.shiftKey) return 'open-browser'
  if (command && key === 'b') return 'toggle-sidebar'
  if (command && key === 'j') return 'toggle-terminal'
  if (command && event.key === ',') return 'open-settings'
  if (event.key === 'Escape') return 'close-palette'
  return null
}

/**
 * Builds the window keydown handler: preventDefault only for combinations the app
 * owns and is about to act on, never for keys that belong to the focused element.
 */
export function createAppKeydownHandler(actions: Record<AppShortcutAction, () => void>, root: Pick<Document, 'querySelector'> = document, settingsOpen = false): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    const action = appShortcutForKey(event, isOverlayOpen(root), settingsOpen)
    if (!action) return
    if (action !== 'close-palette') event.preventDefault()
    actions[action]()
  }
}
