import type { PrimeContextUsage } from '../../../src/types/api'
import { isRecord } from '../validation'
import type { RpcObject } from './types'

const CHARS_PER_TOKEN_ESTIMATE = 4

export interface LiveContextUsageUpdate {
  changed: boolean
  reset: boolean
}

function boundedTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function assistantMessage(event: RpcObject): RpcObject | null {
  if (!isRecord(event.message)) return null
  return event.message.role === 'assistant' ? event.message : null
}

/**
 * Tracks output generated since the latest user message. Providers usually
 * include an output-token count on partial assistant messages; character
 * deltas keep the estimate moving for providers that report usage only when
 * the message finishes.
 */
export class LiveContextUsageTracker {
  private completedTokens = 0
  private streamingUsageTokens = 0
  private streamingChars = 0
  private reportedTokens = 0

  get tokens(): number { return this.reportedTokens }

  handleEvent(event: RpcObject): LiveContextUsageUpdate {
    const previous = this.reportedTokens
    if (event.type === 'message_start' && isRecord(event.message) && event.message.role === 'user') {
      this.reset()
      return { changed: previous !== 0, reset: true }
    }

    if (event.type === 'message_update') {
      // message_update is assistant-only in the RPC protocol. When a harness
      // supplies the message, still reject a contradictory role.
      if (isRecord(event.message) && event.message.role !== 'assistant') return { changed: false, reset: false }
      const delta = isRecord(event.assistantMessageEvent) && typeof event.assistantMessageEvent.delta === 'string'
        ? event.assistantMessageEvent.delta
        : ''
      this.streamingChars = saturatingAdd(this.streamingChars, delta.length)
      const message = assistantMessage(event)
      const usage = message && isRecord(message.usage) ? boundedTokenCount(message.usage.output) : undefined
      if (usage !== undefined) this.streamingUsageTokens = usage
      this.captureCurrentTokens()
    } else if (event.type === 'message_end') {
      const message = assistantMessage(event)
      if (!message) return { changed: false, reset: false }
      const usage = isRecord(message.usage) ? boundedTokenCount(message.usage.output) : undefined
      const completed = usage !== undefined && usage > 0 ? usage : this.estimatedStreamingTokens()
      this.completedTokens = saturatingAdd(this.completedTokens, completed)
      this.streamingUsageTokens = 0
      this.streamingChars = 0
      this.captureCurrentTokens()
    }

    return { changed: this.reportedTokens !== previous, reset: false }
  }

  reset(): void {
    this.completedTokens = 0
    this.streamingUsageTokens = 0
    this.streamingChars = 0
    this.reportedTokens = 0
  }

  private captureCurrentTokens(): void {
    const streaming = Math.max(this.streamingUsageTokens, this.estimatedStreamingTokens())
    this.reportedTokens = Math.max(this.reportedTokens, saturatingAdd(this.completedTokens, streaming))
  }

  private estimatedStreamingTokens(): number {
    return Math.round(this.streamingChars / CHARS_PER_TOKEN_ESTIMATE)
  }
}

/** Adds only output produced after the authoritative snapshot was captured. */
export function withLiveContextUsage(
  snapshot: PrimeContextUsage,
  activityTokens: number,
  snapshotActivityTokens: number,
): PrimeContextUsage {
  if (snapshot.tokens === null || snapshot.percent === null) return snapshot
  const inFlight = Math.max(0, activityTokens - snapshotActivityTokens)
  if (inFlight === 0) return snapshot
  const tokens = saturatingAdd(snapshot.tokens, inFlight)
  return {
    tokens,
    contextWindow: snapshot.contextWindow,
    percent: (tokens / snapshot.contextWindow) * 100,
  }
}

/**
 * A new provider request and compaction re-base the live overlay. Prime and
 * pi snapshots count the latest response's output, which the growth check in
 * applySnapshot detects; OMP snapshots count only the prompt that produced
 * it, so that check never passes during a tool loop. Re-basing at each
 * request keeps the overlay to the response in flight instead of piling up
 * every earlier one, at the cost of briefly omitting the previous response
 * until a snapshot counts it. Compaction rewrites the history any earlier
 * output belonged to.
 */
