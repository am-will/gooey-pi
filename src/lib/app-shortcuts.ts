import { detectRendererPlatform, type ShortcutKey } from './platform-shortcuts'

export interface AppShortcutEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey?: boolean
}

export type AppShortcutAction = 'open-palette' | 'new-session' | 'open-browser' | 'toggle-sidebar' | 'toggle-terminal' | 'open-settings' | 'close-settings'

export const APP_SHORTCUT_KEYS = {
  'open-palette': ['Primary', 'K'],
  'new-session': ['Primary', 'N'],
  'open-browser': ['Primary', 'Shift', 'B'],
  'toggle-sidebar': ['Primary', 'B'],
  'toggle-terminal': ['Primary', 'J'],
  'open-settings': ['Primary', ','],
  'close-settings': ['Primary', 'W'],
} as const satisfies Record<AppShortcutAction, readonly ShortcutKey[]>

const OVERLAY_SELECTOR = '[role="dialog"][aria-modal="true"]'

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
export function appShortcutForKey(event: AppShortcutEvent, overlayOpen: boolean, settingsOpen = false, platform: NodeJS.Platform = detectRendererPlatform()): AppShortcutAction | null {
  if (overlayOpen) return null
  if (settingsOpen && event.key === 'Escape') return 'close-settings'
  const primary = platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!primary || event.altKey) return null
  const entries = Object.entries(APP_SHORTCUT_KEYS) as Array<[AppShortcutAction, readonly ShortcutKey[]]>
  for (const [action, keys] of entries) {
    if (action === 'close-settings' && !settingsOpen) continue
    if (event.shiftKey === keys.includes('Shift') && event.key.toUpperCase() === keys[keys.length - 1]) return action
  }
  return null
}

/**
 * Builds the window keydown handler: preventDefault only for combinations the app
 * owns and is about to act on, never for keys that belong to the focused element.
 */
export function createAppKeydownHandler(actions: Record<AppShortcutAction, () => void>, root: Pick<Document, 'querySelector'> = document, settingsOpen = false, platform: NodeJS.Platform = detectRendererPlatform()): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    // Capture-phase modal handlers can close an overlay synchronously. Respect
    // their cancellation even if the overlay has unmounted before this window
    // listener runs, so the same Escape cannot also close Settings.
    if (event.defaultPrevented) return
    const action = appShortcutForKey(event, isOverlayOpen(root), settingsOpen, platform)
    if (!action) return
    event.preventDefault()
    actions[action]()
  }
}
