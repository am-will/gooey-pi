import type { SubagentRecentTool, SubagentRecord, SubagentStatus, SubagentSubscriptionLevel } from '@/types/api'
import { record, string } from './events/parse'

/**
 * Live roster of the active session's subagents, built from OMP's
 * `subagent_*` push frames and `get_subagents` responses.
 *
 * Outbound RPC commands are validated strictly in the main process
 * (`command-schema.ts`) because that is a privilege boundary. Inbound harness
 * frames are coerced defensively here, exactly like `events/parse.ts` treats
 * transcript frames: a harness that adds, renames, or drops a field must
 * degrade the panel, never throw inside the event pump.
 *
 * Field locations below were read off real `omp 17.2.9` frames rather than
 * inferred; the non-obvious ones are called out where they are parsed.
 */

/**
 * Subscription level GooeyPi requests while the Subagents panel is open.
 *
 * Deliberately `progress`, never `events`. Measured on omp 17.2.9 with the
 * same two-subagent workload, counting frames the runtime forwarded:
 *
 *   level      subagent_event  subagent_progress  lifecycle  peak frames/s
 *   progress                0                 82          4              9
 *   events                196                 90          4             43
 *
 * `events` re-broadcasts each subagent's own `message_update` and
 * `tool_execution_*` stream (128 of those 196 frames were `message_update`),
 * so its cost scales with subagent count times per-subagent tool traffic.
 * Those frames are non-critical and share one budget with the parent's own
 * transcript stream in `AgentEventForwarder` (500 events per 1s window, minus
 * a 64 KiB byte reserve). Spending that budget on subagent chatter would
 * starve the transcript the user is actually reading and trip a
 * `transport_limit`, which forces an authoritative transcript re-read.
 *
 * The roster answers "which subagent, on what tool, for how long" from
 * `progress` alone, so `events` buys nothing the panel shows.
 */
export const SUBAGENT_SUBSCRIPTION_FOR_INSPECTION: SubagentSubscriptionLevel = 'progress'

/** Resting level: no subagent push frames while nothing is inspecting them. */
export const SUBAGENT_SUBSCRIPTION_IDLE: SubagentSubscriptionLevel = 'off'

/** Poll interval used only when the harness refuses the push subscription. */
export const SUBAGENT_POLL_INTERVAL_MS = 2_000

/** Recent tools kept per row; OMP sends a short list and only the newest are shown. */
const MAX_RECENT_TOOLS = 5

const SUBAGENT_STATUSES = new Set<SubagentStatus>(['started', 'running', 'completed', 'failed'])

export function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === 'completed' || status === 'failed'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function subagentStatus(value: unknown): SubagentStatus {
  const raw = string(value)
  return raw && SUBAGENT_STATUSES.has(raw as SubagentStatus) ? raw as SubagentStatus : 'unknown'
}

function recentTools(value: unknown): SubagentRecentTool[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tools = value.flatMap((entry) => {
    const item = record(entry)
    const tool = string(item?.tool)
    return tool ? [{ tool, args: string(item?.args), endMs: finiteNumber(item?.endMs) }] : []
  })
  return tools.slice(0, MAX_RECENT_TOOLS)
}

/**
 * Reads one roster row out of a progress-shaped object.
 *
 * `subagent_progress` carries no `id` on its payload: identity lives on the
 * nested `payload.progress.id`, while `get_subagents` entries repeat both the
 * flat fields and the same nested `progress` object. Reading the nested object
 * first and falling back to the outer one covers both without guessing.
 */
function progressFields(progress: Record<string, unknown> | undefined, outer: Record<string, unknown>): Omit<SubagentRecord, 'id' | 'status' | 'updatedAt'> {
  const source = progress ?? outer
  return {
    index: finiteNumber(source.index) ?? finiteNumber(outer.index),
    agent: string(source.agent) ?? string(outer.agent),
    agentSource: string(source.agentSource) ?? string(outer.agentSource),
    description: string(source.description) ?? string(outer.description),
    parentToolCallId: string(outer.parentToolCallId) ?? string(source.parentToolCallId),
    resolvedModel: string(source.resolvedModel),
    toolCount: finiteNumber(source.toolCount),
    requests: finiteNumber(source.requests),
    tokens: finiteNumber(source.tokens),
    contextTokens: finiteNumber(source.contextTokens),
    contextWindow: finiteNumber(source.contextWindow),
    cost: finiteNumber(source.cost),
    durationMs: finiteNumber(source.durationMs),
    lastIntent: string(source.lastIntent),
    recentTools: recentTools(source.recentTools),
  }
}

