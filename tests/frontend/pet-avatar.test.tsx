import { clearPetSpriteCache } from '../../src/lib/pet-sprite-cache'
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PetAvatar, type PetActivity } from '../../src/components/PetAvatar'
import type { PetDefinition, PrimeWorkApi } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const pet: PetDefinition = {
  id: 'gooey-pi',
  petId: 'gooey-pi',
  displayName: 'GooeyPi',
  description: 'Gooey.',
  source: 'built-in',
  kind: 'spritesheet',
}
const pets = {
  list: vi.fn(async () => [pet]),
  sprite: vi.fn(async () => 'data:image/webp;base64,UklGRgQAAABXRUJQ'),
} satisfies PrimeWorkApi['pets']

describe('PetAvatar', () => {
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
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function renderActivity(activity: PetActivity, reduceMotion = true) {
    await act(async () => {
      root.render(<PetAvatar pet={pet} pets={pets} activity={activity} size={192} reduceMotion={reduceMotion} />)
      await Promise.resolve()
    })
    return container.querySelector<HTMLImageElement>('.pet-sprite img')!
  }

  it('shares sprites across avatar remounts and reloads after an explicit refresh', async () => {
    const api = { ...pets, sprite: vi.fn(async () => 'data:image/webp;base64,UklGRgQAAABXRUJQ') }
    const render = () => act(async () => { root.render(<PetAvatar pet={pet} pets={api} reduceMotion />) })
    await render()
    await act(async () => root.render(null))
    await render()
    expect(api.sprite).toHaveBeenCalledTimes(1)
    clearPetSpriteCache(api)
    await act(async () => root.render(null))
    await render()
    expect(api.sprite).toHaveBeenCalledTimes(2)
  })

  it('retries missing sprites on the next mount', async () => {
    const api = { ...pets, sprite: vi.fn().mockResolvedValueOnce(null).mockResolvedValue('data:image/webp;base64,UklGRgQAAABXRUJQ') }
    await act(async () => { root.render(<PetAvatar pet={pet} pets={api} reduceMotion />) })
    await act(async () => root.render(null))
    await act(async () => { root.render(<PetAvatar pet={pet} pets={api} reduceMotion />) })
    expect(api.sprite).toHaveBeenCalledTimes(2)
    expect(container.querySelector('.pet-sprite img')).not.toBeNull()
  })

  it('maps app activity names to the matching v2.2 atlas rows', async () => {
    expect((await renderActivity('waiting')).style.transform).toBe('translate(0px, -1248px)')
    expect((await renderActivity('working')).style.transform).toBe('translate(0px, -1664px)')
    expect((await renderActivity('speaking')).style.transform).toBe('translate(0px, -624px)')
  })

  it('uses the authored per-frame timing instead of a uniform interval', async () => {
    vi.useFakeTimers()
    const image = await renderActivity('idle', false)
    act(() => vi.advanceTimersByTime(279))
    expect(image.style.transform).toBe('translate(0px, 0px)')
    act(() => vi.advanceTimersByTime(1))
    expect(image.style.transform).toBe('translate(-192px, 0px)')
    act(() => vi.advanceTimersByTime(110))
    expect(image.style.transform).toBe('translate(-384px, 0px)')
  })
})
