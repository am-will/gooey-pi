import { scanAtMentions } from './at-mentions'
import type { SkillRecord } from '@/types/api'

export interface CapabilityMention {
  start: number
  end: number
  text: string
  skill: SkillRecord
}

export const CAPABILITY_ROUTING_BEGIN = '===== BEGIN GOOEYPI CAPABILITY ROUTING ====='
export const CAPABILITY_ROUTING_END = '===== END GOOEYPI CAPABILITY ROUTING ====='

function mentionCandidates(skills: readonly SkillRecord[]): SkillRecord[] {
  const seen = new Set<string>()
  return skills
    .filter((skill) => skill.enabled && skill.name.trim())
    .sort((left, right) => right.name.length - left.name.length)
    .filter((skill) => {
      const key = skill.name.trim().toLocaleLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

/** Resolves visible @ mentions against the enabled catalog without treating email addresses as capabilities. */
export function findCapabilityMentions(value: string, skills: readonly SkillRecord[]): CapabilityMention[] {
  const candidates = mentionCandidates(skills)
  return scanAtMentions(value, candidates, (candidate) => candidate.name).map(({ candidate, ...mention }) => ({ ...mention, skill: candidate }))
}

function routingInstruction(mention: CapabilityMention): string {
  const token = mention.text
  if (mention.skill.id === 'prime-work-browser' || mention.skill.id === 'omp-work-browser') {
    return `${token}: use GooeyPi's in-app Browser capability and its own browser tools. Do not substitute Chrome, an external browser, or another connected browser tool.`
  }
  if (mention.skill.id === 'prime-work-schedules' || mention.skill.id === 'omp-work-schedules') {
    return `${token}: use GooeyPi's Scheduled tasks capability and its own schedule tools.`
  }
  return `${token}: use the enabled GooeyPi ${mention.skill.kind} with the exact catalog id ${JSON.stringify(mention.skill.id)}. Do not substitute a similarly named capability.`
}

/** Adds explicit routing semantics while keeping the user's visible prompt unchanged. */
export function appendCapabilityRouting(prompt: string, skills: readonly SkillRecord[]): string {
  const mentions = findCapabilityMentions(prompt, skills)
  const unique = mentions.filter((mention, index) => mentions.findIndex((candidate) => candidate.skill.id === mention.skill.id) === index)
  if (!unique.length) return prompt
  const visiblePrompt = prompt
    .replaceAll(CAPABILITY_ROUTING_BEGIN, '[capability routing boundary omitted]')
    .replaceAll(CAPABILITY_ROUTING_END, '[capability routing boundary omitted]')
  return `${visiblePrompt}\n\n${CAPABILITY_ROUTING_BEGIN}\nThe user explicitly invoked the following @ capabilities. Follow this routing for the request:\n${unique.map((mention) => `- ${routingInstruction(mention)}`).join('\n')}\n${CAPABILITY_ROUTING_END}`
}

export function splitCapabilityRouting(text: string): { text: string; block: string | null } {
  const begin = text.indexOf(CAPABILITY_ROUTING_BEGIN)
  if (begin === -1) return { text, block: null }
  const end = text.indexOf(CAPABILITY_ROUTING_END, begin)
  if (end === -1) return { text, block: null }
  const block = text.slice(begin, end + CAPABILITY_ROUTING_END.length)
  return { text: `${text.slice(0, begin)}${text.slice(end + CAPABILITY_ROUTING_END.length)}`.trim(), block }
}
