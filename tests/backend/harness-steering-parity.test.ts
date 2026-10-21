import type { ValidatedRpcCommand } from '../../electron/main/agent-rpc/command-schema'
import type { PromptImage } from '../../src/types/api'
import { describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER, PRIME_RUST_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { parseSessionActionSnapshot } from '../../src/lib/session-actions'

const adapters = [
  ['Prime Agent', PRIME_RPC_ADAPTER],
  ['Rust Prime Agent', PRIME_RUST_RPC_ADAPTER],
  ['OMP', OMP_RPC_ADAPTER],
  ['Pi', PI_RPC_ADAPTER],
] as const

describe.each(adapters)('%s steering protocol parity', (_name, adapter) => {
  it('passes steer commands through the shared RPC vocabulary', () => {
    const command = { type: 'steer', message: 'change direction' } satisfies ValidatedRpcCommand
    expect(adapter.translateCommand(command)).toBe(command)
  })

  it('preserves the existing image payload for prompts and steers', () => {
    const images: PromptImage[] = [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
    const prompt = { type: 'prompt', message: 'inspect', images } satisfies ValidatedRpcCommand
    const steer = { type: 'steer', message: 'inspect this instead', images } satisfies ValidatedRpcCommand

    expect(adapter.translateCommand(prompt)).toBe(prompt)
    expect(adapter.translateCommand(steer)).toBe(steer)
  })

  it('preserves both queued and picked-up session action snapshots', () => {
    const queued = {
      type: 'session_action_update',
      actions: { queuedCount: 1, steering: ['change direction'], followUps: [] },
    }
    const pickedUp = {
      type: 'session_action_update',
      actions: {
        queuedCount: 0,
        steering: [],
        followUps: [],
        active: { kind: 'turn', phase: 'preparing', label: 'change direction' },
      },
    }

    const state = { runtimeId: 'runtime', harness: adapter.id, cwd: '/project', isStreaming: true }
    expect(adapter.normalizeEvent(queued, state)).toBe(queued)
    expect(adapter.normalizeEvent(pickedUp, state)).toBe(pickedUp)
    expect(parseSessionActionSnapshot(queued.actions)).toEqual(queued.actions)
    expect(parseSessionActionSnapshot(pickedUp.actions)).toEqual(pickedUp.actions)
  })

  it('lets the renderer settle a steer before the user message that delivers it', () => {
    const running = { kind: 'turn', phase: 'running' } as const
    const state = {
      runtimeId: 'runtime', harness: adapter.id, cwd: '/project', isStreaming: true,
      sessionActions: { queuedCount: 1, steering: ['change direction'], followUps: [], active: running },
    }
    const delivered = { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'change direction' }] } }

    // A harness that reports its own queue changes needs nothing extra; for
    // one that does not, the adapter puts the pickup ahead of the message.
    expect(adapter.normalizeEvent(delivered, state)).toEqual(adapter.sessionActionEvents === false
      ? [{ type: 'session_action_update', synthetic: true, actions: { queuedCount: 0, steering: [], followUps: [], active: running } }, delivered]
      : delivered)
  })
})
