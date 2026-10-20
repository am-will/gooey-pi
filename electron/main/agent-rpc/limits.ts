import { RPC_WRITE_FRAME_LIMIT_BYTES } from '../jsonl-limits'
import type { RpcObject } from './types'

export const MAX_RPC_WRITE_FRAME_BYTES = RPC_WRITE_FRAME_LIMIT_BYTES
const MAX_ERROR_DETAIL_CHARS = 4_000
const RPC_REQUEST_ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

export function rpcRequestFrameBytes(command: RpcObject): number {
  return Buffer.byteLength(`${JSON.stringify({ ...command, id: RPC_REQUEST_ID_PLACEHOLDER })}
`, 'utf8')
}

/** Agent-supplied error text, trimmed and bounded for display; undefined when there is none. */
export function boundedErrorDetail(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_ERROR_DETAIL_CHARS) : undefined
}
