import type { PrimeModelDescriptor } from '@/types/api'

export function isUsableModel(model: PrimeModelDescriptor): boolean {
  return model.enabled !== false && model.available
}

/** Prefer the remembered usable model, then the first usable catalog entry. */
export function preferredModel(models: readonly PrimeModelDescriptor[] | undefined, rememberedKey: string): PrimeModelDescriptor | undefined {
  return models?.find((model) => model.key === rememberedKey && isUsableModel(model))
    ?? models?.find(isUsableModel)
}
