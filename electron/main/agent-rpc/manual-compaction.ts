import { isRecord } from '../validation'
import type { HarnessRpcAdapter } from './harness-adapter'
import type { RpcObject } from './types'

/**
 * How a compact command answered: the result it succeeded with, or the error
 * it failed with and whether that error only refused a compaction there was
 * nothing to do for yet.
 */
export type CompactAnswer = { result: unknown } | { error: string; refusal: boolean }

/**
 * Whether a compact command failed only because there is nothing to compact
 * yet. TypeScript Prime marks such an end itself, as a warning; for the other
 * harnesses the adapter recognizes the refusal by its error.
 */
export function isCompactRefusal(adapter: Pick<HarnessRpcAdapter, 'compactRefusal'>, streamed: RpcObject | undefined, error: string): boolean {
  if (streamed?.aborted === true) return false
  return streamed?.errorSeverity === 'warning' || adapter.compactRefusal.test(error)
}

/** The start of a manual compaction the harness did not announce itself. */
export function manualCompactionStart(command: RpcObject): RpcObject {
  return { type: 'compaction_start', reason: 'manual', ...customInstructions(command), synthetic: true }
}

/**
 * The compaction_end that agrees with a compact command's answer. Harnesses
 * differ in what a manual compaction streams: Pi and Prime stream an end
 * before they answer, while OMP streams nothing and answers with the result
 * alone, and Rust Prime streams the same bare end for every compaction that
 * did not succeed. A streamed end is kept as the harness sent it and only
 * completed from the answer; without one, the answer stands in for it. A
 * refusal ends as a skipped compaction (errorSeverity 'warning', as Prime
 * reports a skip) that says why in the harness's words, even where its end
 * called it a failure.
 */
export function settledCompactionEnd(streamed: RpcObject | undefined, command: RpcObject, answer: CompactAnswer): RpcObject {
  const end: RpcObject = streamed
    ? { ...streamed }
    : { type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false, ...customInstructions(command), synthetic: true }
  if ('result' in answer) {
    if (!isRecord(end.result) && isRecord(answer.result)) end.result = answer.result
  } else if (answer.refusal) {
    end.errorSeverity = 'warning'
    end.errorMessage = answer.error
  } else if (end.aborted !== true && end.errorMessage === undefined) {
    end.errorMessage = answer.error
  }
  return end
}

function customInstructions(command: RpcObject): RpcObject {
  return typeof command.customInstructions === 'string' ? { customInstructions: command.customInstructions } : {}
}
