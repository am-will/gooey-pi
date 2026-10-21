import type { Rectangle } from 'electron'

/** Fresh windows fit and center inside the primary display's usable area. */
export function mainWindowBounds(workArea: Rectangle) {
  const width = Math.min(1440, workArea.width)
  const height = Math.min(920, workArea.height)
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(960, width),
    minHeight: Math.min(640, height),
  }
}
