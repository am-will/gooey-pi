/**
 * Collapse whitespace runs to single spaces and clip to `max` characters with a
 * trailing ellipsis. Main derives persisted session titles with this, so the
 * renderer's optimistic title must use it too to avoid a visible title flip.
 */
export function compactText(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}
