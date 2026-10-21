import type { PrimeThinkingLevel } from './models'
import type { HarnessId } from './harness'
export const SCHEDULE_DEFINITION_STATUSES = ['active', 'paused', 'completed', 'blocked'] as const
export type ScheduleDefinitionStatus = (typeof SCHEDULE_DEFINITION_STATUSES)[number]
export const SCHEDULE_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted', 'cancelled'] as const
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number]
export type ScheduleCreatedBy = 'user' | 'agent'
export type ScheduleTarget =
  | { kind: 'project'; projectId: string }
  | { kind: 'session'; projectId: string; sessionId: string }
export type ScheduleTiming =
  | { kind: 'once'; at: string }
  | { kind: 'rrule'; dtstartLocal: string; timeZone: string; rrule: string }
export interface ScheduleExecution {
  model: 'auto' | string
  thinking: 'auto' | PrimeThinkingLevel
  speed: 'normal' | 'fast'
}
export interface ScheduleRunRecord {
  id: string
  taskId: string
  taskRevision: number
  trigger: 'scheduled' | 'manual'
  scheduledFor: string
  queuedAt: string
  startedAt?: string
  finishedAt?: string
  status: ScheduleRunStatus
  execution: ScheduleExecution
  sessionId?: string
  sessionFile?: string
  error?: string
  skippedCount?: number
}
export interface AutomationScheduleRecord {
  schemaVersion: 1
  id: string
  /** Harness that owns the target, model catalog, and runtime for every run. */
  harness: HarnessId
  revision: number
  title: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  status: ScheduleDefinitionStatus
  createdBy: ScheduleCreatedBy
  createdAt: string
  updatedAt: string
  nextRunAt?: string
  blockedReason?: string
  runs: ScheduleRunRecord[]
}
export interface ScheduleInput {
  title?: string
  prompt: string
  target: ScheduleTarget
  timing: ScheduleTiming
  execution: ScheduleExecution
  createdBy?: ScheduleCreatedBy
}
export interface SchedulePatch {
  revision: number
  title?: string
  prompt?: string
  target?: ScheduleTarget
  timing?: ScheduleTiming
  execution?: ScheduleExecution
}
export interface SchedulePreview {
  timing: ScheduleTiming
  occurrences: string[]
}
export interface ScheduleChangeEvent {
  taskId?: string
  reason: 'created' | 'updated' | 'deleted' | 'run'
}
export interface NativeHeartbeatRecord {
  id: string
  source: 'heartbeat' | 'rlm_heartbeat'
  status: 'active' | 'paused'
  prompt: string
  schedule: string
  sessionId: string
  sessionFile: string
  activeSessionId: string
  deliveryMode?: 'steer' | 'follow_up'
  nextRunAt?: string
  lastRunAt?: string
  label?: string
  runtimeId?: string
}
