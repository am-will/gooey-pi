/**
 * The renderer's one way to turn an unknown thrown value into display text.
 * With a fallback, an Error without a message and any non-Error value show the
 * fallback instead of an empty string or a stringified value.
 */
export function errorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error && error.message) return error.message
  if (fallback !== undefined) return fallback
  return error instanceof Error ? error.message : String(error)
}
