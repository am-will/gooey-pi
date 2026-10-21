export interface AtMention<T> { start: number; end: number; text: string; candidate: T }

const boundaryBefore = (value: string | undefined): boolean => value === undefined || /[\s([{"'`]/.test(value)
const boundaryAfter = (value: string | undefined): boolean => value === undefined || /[\s.,!?;:()[\]{}"'`]/.test(value)

/** Caller order resolves overlapping labels; matching never accepts email fragments. */
export function scanAtMentions<T>(value: string, candidates: readonly T[], label: (candidate: T) => string, { caseSensitive = false }: { caseSensitive?: boolean } = {}): AtMention<T>[] {
  const normalize = (text: string) => caseSensitive ? text : text.toLocaleLowerCase()
  const source = normalize(value)
  const tokens = candidates.map((candidate) => ({ candidate, token: `@${label(candidate).trim()}` }))
  const mentions: AtMention<T>[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '@' || !boundaryBefore(value[index - 1])) continue
    const match = tokens.find(({ token }) => token.length > 1 && source.startsWith(normalize(token), index) && boundaryAfter(value[index + token.length]))
    if (!match) continue
    const end = index + match.token.length
    mentions.push({ start: index, end, text: value.slice(index, end), candidate: match.candidate })
    index = end - 1
  }
  return mentions
}
