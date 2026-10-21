export { rpcRequestFrameBytes } from '../../../src/lib/rpc-frame'

const MAX_ERROR_DETAIL_CHARS = 4_000
/** Agent-supplied error text, trimmed and bounded for display; undefined when there is none. */
export function boundedErrorDetail(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_ERROR_DETAIL_CHARS) : undefined
}

/**
 * The provider error an assistant message ended with, bounded like any other
 * error detail; undefined unless its stopReason is error. The live run and
 * the transcript read back from disk show the same text.
 */
export function providerErrorDetail(message: Readonly<Record<string, unknown>>): string | undefined {
  return message.stopReason === 'error' ? boundedErrorDetail(message.errorMessage) : undefined
}
