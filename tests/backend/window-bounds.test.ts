import { describe, expect, it } from 'vitest'
import { mainWindowBounds } from '../../electron/main/window-bounds'

describe('fresh main window bounds', () => {
  it('centers the fixed starting size within a large usable display area', () => {
    expect(mainWindowBounds({ x: 100, y: 40, width: 1920, height: 1080 })).toEqual({
      x: 340, y: 120, width: 1440, height: 920, minWidth: 960, minHeight: 640,
    })
  })

  it('clamps the size and minimum size to small work areas with negative display origins', () => {
    expect(mainWindowBounds({ x: -800, y: 20, width: 800, height: 600 })).toEqual({
      x: -800, y: 20, width: 800, height: 600, minWidth: 800, minHeight: 600,
    })
  })
})
