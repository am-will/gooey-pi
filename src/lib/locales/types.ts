import type { englishCatalog } from './english'

/** A catalog entry: plain copy, or the plural pair selected by a `count` value. */
export type Message = string | { one: string; other: string }

/**
 * Every key the English catalog defines. The Japanese and Simplified Chinese
 * catalogs are typed against it, so a missing translation is a compile error.
 */
export type MessageKey = keyof typeof englishCatalog
