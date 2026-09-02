import type { HarnessId, SessionRecord } from '@/types/api'

export interface SessionMention {
  start: number
  end: number
  text: string
  session: SessionRecord
}

export const SESSION_ROUTING_BEGIN = '===== BEGIN GOOEYPI SESSION REFERENCES ====='
export const SESSION_ROUTING_END = '===== END GOOEYPI SESSION REFERENCES ====='

export interface SessionRoutingSplit {
  text: string
  block?: string
}

export interface RoutedSessionReference {
  label: string
  sessionId: string
  harness: HarnessId
}

const boundaryBefore = (value: string | undefined): boolean => value === undefined || /[\s([{"'`]/.test(value)
const boundaryAfter = (value: string | undefined): boolean => value === undefined || /[\s.,!?;:()[\]{}"'`]/.test(value)

/** Resolves exact visible @title references to stable session UUIDs. */
export function findSessionMentions(value: string, sessions: readonly SessionRecord[], preferredIds: ReadonlyMap<string, string> = new Map()): SessionMention[] {
  const candidates = [...sessions].filter((session) => session.title.trim()).sort((left, right) => {
    const lengthDifference = right.title.length - left.title.length
    if (lengthDifference) return lengthDifference
    const key = left.title.trim().toLocaleLowerCase()
    const preferred = preferredIds.get(key)
    return preferred === left.id ? -1 : preferred === right.id ? 1 : 0
  })
  const lowerValue = value.toLocaleLowerCase()
  const mentions: SessionMention[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '@' || !boundaryBefore(value[index - 1])) continue
    const session = candidates.find((candidate) => {
      const token = `@${candidate.title.trim()}`.toLocaleLowerCase()
      return lowerValue.startsWith(token, index) && boundaryAfter(value[index + token.length])
    })
    if (!session) continue
    const end = index + session.title.trim().length + 1
    mentions.push({ start: index, end, text: value.slice(index, end), session })
    index = end - 1
  }
  return mentions
}

/** Adds immutable ids for the model while preserving the user's visible @title text. */
export function appendSessionRouting(prompt: string, sessions: readonly SessionRecord[], preferredIds: ReadonlyMap<string, string> = new Map()): string {
  const mentions = findSessionMentions(prompt, sessions, preferredIds)
  const unique = mentions.filter((mention, index) => mentions.findIndex((candidate) => candidate.session.id === mention.session.id && candidate.session.harness === mention.session.harness) === index)
  if (!unique.length) return prompt
  const visiblePrompt = prompt
    .replaceAll(SESSION_ROUTING_BEGIN, '[session reference boundary omitted]')
    .replaceAll(SESSION_ROUTING_END, '[session reference boundary omitted]')
  const references = unique.map(({ text, session }) => `- ${JSON.stringify(text)}: ${session.harness} session UUID ${session.id}. Use gooeypi_session_read, gooeypi_session_send, and gooeypi_session_wait when the request requires collaboration; GooeyPi can wake an idle saved target.`)
  return `${visiblePrompt}\n\n${SESSION_ROUTING_BEGIN}\nThe user explicitly referenced these GooeyPi sessions. Titles are display labels; use the exact UUIDs below:\n${references.join('\n')}\n${SESSION_ROUTING_END}`
}

/** Removes model-only UUID routing before a sent prompt is rendered to the user. */
export function splitSessionRouting(value: string): SessionRoutingSplit {
  const begin = value.lastIndexOf(SESSION_ROUTING_BEGIN)
  if (begin < 0) return { text: value }
  const end = value.indexOf(SESSION_ROUTING_END, begin + SESSION_ROUTING_BEGIN.length)
  if (end < 0) return { text: value }
  return {
    text: `${value.slice(0, begin)}${value.slice(end + SESSION_ROUTING_END.length)}`.trimEnd(),
    block: value.slice(begin + SESSION_ROUTING_BEGIN.length, end).trim(),
  }
}

/** Parses only the bounded reference lines emitted by appendSessionRouting. */
export function routedSessionReferences(block: string | undefined): RoutedSessionReference[] {
  if (!block) return []
  const references: RoutedSessionReference[] = []
  const seen = new Set<string>()
  for (const line of block.split('\n').slice(0, 100)) {
    const match = /^- ("(?:\\.|[^"\\])*"): (prime|omp|pi) session UUID ([a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})\./.exec(line)
    if (!match) continue
    let label: unknown
    try { label = JSON.parse(match[1]) } catch { continue }
    if (typeof label !== 'string' || !label.startsWith('@') || label.length > 201) continue
    const key = `${match[2]}:${match[3]}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push({ label, harness: match[2] as HarnessId, sessionId: match[3] })
  }
  return references
}
