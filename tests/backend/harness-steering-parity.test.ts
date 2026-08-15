import { describe, expect, it } from 'vitest'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER } from '../../electron/main/agent-rpc'
import { parseSessionActionSnapshot } from '../../src/lib/session-actions'

const adapters = [
  ['Prime Agent', PRIME_RPC_ADAPTER],
  ['OMP', OMP_RPC_ADAPTER],
  ['Pi', PI_RPC_ADAPTER],
] as const

describe.each(adapters)('%s steering protocol parity', (_name, adapter) => {
  it('passes steer commands through the shared RPC vocabulary', () => {
    const command = { type: 'steer', message: 'change direction' }
    expect(adapter.translateCommand(command)).toBe(command)
  })

  it('preserves the existing image payload for prompts and steers', () => {
    const images = [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]
    const prompt = { type: 'prompt', message: 'inspect', images }
    const steer = { type: 'steer', message: 'inspect this instead', images }

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

    const normalizedQueued = adapter.normalizeEvent(queued)
    const normalizedPickedUp = adapter.normalizeEvent(pickedUp)
    expect(normalizedQueued).toBe(queued)
    expect(normalizedPickedUp).toBe(pickedUp)
    expect(parseSessionActionSnapshot(normalizedQueued?.actions)).toEqual(queued.actions)
    expect(parseSessionActionSnapshot(normalizedPickedUp?.actions)).toEqual(pickedUp.actions)
  })
})
