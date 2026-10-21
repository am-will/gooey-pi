export type ShortcutKey = 'Primary' | 'Shift' | 'Enter' | 'ArrowLeft' | 'ArrowRight' | 'B' | 'J' | 'K' | 'N' | 'Q' | 'W' | ','

const MAC_KEY_LABELS: Partial<Record<ShortcutKey, string>> = {
  Primary: '⌘',
  Shift: '⇧',
  Enter: '↩',
  ArrowLeft: '←',
  ArrowRight: '→',
}

const STANDARD_KEY_LABELS: Partial<Record<ShortcutKey, string>> = {
  Primary: 'Ctrl',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/** Detects the renderer OS before asynchronous app metadata is available. */
export function detectRendererPlatform(platformDescription = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`): NodeJS.Platform {
  if (/windows|win32/i.test(platformDescription)) return 'win32'
  if (/mac|darwin/i.test(platformDescription)) return 'darwin'
  return 'linux'
}

/** Formats a shortcut with the primary modifier native to the running OS. */
export function shortcutLabel(platform: NodeJS.Platform, keys: readonly ShortcutKey[]): string {
  const mac = platform === 'darwin'
  const labels = mac ? MAC_KEY_LABELS : STANDARD_KEY_LABELS
  return keys.map((key) => labels[key] ?? key).join(mac ? '' : '+')
}
