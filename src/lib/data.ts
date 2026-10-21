export { DEFAULT_SETTINGS } from './default-settings'

export function formatRelative(value?: string | number): string {
  if (!value) return ''
  const timestamp = typeof value === 'number' ? value : new Date(value).getTime()
  // Intl.RelativeTimeFormat throws on non-finite values, which would crash the rendering subtree.
  if (!Number.isFinite(timestamp)) return ''
  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return 'now'
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour')
  if (abs < 604800) return formatter.format(Math.round(seconds / 86400), 'day')
  return formatter.format(Math.round(seconds / 604800), 'week')
}

/** Last path segment for POSIX and Windows separators, ignoring trailing separators. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
