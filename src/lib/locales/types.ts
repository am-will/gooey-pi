import type { englishCatalog } from './english'

/** A catalog entry: plain copy, or the plural pair selected by a `count` value. */
export type Message = string | { one: string; other: string }

/**
 * Every key the English catalog defines. Both the Japanese and Simplified
 * Chinese catalogs are typed against it, so a missing translation is a compile
 * error and the parity test in `tests/frontend/i18n.test.ts` pins the same rule.
 */
export type MessageKey = keyof typeof englishCatalog
