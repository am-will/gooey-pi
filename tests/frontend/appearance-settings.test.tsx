// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import { AppearanceSettings } from '../../src/pages/settings/AppearanceSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AppearanceSettings', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('offers only the bounded interface text sizes and persists the selected choice', () => {
    const update = vi.fn()
    act(() => root.render(<AppearanceSettings settings={DEFAULT_SETTINGS} onUpdate={update} />))

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Smaller', 'Default', 'Larger'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])

    act(() => options[2].click())
    expect(update).toHaveBeenCalledWith({ interfaceFontScale: 115 })
  })

  it('exposes one tab stop and selects the interface size with arrow, Home, and End keys', () => {
    const update = vi.fn()
    act(() => root.render(<AppearanceSettings settings={DEFAULT_SETTINGS} onUpdate={update} />))

    const group = container.querySelector<HTMLDivElement>('[role="radiogroup"]')!
    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0, -1])

    const press = (key: string) => {
      act(() => { group.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    }

    press('ArrowRight')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 115 })
    expect(document.activeElement).toBe(options[2])

    press('ArrowLeft')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 105 })
    expect(document.activeElement).toBe(options[0])

    press('Home')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 105 })

    press('End')
    expect(update).toHaveBeenLastCalledWith({ interfaceFontScale: 115 })
    expect(update).toHaveBeenCalledTimes(4)
  })
})
