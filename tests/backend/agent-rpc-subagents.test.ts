import { describe, expect, it } from 'vitest'
import { validateRpcCommand } from '../../electron/main/agent-rpc/command-schema'
import { OMP_RPC_ADAPTER, PI_RPC_ADAPTER, PRIME_RPC_ADAPTER } from '../../electron/main/agent-rpc/harness-adapter'
import { SUBAGENT_SUBSCRIPTION_LEVELS } from '../../src/types/api'

const passthrough = async (path: string) => path
const validate = (command: unknown) => validateRpcCommand(command, passthrough)

describe('subagent roster command schema', () => {
  it('exposes get_subagents as an argument-free command', async () => {
    await expect(validate({ type: 'get_subagents' })).resolves.toEqual({ type: 'get_subagents' })
    await expect(validate({ type: 'get_subagents', sessionFile: '/tmp/a.jsonl' })).rejects.toThrow('command.sessionFile is not supported')
  })

  it('accepts every subscription level the harness actually implements', async () => {
    // Verified against omp 17.2.9: these three are accepted and every other
    // value is rejected by the harness itself.
    expect(SUBAGENT_SUBSCRIPTION_LEVELS).toEqual(['off', 'progress', 'events'])
    for (const level of SUBAGENT_SUBSCRIPTION_LEVELS) {
      await expect(validate({ type: 'set_subagent_subscription', level })).resolves.toEqual({ type: 'set_subagent_subscription', level })
    }
  })

  it('rejects an unknown level, a non-string level, and unknown keys', async () => {
    await expect(validate({ type: 'set_subagent_subscription', level: 'lifecycle' })).rejects.toThrow('Invalid subagent subscription level')
    await expect(validate({ type: 'set_subagent_subscription', level: 'all' })).rejects.toThrow('Invalid subagent subscription level')
    await expect(validate({ type: 'set_subagent_subscription', level: 2 })).rejects.toThrow('level must be a string')
    await expect(validate({ type: 'set_subagent_subscription' })).rejects.toThrow('level must be a string')
    // OMP itself ignores unknown keys here; GooeyPi does not forward them.
    await expect(validate({ type: 'set_subagent_subscription', level: 'progress', subscription: 'progress' })).rejects.toThrow('command.subscription is not supported')
  })

  it('does not expose the subagent transcript read, which stays a v1 non-goal', async () => {
    // docs/omp-integration.md lists subagent transcript streaming as a v1
    // non-goal. The roster needs no transcript, and exposing `sessionFile`
    // here would let the renderer ask the harness to read an arbitrary path.
    await expect(validate({ type: 'get_subagent_messages', subagentId: 'Alpha' })).rejects.toThrow('is not exposed to the renderer')
  })
})

describe('subagent roster harness gating', () => {
  it('declares the capability only for OMP', () => {
    expect(OMP_RPC_ADAPTER.subagentInspection).toBe(true)
    expect(PRIME_RPC_ADAPTER.subagentInspection).toBeFalsy()
    expect(PI_RPC_ADAPTER.subagentInspection).toBeFalsy()
  })

  it('translates the roster family for OMP and fails closed for the others', () => {
    for (const command of [{ type: 'get_subagents' }, { type: 'set_subagent_subscription', level: 'progress' }]) {
      expect(OMP_RPC_ADAPTER.translateCommand(command)).toEqual(command)
      expect(() => PRIME_RPC_ADAPTER.translateCommand(command)).toThrow('is not supported by the Prime Agent harness')
      expect(() => PI_RPC_ADAPTER.translateCommand(command)).toThrow('is not supported by the Pi harness')
    }
  })

  it('leaves the rest of each harness vocabulary untouched', () => {
    expect(OMP_RPC_ADAPTER.translateCommand({ type: 'fork', entryId: 'e1' })).toEqual({ type: 'branch', entryId: 'e1' })
    expect(PRIME_RPC_ADAPTER.translateCommand({ type: 'get_state' })).toEqual({ type: 'get_state' })
    expect(PI_RPC_ADAPTER.translateCommand({ type: 'get_state' })).toEqual({ type: 'get_state' })
    expect(() => PI_RPC_ADAPTER.translateCommand({ type: 'observe', activeSessionId: 'a' })).toThrow('is not supported by the Pi harness')
  })

  it('passes subagent push frames through OMP event normalization unchanged', () => {
    // The renderer reducer owns these frames; normalizeEvent must not swallow
    // or rewrite them the way it does for auto_compaction_*.
    for (const type of ['subagent_lifecycle', 'subagent_progress', 'subagent_event']) {
      const event = { type, payload: { id: 'Alpha' } }
      expect(OMP_RPC_ADAPTER.normalizeEvent(event)).toEqual(event)
    }
  })
})
