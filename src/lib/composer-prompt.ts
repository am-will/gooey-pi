import { appendAnnotationsToPrompt } from '@/lib/browser-annotations'
import { appendCapabilityRouting } from '@/lib/capability-mentions'
import { appendSessionRouting, findSessionMentions } from '@/lib/session-mentions'
import { appendTerminalContextToPrompt } from '@/lib/terminal-context'
import type { BrowserAnnotation, SessionRecord, SkillRecord, TerminalPromptContext } from '@/types/api'

export interface ComposerPromptContext {
  sessions: readonly SessionRecord[]
  sessionReferenceIds: ReadonlyMap<string, string>
  /** Enabled capabilities that @ mentions may route to. */
  skills: readonly SkillRecord[]
  annotations: BrowserAnnotation[]
  terminalContext?: TerminalPromptContext
}

/** Appends the model-only routing and attachment blocks to the user's visible prompt. */
export function composePrompt(prompt: string, { sessions, sessionReferenceIds, skills, annotations, terminalContext }: ComposerPromptContext): string {
  // Recognized @ mentions carry explicit routing semantics; annotations then
  // ride along inside the prompt as their own delimited plain-text block.
  const referencedSessions = findSessionMentions(prompt, sessions, sessionReferenceIds)
  const sessionTitles = new Set(referencedSessions.map(({ session }) => session.title.trim().toLocaleLowerCase()))
  const promptWithSessions = appendSessionRouting(prompt, sessions, sessionReferenceIds)
  // If a session and capability share a display name, the session chosen
  // from the combined menu wins instead of silently routing both.
  const promptWithCapabilities = appendCapabilityRouting(promptWithSessions, skills.filter((skill) => !sessionTitles.has(skill.name.trim().toLocaleLowerCase())))
  const promptWithAnnotations = appendAnnotationsToPrompt(promptWithCapabilities, annotations)
  return appendTerminalContextToPrompt(promptWithAnnotations, terminalContext)
}
