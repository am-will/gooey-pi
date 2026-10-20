import { isRecord } from '../validation'
import type { RpcObject } from './types'

/**
 * How a compact command answered: the result it succeeded with, or the error
 * it failed with.
 */
export type CompactAnswer = { result: unknown } | { error: string }

/** The start of a manual compaction the harness did not announce itself. */
export function manualCompactionStart(command: RpcObject): RpcObject {
  return { type: 'compaction_start', reason: 'manual', ...customInstructions(command), synthetic: true }
}

/**
 * The compaction_end that agrees with a compact command's answer. Harnesses
 * differ in what a manual compaction streams: Pi and Prime stream an end
 * before they answer, while OMP streams nothing and answers with the result
 * alone. A streamed end is kept as the harness sent it and only completed
 * from the answer; without one, the answer stands in for it.
 */
export function settledCompactionEnd(streamed: RpcObject | undefined, command: RpcObject, answer: CompactAnswer): RpcObject {
  const end: RpcObject = streamed
    ? { ...streamed }
    : { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, ...customInstructions(command), synthetic: true }
  if ('result' in answer && !isRecord(end.result) && isRecord(answer.result)) end.result = answer.result
  return end
}

function customInstructions(command: RpcObject): RpcObject {
  return typeof command.customInstructions === 'string' ? { customInstructions: command.customInstructions } : {}
}
