import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_PETS, DEFAULT_PET_ID, ORB_PET, selectPet } from '../../src/lib/pets'
import type { PetDefinition } from '../../src/types/api'

const codexPet: PetDefinition = { id: 'codex/fox', petId: 'fox', displayName: 'Fox', description: 'Fox.', source: 'codex', kind: 'spritesheet' }
const listedOrb: PetDefinition = { ...ORB_PET, description: 'Listed orb.' }

describe('pets', () => {
  it('defaults to the built-in orb', () => {
    expect(DEFAULT_PET_ID).toBe('orb')
    expect(ORB_PET).toMatchObject({ id: DEFAULT_PET_ID, petId: DEFAULT_PET_ID, source: 'built-in', kind: 'orb' })
    expect(BUILT_IN_PETS[0]).toBe(ORB_PET)
  })

  it('keeps the renderer GooeyPi fallback in sync with the bundled manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../assets/pets/gooey-pi/pet.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const gooey = BUILT_IN_PETS.find((pet) => pet.id === manifest.id)
    expect(gooey).toEqual({ id: manifest.id, petId: manifest.id, displayName: manifest.displayName, description: manifest.description, source: 'built-in', kind: 'spritesheet' })
    expect(new Set(BUILT_IN_PETS.map((pet) => pet.id)).size).toBe(BUILT_IN_PETS.length)
  })

  it('selects the requested pet when it is available', () => {
    expect(selectPet([listedOrb, codexPet], 'codex/fox')).toBe(codexPet)
    expect(selectPet(BUILT_IN_PETS, 'gooey-pi')).toBe(BUILT_IN_PETS[1])
  })

  it('falls back to the listed default pet when the selection is missing', () => {
    expect(selectPet([codexPet, listedOrb], 'codex/gone')).toBe(listedOrb)
    expect(selectPet([codexPet, listedOrb], '')).toBe(listedOrb)
  })

  it('falls back to the built-in orb when neither the selection nor the default is listed', () => {
    expect(selectPet([codexPet], 'codex/gone')).toBe(ORB_PET)
    expect(selectPet([], 'gooey-pi')).toBe(ORB_PET)
  })
})
