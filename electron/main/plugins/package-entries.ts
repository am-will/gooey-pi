import { isRecord } from '../validation'

export const PACKAGE_FILTER_KEYS = ['extensions', 'skills', 'prompts', 'themes'] as const

export function packageSource(value: unknown): string | undefined {
  return typeof value === 'string' ? value : isRecord(value) && typeof value.source === 'string' ? value.source : undefined
}

/** A package is disabled only when every resource category is explicitly empty. */
export function isPackageDisabled(value: unknown): boolean {
  return isRecord(value) && PACKAGE_FILTER_KEYS.every((key) => Array.isArray(value[key]) && value[key].length === 0)
}
