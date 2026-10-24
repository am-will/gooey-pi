import { Menu } from 'electron'

/**
 * Starts the operating system's own dictation in the focused text field. macOS Dictation is started by
 * the same responder action as Edit → Start Dictation, and macOS itself asks to enable Dictation when it
 * is off. Other platforms expose nothing an app can start, so they report false.
 */
export function startSystemDictation(
  platform: NodeJS.Platform = process.platform,
  sendAction: (action: string) => void = (action) => Menu.sendActionToFirstResponder(action),
): boolean {
  if (platform !== 'darwin') return false
  sendAction('startDictation:')
  return true
}
