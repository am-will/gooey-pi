import type { englishCatalog } from './english'

/** A catalog entry: plain copy, or the plural pair selected by a `count` value. */
export type Message = string | { one: string; other: string }

/**
 * Every key the English catalog defines. The Japanese catalog is typed against
 * it (a missing key is a compile error) and the Simplified Chinese catalog is a
 * deliberate `Partial` subset (see `tests/frontend/i18n.test.ts`).
 */
export type MessageKey = keyof typeof englishCatalog
