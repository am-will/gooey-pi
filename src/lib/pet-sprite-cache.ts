import type { PrimeWorkApi } from '@/types/api'

type PetsApi = PrimeWorkApi['pets']
const caches = new WeakMap<PetsApi, Map<string, Promise<string | null>>>()
const MAX_CACHED_SPRITES = 8

export function clearPetSpriteCache(pets: PetsApi): void {
  caches.delete(pets)
}

/** Share concurrent and repeated avatar reads; failures remain retryable. */
export function cachedPetSprite(pets: PetsApi, id: string): Promise<string | null> {
  let cache = caches.get(pets)
  if (!cache) { cache = new Map(); caches.set(pets, cache) }
  const existing = cache.get(id)
  if (existing) return existing
  const entries = cache
  const pending = Promise.resolve().then(() => pets.sprite(id)).then((value) => {
    if (!value && entries.get(id) === pending) entries.delete(id)
    return value
  }, (error: unknown) => {
    if (entries.get(id) === pending) entries.delete(id)
    throw error
  })
  entries.set(id, pending)
  if (entries.size > MAX_CACHED_SPRITES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  return pending
}
