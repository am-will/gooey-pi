import { appendAnnotationsToPrompt } from '@/lib/browser-annotations'
import { appendCapabilityRouting } from '@/lib/capability-mentions'
import { appendSessionRouting, findSessionMentions } from '@/lib/session-mentions'
import { interceptedCommandName } from '@/lib/prompt-commands'
import { appendTerminalContextToPrompt } from '@/lib/terminal-context'
import type { BrowserAnnotation, HarnessId, SessionRecord, SkillRecord, TerminalPromptContext } from '@/types/api'

export interface ComposerPromptContext {
  sessions: readonly SessionRecord[]
  sessionReferenceIds: ReadonlyMap<string, string>
  /** Enabled capabilities that @ mentions may route to. */
  skills: readonly SkillRecord[]
  annotations: BrowserAnnotation[]
  terminalContext?: TerminalPromptContext
}

export type ComposedPrompt = { prompt: string } | { error: string }

/**
 * Appends the model-only routing and attachment blocks to the user's visible
 * prompt. Commands GooeyPi intercepts never reach the model as a prompt, so
 * they are recognized on the raw draft and refused when context would ride
 * along: for /compact it would otherwise become the custom instructions.
 */
export function composePrompt(prompt: string, harness: HarnessId, context: ComposerPromptContext): ComposedPrompt {
  const composed = appendContext(prompt, context)
  const command = interceptedCommandName(prompt, harness)
  if (command && composed !== prompt) return { error: `${command} does not accept attachments or @ mentions. Remove them and try again.` }
  return { prompt: composed }
}

function appendContext(prompt: string, { sessions, sessionReferenceIds, skills, annotations, terminalContext }: ComposerPromptContext): string {
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


/** English attachment labels are sent to the harness as message content. */
export function attachmentPlaceholderPrompt({ draft, images, files, annotations }: { draft: string; images: number; files: number; annotations: number }): string {
  return draft.trim() || (images > 0
    ? (images === 1 ? '[Attached image]' : '[Attached images]')
    : files > 0 ? (files === 1 ? '[Attached file]' : '[Attached files]')
      : annotations > 0 ? '[Page annotations]' : '[Terminal selection]')
}
