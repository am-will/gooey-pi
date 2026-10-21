// Shared by the renderer and the main process (via electron/main/jsonl-limits.ts), so this module
// must stay pure: relative imports only, no `@/` aliases and no DOM- or Node-only APIs.

/** Largest JSONL frame GooeyPi writes to a harness RPC child's stdin, including the trailing newline. */
export const RPC_WRITE_FRAME_LIMIT_BYTES = 2 * 1024 * 1024

// Request ids are UUIDs, so a fixed placeholder of the same length gives the exact frame size before
// the transport assigns the real id.
const RPC_REQUEST_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

/** UTF-8 byte length of the newline-terminated frame the RPC transport writes for `command`. */
export function rpcRequestFrameBytes(command: Record<string, unknown>): number {
  return new TextEncoder().encode(`${JSON.stringify({ ...command, id: RPC_REQUEST_ID_PLACEHOLDER })}\n`).byteLength
}
