import type { HarnessId } from './harness'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'complete' | 'failed' | 'unknown'
export interface SessionRecord {
  id: string
  /** Agent harness that owns this session; populated by the owning session service. */
  harness: HarnessId
  filePath: string
  projectPath: string
  title: string
  createdAt: string
  updatedAt: string
  lastUserMessageAt?: string
  status: SessionStatus
  model?: string
  provider?: string
  thinkingLevel?: string
  depth: number
  pinned?: boolean
  unread?: boolean
  /** Monotonic renderer lifecycle revision used to distinguish attention events. */
  eventRevision?: number
  /** Lifecycle revision that authored the current status; absent when the catalog owns it. */
  statusEventRevision?: number
  preview?: string
  archived?: boolean
  syncRevision?: number
}
export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
}
export type PrimeCompactionReason = 'manual' | 'threshold' | 'overflow' | 'requested' | 'idle' | 'incomplete'
export type PrimeCompactionStatus = 'running' | 'done' | 'failed' | 'cancelled'
export type PrimeCompactionOutcome = 'failed' | 'cancelled' | 'skipped'
export type TranscriptTextNotice =
  | { kind: 'provider-fallback'; label: string; from?: string }
  | { kind: 'empty-turn' }
  | { kind: 'steer-read'; count: number }
export type MessagePart =
  | { type: 'text'; partId?: string; text: string; notice?: TranscriptTextNotice }
  | { type: 'thinking'; partId?: string; text: string }
  | { type: 'toolCall'; partId?: string; id?: string; name: string; args?: unknown }
  | { type: 'toolResult'; partId?: string; name?: string; text: string; isError?: boolean; streaming?: boolean }
  | { type: 'agentMessage'; partId?: string; text: string; agentName?: string }
  | { type: 'image'; partId?: string; mimeType?: string; data?: string; dataTruncated?: boolean }
  | {
      type: 'compaction'
      partId?: string
      status: PrimeCompactionStatus
      reason?: PrimeCompactionReason
      action?: string
      outcome?: PrimeCompactionOutcome
      tokensBefore?: number
      firstKeptEntryId?: string
      summary?: string
      error?: string
      /** App-generated fallback, translated only when displayed. */
      errorKind?: 'incomplete'
      customInstructions?: string
      willRetry?: boolean
    }
/** Output tokens and model response time summed over the harness responses in one turn. */
export interface TranscriptGeneration {
  outputTokens: number
  durationMs: number
}
export interface TranscriptMessage {
  id: string
  role: 'user' | 'assistant' | 'agent' | 'goal' | 'tool' | 'system'
  /** Renderer-local steering lifecycle. Persisted transcripts remain harness-owned. */
  steerState?: 'accepted' | 'read'
  /** Renderer-owned steering boundary, neutral notice, or failure row. */
  kind?: 'steer-read-marker' | 'notice' | 'error'
  notice?: { kind: 'branch-summary' }
  timestamp?: string | number
  agentName?: string
  startedAt?: string | number
  completedAt?: string | number
  parts: MessagePart[]
  streaming?: boolean
}
export interface SessionChangeEvent {
  filePath?: string
  /** Harness whose session catalog changed; absent events predate harness scoping. */
  harness?: HarnessId
}
export type PromptDeliveryIntent = 'queue' | 'steer'
export interface QueuedPrompt {
  id: string
  text: string
  intent: PromptDeliveryIntent
  /** Stable presentation data while a steer waits for the agent to pick it up. */
  timestamp?: number
  parts?: MessagePart[]
  /** The most recent automatic flush attempt failed admission. */
  flushAttemptFailed?: boolean
}
