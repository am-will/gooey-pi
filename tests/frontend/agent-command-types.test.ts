import { expectTypeOf, it } from 'vitest'
import type { AgentRpcCommand } from '../../src/types/agent-command'

it('accepts renderer commands and rejects malformed discriminants and fields', () => {
  expectTypeOf<{ type: 'set_service_tier'; serviceTier: 'priority' }>().toExtend<AgentRpcCommand>()
  expectTypeOf<{ type: 'set_thinking_level'; level: 'high' }>().toExtend<AgentRpcCommand>()
  expectTypeOf<{ type: 'extension_ui_response'; id: string; cancelled: true }>().toExtend<AgentRpcCommand>()
  expectTypeOf<{ type: 'set_thinking_level'; level: 'bogus' }>().not.toExtend<AgentRpcCommand>()
  expectTypeOf<{ type: 'set_service_tier'; tier: 'priority' }>().not.toExtend<AgentRpcCommand>()
  expectTypeOf<{ type: 'extension_ui_response'; id: string }>().not.toExtend<AgentRpcCommand>()
})
