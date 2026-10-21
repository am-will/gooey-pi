import type { MessageKey } from '@/lib/i18n'
import type { AutomationScheduleRecord, NativeHeartbeatRecord, ScheduleExecution, ScheduleRunRecord } from '@/types/api'

/**
 * Schedule records render several stored enum values verbatim: the detail card,
 * the run history, the heartbeat list and the inspector summary all show the
 * same words, so one table per field keeps the wording from drifting.
 *
 * The English catalog entries mirror the enum values, which is why they read
 * lowercase there — the English interface shows exactly what the record stores.
 * Chips capitalise through the `.schedule-state` CSS rule.
 */
export const CREATED_BY_KEYS: Record<AutomationScheduleRecord['createdBy'], MessageKey> = {
  user: 'schedule.value.user',
  agent: 'schedule.value.agent',
}
export const DEFINITION_STATUS_KEYS: Record<AutomationScheduleRecord['status'], MessageKey> = {
  active: 'schedule.value.active',
  paused: 'schedule.value.paused',
  completed: 'schedule.value.completed',
  blocked: 'schedule.value.blocked',
}
export const RUN_STATUS_KEYS: Record<ScheduleRunRecord['status'], MessageKey> = {
  queued: 'schedule.value.queued',
  running: 'schedule.value.running',
  succeeded: 'schedule.value.succeeded',
  failed: 'schedule.value.failed',
  skipped: 'schedule.value.skipped',
  interrupted: 'schedule.value.interrupted',
  cancelled: 'schedule.value.cancelled',
}
export const RUN_TRIGGER_KEYS: Record<ScheduleRunRecord['trigger'], MessageKey> = {
  scheduled: 'schedule.value.scheduled',
  manual: 'schedule.value.manual',
}
export const HEARTBEAT_STATUS_KEYS: Record<NativeHeartbeatRecord['status'], MessageKey> = {
  active: 'schedule.value.active',
  paused: 'schedule.value.paused',
}
export const EXECUTION_THINKING_KEYS: Record<ScheduleExecution['thinking'], MessageKey> = {
  auto: 'schedule.value.auto',
  off: 'schedule.value.off',
  minimal: 'schedule.value.minimal',
  low: 'schedule.value.low',
  medium: 'schedule.value.medium',
  high: 'schedule.value.high',
  xhigh: 'schedule.value.xhigh',
  max: 'schedule.value.max',
}
export const EXECUTION_SPEED_KEYS: Record<ScheduleExecution['speed'], MessageKey> = {
  normal: 'schedule.value.normal',
  fast: 'schedule.value.fast',
}
