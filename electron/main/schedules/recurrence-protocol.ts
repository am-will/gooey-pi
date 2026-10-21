import type { ScheduleTiming } from '../../../src/types/api'

export type RecurrenceJob =
  | { kind: 'next'; timing: ScheduleTiming; after: string }
  | { kind: 'preview'; timing: ScheduleTiming; after: string; count: number }
  | { kind: 'missed'; timing: ScheduleTiming; from: string; until: string; limit: number; saturate: boolean }

export interface RecurrenceRequest { id: number; job: RecurrenceJob }
export type RecurrenceResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; success: true; value: string | null | string[] | number }
  | { type: 'result'; id: number; success: false; error: string; name: string }
