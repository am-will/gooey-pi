import { describe, expect, it } from 'vitest'
import { rpcRequestFrameBytes as mainRpcRequestFrameBytes } from '../../electron/main/agent-rpc/limits'
import { RPC_WRITE_FRAME_LIMIT_BYTES as MAIN_RPC_WRITE_FRAME_LIMIT_BYTES } from '../../electron/main/jsonl-limits'
import { RPC_WRITE_FRAME_LIMIT_BYTES, rpcRequestFrameBytes } from '../../src/lib/rpc-frame'

const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000'
const bufferFrameBytes = (command: Record<string, unknown>) => Buffer.byteLength(`${JSON.stringify({ ...command, id: PLACEHOLDER_ID })}\n`, 'utf8')

describe('rpc-frame', () => {
  it('is the write frame limit main enforces', () => {
    expect(RPC_WRITE_FRAME_LIMIT_BYTES).toBe(2 * 1024 * 1024)
    expect(MAIN_RPC_WRITE_FRAME_LIMIT_BYTES).toBe(RPC_WRITE_FRAME_LIMIT_BYTES)
  })

  it('counts UTF-8 bytes of the newline-terminated frame, not UTF-16 code units', () => {
    const command = { type: 'prompt', message: 'héllo — 日本語 👋🏽' }
    const frame = `${JSON.stringify({ ...command, id: PLACEHOLDER_ID })}\n`
    expect(rpcRequestFrameBytes(command)).toBe(bufferFrameBytes(command))
    expect(rpcRequestFrameBytes(command)).toBeGreaterThan(frame.length)
  })

  it('matches Buffer.byteLength and main for a multibyte prompt with an image', () => {
    const command = {
      type: 'prompt',
      message: 'Describe this screenshot: “ünïcödé” ✓ 漢字 🧪',
      streamingBehavior: 'followUp',
      images: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(new Uint8Array(4096).map((_, index) => index % 251)).toString('base64') }],
    }
    expect(rpcRequestFrameBytes(command)).toBe(bufferFrameBytes(command))
    expect(rpcRequestFrameBytes(command)).toBe(mainRpcRequestFrameBytes(command))
  })

  it('measures with the placeholder id, overriding any id already on the command', () => {
    const withId = { type: 'get_state', id: 'x' }
    expect(rpcRequestFrameBytes(withId)).toBe(rpcRequestFrameBytes({ type: 'get_state' }))
    expect(rpcRequestFrameBytes({ type: 'get_state' })).toBe(`{"type":"get_state","id":"${PLACEHOLDER_ID}"}\n`.length)
  })
})
