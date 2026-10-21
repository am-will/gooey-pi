// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetsSettings } from '../../src/pages/settings/PetsSettings'
import { BUILT_IN_PETS } from '../../src/lib/pets'
import { DEFAULT_SETTINGS } from '../../src/lib/data'
import type { PetDefinition, PrimeWorkApi } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rocky: PetDefinition = { id: 'codex/rocky', petId: 'rocky', displayName: 'Rocky', description: 'A steady rock.', source: 'codex', kind: 'spritesheet' }

describe('PetsSettings', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('refreshes the mounted selected avatar after its sprite changes', async () => {
    let sprite = 'data:image/webp;base64,first'
    const pets = { list: vi.fn(async () => BUILT_IN_PETS), sprite: vi.fn(async () => sprite) }
    await act(async () => { root.render(<PetsSettings settings={{ ...DEFAULT_SETTINGS, petId: 'gooey-pi' }} onUpdate={() => undefined} pets={pets} />) })
    expect(container.querySelector('.pet-hero .pet-sprite img')?.getAttribute('src')).toBe(sprite)
    sprite = 'data:image/webp;base64,second'
    await act(async () => { [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Refresh'))!.click() })
    expect(container.querySelector('.pet-hero .pet-sprite img')?.getAttribute('src')).toBe(sprite)
  })

  it('shows bundled and Codex pets and persists a selected companion', async () => {
    const update = vi.fn()
    const pets = {
      list: vi.fn(async () => [
        { id: 'orb', petId: 'orb', displayName: 'Orb', description: 'Orb.', source: 'built-in', kind: 'orb' } as PetDefinition,
        { id: 'gooey-pi', petId: 'gooey-pi', displayName: 'GooeyPi', description: 'Gooey.', source: 'built-in', kind: 'spritesheet' } as PetDefinition,
        rocky,
      ]),
      sprite: vi.fn(async () => 'data:image/webp;base64,UklGRgQAAABXRUJQ'),
    } satisfies PrimeWorkApi['pets']
    await act(async () => {
      root.render(<PetsSettings settings={DEFAULT_SETTINGS} onUpdate={update} pets={pets} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(container.querySelector('header p')?.textContent).toBe('Choose a companion that reacts while the agent works.')
    expect(container.textContent).toContain('GooeyPi')
    expect(container.textContent).toContain('Rocky')
    expect(container.textContent).toContain('1 Codex pet found')
    expect(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')?.textContent).toContain('Orb')

    const rockyChoice = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((button) => button.textContent?.includes('Rocky'))
    expect(rockyChoice).toBeDefined()
    act(() => rockyChoice!.click())
    expect(update).toHaveBeenCalledWith({ petId: 'codex/rocky', petEnabled: true })

    const size = container.querySelector<HTMLInputElement>('#pet-size')!
    expect(size.value).toBe('75')
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(size, '60')
      size.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ petSize: 60 })
  })
})