/** Drops undefined fields so a sparse frame never blanks a value an earlier frame supplied. */
function mergeRow(previous: SubagentRecord | undefined, next: SubagentRecord): SubagentRecord {
  if (!previous) return next
  const merged: SubagentRecord = { ...previous }
  for (const [key, value] of Object.entries(next) as Array<[keyof SubagentRecord, unknown]>) {
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  return merged
}

export type SubagentRoster = readonly SubagentRecord[]

function upsert(roster: SubagentRoster, row: SubagentRecord): SubagentRoster {
  const index = roster.findIndex((entry) => entry.id === row.id)
  if (index < 0) return [...roster, row]
  const merged = mergeRow(roster[index], row)
  const next = roster.slice()
  next[index] = merged
  return next
}

/** True for the frames this reducer understands, so callers can skip the rest cheaply. */
export function isSubagentEvent(event: Record<string, unknown>): boolean {
  const type = string(event.type)
  return type === 'subagent_lifecycle' || type === 'subagent_progress' || type === 'subagent_event'
}

/**
 * Applies one harness frame to the roster. Returns the same reference when the
 * frame carries nothing usable, so React state updates stay cheap.
 */
export function applySubagentEvent(roster: SubagentRoster, event: Record<string, unknown>, now = Date.now()): SubagentRoster {
  const type = string(event.type)
  const payload = record(event.payload)
  if (!payload) return roster

  if (type === 'subagent_lifecycle') {
    const id = string(payload.id)
    if (!id) return roster
    return upsert(roster, {
      id,
      status: subagentStatus(payload.status),
      updatedAt: now,
      ...progressFields(undefined, payload),
    })
  }

  if (type === 'subagent_progress') {
    const progress = record(payload.progress)
    const id = string(progress?.id) ?? string(payload.id)
    if (!id) return roster
    return upsert(roster, {
      id,
      status: subagentStatus(progress?.status ?? payload.status),
      updatedAt: now,
      ...progressFields(progress, payload),
    })
  }

  if (type === 'subagent_event') {
    // GooeyPi never subscribes at the `events` level, but another client on the
    // same harness can, and OMP broadcasts the level it was last set to. Treat
    // such a frame as a liveness touch only: storing the inner agent stream
    // would rebuild the transcript this panel deliberately does not own.
    const id = string(payload.id)
    if (!id) return roster
    const index = roster.findIndex((entry) => entry.id === id)
    if (index < 0) return roster
    const next = roster.slice()
    next[index] = { ...next[index], updatedAt: now }
    return next
  }

  return roster
}

/**
 * Merges a `get_subagents` response into the roster.
 *
 * Merge, never replace: OMP drops a subagent from that list the moment it
 * finishes, and a roster that forgets finished rows would reproduce the very
 * blind spot this panel exists to close.
 */
export function applySubagentRoster(roster: SubagentRoster, data: unknown, now = Date.now()): SubagentRoster {
  const list = record(data)?.subagents
  if (!Array.isArray(list)) return roster
  let next = roster
  for (const entry of list) {
    const row = record(entry)
    const id = string(row?.id)
    if (!row || !id) continue
    const progress = record(row.progress)
    next = upsert(next, {
      id,
      status: subagentStatus(row.status ?? progress?.status),
      updatedAt: now,
      ...progressFields(progress, row),
    })
  }
  return next
}

/**
 * Clears finished rows at the start of a new parent turn, keeping the panel
 * scoped to work in flight while leaving terminal rows readable until then.
 */
export function pruneFinishedSubagents(roster: SubagentRoster): SubagentRoster {
  const live = roster.filter((entry) => !isTerminalSubagentStatus(entry.status))
  return live.length === roster.length ? roster : live
}

export const EMPTY_SUBAGENT_ROSTER: SubagentRoster = []

/** Running first, then by parent-assigned index, so the panel does not reshuffle as rows finish. */
export function sortSubagents(roster: SubagentRoster): SubagentRecord[] {
  return roster.slice().sort((a, b) => {
    const terminal = Number(isTerminalSubagentStatus(a.status)) - Number(isTerminalSubagentStatus(b.status))
    if (terminal !== 0) return terminal
    return (a.index ?? Number.MAX_SAFE_INTEGER) - (b.index ?? Number.MAX_SAFE_INTEGER)
  })
}
