import type { PetDefinition } from '../types/api'

/** Pet shown when settings name no pet, or one that is no longer available. */
export const DEFAULT_PET_ID = 'orb'

/** The built-in voice orb; main lists it ahead of every packaged pet. */
export const ORB_PET: PetDefinition = { id: 'orb', petId: 'orb', displayName: 'Orb', description: 'A fluid voice orb that shifts with GooeyPi activity.', source: 'built-in', kind: 'orb' }

// Renderer fallback used before or without pets.list(); main reads the GooeyPi entry from assets/pets/gooey-pi/pet.json.
export const BUILT_IN_PETS: readonly PetDefinition[] = [
  ORB_PET,
  { id: 'gooey-pi', petId: 'gooey-pi', displayName: 'GooeyPi', description: 'A friendly purple jelly pet shaped like the mathematical pi symbol.', source: 'built-in', kind: 'spritesheet' },
]

/** Resolve the selected pet, falling back to the default pet and then the orb. */
export function selectPet(available: readonly PetDefinition[], petId: string): PetDefinition {
  return available.find((item) => item.id === petId) ?? available.find((item) => item.id === DEFAULT_PET_ID) ?? ORB_PET
}
