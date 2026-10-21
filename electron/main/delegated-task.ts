import { streamingBehaviorForIntent } from '../../src/lib/session-actions'
import type { PrimeModelDescriptor, PrimeThinkingLevel, RuntimeInfo } from '../../src/types/api'
import type { AgentRpcManager } from './agent-rpc'
import { resolveReasoning } from './model-selection'

export interface PromptedRuntimeRequest {
  cwd: string
  /** Already resolved against the visible catalog; omitted to use the harness default model. */
  model?: PrimeModelDescriptor
  reasoningQuery?: string
  prompt: string
  title?: string
  fast?: boolean
  /** Thrown when the harness accepted the prompt but reported no session file. */
  missingSessionMessage: string
  /** Runs before the runtime is stopped on every abandon path, so callers can drop per-runtime state first. */
  onAbandon?: (runtimeId: string) => void
}

export interface PromptedRuntime {
  runtime: RuntimeInfo & { sessionFile: string }
  reasoning?: PrimeThinkingLevel
}

export type PromptedRuntimeManager = Pick<AgentRpcManager, 'start' | 'command' | 'stop' | 'list'>

/**
 * Starts a new interactive runtime, queues one prompt on it and waits until the harness reports the
 * session file it created. Shared by the voice `start_task` tool and agent-collaboration `create`.
 * Any failure after the runtime starts abandons it (onAbandon, then a best-effort stop).
 */
export async function startPromptedRuntime(manager: PromptedRuntimeManager, request: PromptedRuntimeRequest): Promise<PromptedRuntime> {
  const { model, reasoningQuery } = request
  const selectedReasoning = model && reasoningQuery
    ? resolveReasoning(reasoningQuery, model.availableThinkingLevels)
    : undefined
  const runtime = await manager.start({
    cwd: request.cwd,
    ...(model ? { model: model.key } : {}),
    ...(selectedReasoning ? { thinking: selectedReasoning } : {}),
    ...(request.fast !== undefined ? { fast: request.fast } : {}),
  })
  const abandon = async () => {
    request.onAbandon?.(runtime.runtimeId)
    await manager.stop(runtime.runtimeId).catch(() => false)
  }
  let appliedReasoning = selectedReasoning
  try {
    if (!model && reasoningQuery) {
      appliedReasoning = resolveReasoning(reasoningQuery, runtime.availableThinkingLevels ?? [])
      await manager.command(runtime.runtimeId, { type: 'set_thinking_level', level: appliedReasoning })
    }
    await manager.command(runtime.runtimeId, {
      type: 'prompt',
      message: request.prompt,
      streamingBehavior: streamingBehaviorForIntent('queue'),
    })
    if (request.title) await manager.command(runtime.runtimeId, { type: 'set_session_name', name: request.title }).catch(() => undefined)
    await manager.command(runtime.runtimeId, { type: 'get_state' })
  } catch (error) {
    await abandon()
    throw error
  }
  const current = manager.list().find((candidate) => candidate.runtimeId === runtime.runtimeId) ?? runtime
  const sessionFile = current.sessionFile
  if (!sessionFile) {
    await abandon()
    throw new Error(request.missingSessionMessage)
  }
  return { runtime: { ...current, sessionFile }, ...(appliedReasoning ? { reasoning: appliedReasoning } : {}) }
}
