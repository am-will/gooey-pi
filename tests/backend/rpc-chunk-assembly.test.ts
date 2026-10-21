import { describe, expect, it } from 'vitest'
import { RpcChunkAssembler } from '../../electron/main/agent-rpc/chunk-assembly'
import type { RpcObject } from '../../electron/main/agent-rpc/types'

function fixture() {
  const events: RpcObject[] = []
  const delivered: unknown[] = []
  const chunks = new RpcChunkAssembler({ agentName: 'OMP', active: () => false, emit: (event) => events.push(event), deliver: (frame) => delivered.push(frame) })
  const send = (id: string, index: number, count: number, text = '{}') => chunks.accept({ type: 'rpc_chunk', chunkId: id, index, count, data: Buffer.from(text).toString('base64') })
  return { chunks, events, delivered, send }
}

describe('abandoned RPC chunk sequences', () => {
  it('reports one limit per abandoned ID and silently drops its remaining chunks', () => {
    const f = fixture()
    f.send('bad', 0, 3, '{')
    f.send('bad', 2, 3, '}')
    f.send('bad', 1, 3, '"type":"agent_start"')
    f.send('bad', 2, 3, '}')
    expect(f.events).toHaveLength(1)
    expect(f.events[0]).toMatchObject({ type: 'transport_limit', kind: 'chunk' })
    f.send('good', 0, 1, '{"type":"agent_start"}')
    expect(f.delivered).toEqual([{ type: 'agent_start' }])
    f.chunks.close()
  })

  it('bounds abandoned IDs and accepts a new sequence after its old ID ages out', () => {
    const f = fixture()
    for (let index = 0; index < 17; index += 1) f.send(`bad-${index}`, 1, 2)
    expect(f.events).toHaveLength(17)
    f.send('bad-16', 0, 1, '{"type":"ignored"}')
    expect(f.delivered).toEqual([])
    f.send('bad-0', 0, 1, '{"type":"reused"}')
    expect(f.delivered).toEqual([{ type: 'reused' }])
    f.chunks.close()
  })
})
