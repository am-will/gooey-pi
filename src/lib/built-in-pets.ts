import type { MessageKey } from '@/lib/i18n'
import type { PetDefinition } from '@/types/api'

/**
 * The bundled pets are authored by GooeyPi, so their copy lives in the message
 * catalog; pets discovered from other sources (Codex) carry their own display
 * name and description and are shown verbatim. Both pets settings and the
 * desktop pet resolve names through this table, so the visible label and the
 * screen-reader label follow the interface language together.
 */
export const BUILT_IN_PET_COPY: Record<string, { name: MessageKey; description: MessageKey }> = {
  orb: { name: 'settings.pets.orb.name', description: 'settings.pets.orb.description' },
  'gooey-pi': { name: 'settings.pets.gooeyPi.name', description: 'settings.pets.gooeyPi.description' },
}

/**
 * Records shown until the main process reports the installed pet set. The
 * English copy mirrors the catalog so an unmapped pet still renders something.
 */
export const BUILT_IN_PETS: PetDefinition[] = [
  { id: 'orb', petId: 'orb', displayName: 'Orb', description: 'A fluid voice orb that shifts with GooeyPi activity.', source: 'built-in', kind: 'orb' },
  { id: 'gooey-pi', petId: 'gooey-pi', displayName: 'GooeyPi', description: 'A friendly purple jelly pet shaped like the mathematical pi symbol.', source: 'built-in', kind: 'spritesheet' },
]

/** Display name for a pet record: catalog copy for bundled pets, else its own name. */
export function petDisplayName(pet: PetDefinition, t: (key: MessageKey) => string): string {
  const copy = BUILT_IN_PET_COPY[pet.id]
  return copy ? t(copy.name) : pet.displayName
}