function rebasesLiveActivity(event: RpcObject): boolean {
  return event.type === 'compaction_start'
    || event.type === 'compaction_end'
    || (event.type === 'message_start' && assistantMessage(event) !== null)
}

/**
 * Projects the agent's latest authoritative context-usage snapshot forward
 * with the output streamed since it was captured. The generation advances
 * whenever earlier snapshots stop describing the session, so stats requested
 * before that point can be discarded when they answer.
 */
export class ContextUsageProjection {
  private readonly live = new LiveContextUsageTracker()
  private snapshot: PrimeContextUsage | undefined
  /** Live activity tokens the snapshot already accounts for. */
  private snapshotActivityTokens = 0
  /** Activity proved to be included in the stored snapshot, unaffected by request rebases. */
  private capturedActivityTokens = 0
  private snapshotGeneration = 0

  get generation(): number { return this.snapshotGeneration }

  get activityTokens(): number { return this.live.tokens }

  /** Feeds one normalized agent event; returns true when the projection may have moved. */
  handleEvent(event: RpcObject): boolean {
    const update = this.live.handleEvent(event)
    if (update.reset) {
      this.snapshotActivityTokens = 0
      this.capturedActivityTokens = 0
      this.snapshotGeneration += 1
      return true
    }
    if (!rebasesLiveActivity(event)) return update.changed
    const rebased = this.snapshotActivityTokens !== this.live.tokens
    this.snapshotActivityTokens = this.live.tokens
    // Stats requested before a compaction ended describe the history it replaced.
    if (event.type === 'compaction_end') {
      this.capturedActivityTokens = this.live.tokens
      this.snapshotGeneration += 1
    }
    return update.changed || rebased
  }

  /** Adopts an authoritative snapshot; activityTokens is the live activity when its refresh was requested. */
  applySnapshot(usage: PrimeContextUsage, activityTokens?: number): void {
    if (activityTokens !== undefined) {
      const previous = this.snapshot
      // The harness can capture stats after newer output than was present
      // when the request was sent. Count that output only once when snapshot
      // growth covers it, including any earlier output hidden by a rebase.
      const liveDelta = Math.max(0, this.live.tokens - this.capturedActivityTokens)
      if (previous?.tokens !== undefined && previous.tokens !== null && usage.tokens !== null
        && usage.tokens >= previous.tokens + liveDelta) activityTokens = this.live.tokens
      const activityDelta = Math.max(0, activityTokens - this.snapshotActivityTokens)
      // A message_end event is forwarded just before persistence. If a very
      // fast stats response still reflects the preceding message, keep its
      // activity live and let the guaranteed trailing refresh absorb it.
      const includesActivity = activityDelta === 0
        || previous === undefined
        || previous.tokens === null
        || usage.tokens === null
        || usage.tokens >= previous.tokens + activityDelta
      if (includesActivity) {
        this.snapshotActivityTokens = Math.max(this.snapshotActivityTokens, activityTokens)
      }
      // A request rebase can make activityDelta zero without the stored
      // snapshot including that output. The first numeric snapshot establishes
      // the same baseline as the overlay; later snapshots must prove growth.
      const uncapturedActivity = Math.max(0, activityTokens - this.capturedActivityTokens)
      if (usage.tokens !== null && (previous === undefined || previous.tokens === null
        || usage.tokens >= previous.tokens + uncapturedActivity)) {
        this.capturedActivityTokens = Math.max(this.capturedActivityTokens, activityTokens)
      }
    }
    this.snapshot = usage
  }

  /** Folds live activity into the snapshot at a run boundary, leaving current() unchanged, until the next authoritative refresh replaces it. */
  bake(): void {
    if (!this.snapshot) return
    this.snapshot = this.current()
    this.snapshotActivityTokens = this.live.tokens
    this.capturedActivityTokens = this.live.tokens
  }

  /** Forgets everything about the previous session. */
  reset(): void {
    this.live.reset()
    this.snapshot = undefined
    this.snapshotActivityTokens = 0
    this.capturedActivityTokens = 0
    this.snapshotGeneration += 1
  }

  current(): PrimeContextUsage | undefined {
    return this.snapshot && withLiveContextUsage(this.snapshot, this.live.tokens, this.snapshotActivityTokens)
  }
}
