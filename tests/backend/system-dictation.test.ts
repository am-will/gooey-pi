import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Menu: { sendActionToFirstResponder: vi.fn() } }))

import { Menu } from 'electron'
import { startSystemDictation } from '../../electron/main/system-dictation'

describe('system dictation', () => {
  it('sends the Start Dictation responder action on macOS', () => {
    expect(startSystemDictation('darwin')).toBe(true)
    expect(Menu.sendActionToFirstResponder).toHaveBeenCalledWith('startDictation:')
  })

  it.each(['win32', 'linux'] as const)('reports no platform dictation on %s without sending anything', (platform) => {
    const sendAction = vi.fn()
    expect(startSystemDictation(platform, sendAction)).toBe(false)
    expect(sendAction).not.toHaveBeenCalled()
  })
})
