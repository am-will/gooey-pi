import { parentPort } from 'node:worker_threads'
import { countMissedOccurrences, nextScheduleOccurrence, previewScheduleOccurrences } from './recurrence'
import type { RecurrenceRequest, RecurrenceResponse } from './recurrence-protocol'

if (!parentPort) throw new Error('The recurrence worker requires a parent connection')
const port = parentPort
port.on('message', ({ id, job }: RecurrenceRequest) => {
  let response: RecurrenceResponse
  try {
    const value = job.kind === 'next' ? nextScheduleOccurrence(job.timing, job.after)
      : job.kind === 'preview' ? previewScheduleOccurrences(job.timing, job.count, job.after)
        : countMissedOccurrences(job.timing, job.from, job.until, job.limit, { saturate: job.saturate })
    response = { type: 'result', id, success: true, value }
  } catch (error) {
    response = { type: 'result', id, success: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4_000),
      name: error instanceof Error ? error.name : 'Error' }
  }
  port.postMessage(response)
})
port.postMessage({ type: 'ready' } satisfies RecurrenceResponse)
