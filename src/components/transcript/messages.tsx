import { Fragment, memo, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Target } from 'lucide-react'
import type { HarnessId, MessagePart, TranscriptMessage } from '@/types/api'
import { splitAnnotationBlock } from '@/lib/browser-annotations'
import { splitCapabilityRouting } from '@/lib/capability-mentions'
import { routedSessionReferences, splitSessionRouting, type RoutedSessionReference } from '@/lib/session-mentions'
import { splitTerminalContextBlock } from '@/lib/terminal-context'
import { writeClipboardText } from '@/lib/clipboard'
import { boundText } from '@/lib/render-bounds'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { MarkdownText } from '../MarkdownText'
import { OmpMark, PiMark, PrimeMark } from '../ui'
import { InlineText } from './syntax'
import { TranscriptImage } from './TranscriptImage'
import { ThinkingDots, WorkDisclosure, WorkTimeline } from './timeline'

function imageSource(part: Extract<MessagePart, { type: 'image' }>): string | undefined {
  if (part.dataTruncated || !part.data || !part.mimeType || !/^image\/(png|jpeg|gif|webp)$/i.test(part.mimeType) || !/^[a-z\d+/=\s]+$/i.test(part.data)) return undefined
  return `data:${part.mimeType};base64,${part.data.replace(/\s/g, '')}`
}

function renderImage(part: Extract<MessagePart, { type: 'image' }>, key: string) {
  const source = imageSource(part)
  return source ? (
    <TranscriptImage key={key} source={source} alt="User attachment" />
  ) : (
    <div key={key} className="image-part image-part--unavailable">
      Image attachment unavailable
    </div>
  )
}

function renderNarrative(parts: MessagePart[], keyPrefix: string, streaming = false) {
  return parts.map((part, index) => {
    if (part.type === 'text') return <MarkdownText key={`${keyPrefix}-${index}`} text={part.text} streaming={streaming} />
    if (part.type === 'image') return renderImage(part, `${keyPrefix}-${index}`)
    return null
  })
}

function renderNarrativeWithActivity(parts: MessagePart[], keyPrefix: string, showReasoning: boolean, showTools: boolean, streaming = false) {
  const groups: Array<{ activity: boolean; parts: MessagePart[] }> = []
  for (const part of parts) {
    const activity = part.type !== 'text' && part.type !== 'image'
    const current = groups.at(-1)
    if (current?.activity === activity) current.parts.push(part)
    else groups.push({ activity, parts: [part] })
  }
  return groups.map((group, index) =>
    group.activity ? (
      <WorkTimeline key={`${keyPrefix}-activity-${index}`} parts={group.parts} showReasoning={showReasoning} showTools={showTools} streaming={streaming} />
    ) : (
      <div key={`${keyPrefix}-narrative-${index}`}>{renderNarrative(group.parts, `${keyPrefix}-${index}`, streaming)}</div>
    ),
  )
}

function isNarrative(part: MessagePart): part is Extract<MessagePart, { type: 'text' | 'image' }> {
  return part.type === 'text' || part.type === 'image'
}

/**
 * Completed turns can receive lightweight activity after their final answer.
 * Anchor the visible tail at the most substantial narrative run, preferring
 * the later run on ties, so everything after that anchor remains in order and
 * a short trailing note cannot bury a longer deliverable in the work rail.
 */
function primaryNarrativeStart(parts: MessagePart[], start: number): number {
  let bestStart = -1
  let bestScore = 0
  for (let index = start; index < parts.length;) {
    if (!isNarrative(parts[index])) {
      index += 1
      continue
    }
    const runStart = index
    let score = 0
    while (index < parts.length && isNarrative(parts[index])) {
      const part = parts[index]
      score += part.type === 'text' ? part.text.trim().length : 1
      index += 1
    }
    if (score > 0 && score >= bestScore) {
      bestStart = runStart
      bestScore = score
    }
  }
  return bestStart
}

function messageText(message: TranscriptMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function MessageActions({ message, text: suppliedText }: { message: TranscriptMessage; text?: string }) {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const text = suppliedText ?? messageText(message)
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'agent' ? 'agent' : 'user'

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    },
    [],
  )

  if (!text) return null

  const copyMessage = async () => {
    try {
      await writeClipboardText(text)
      setCopied(true)
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="message-actions">
      <button type="button" disabled={!text} aria-label={`${copied ? 'Copied' : 'Copy'} ${role} message`} onClick={() => void copyMessage()}>
        {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

const HARNESS_MARKS = { omp: OmpMark, prime: PrimeMark, pi: PiMark } satisfies Record<HarnessId, unknown>

function AssistantHarnessMark({ harness, size = 24 }: { harness: HarnessId; size?: number }) {
  const Mark = HARNESS_MARKS[harness]
  return <Mark size={size} />
}

export const AssistantMessage = memo(
  function AssistantMessage({ message, harness = 'prime', showReasoning, showTools }: { message: TranscriptMessage; harness?: HarnessId; showReasoning: boolean; showTools: boolean }) {
    const isActivity = (part: MessagePart) => part.type === 'thinking' || part.type === 'toolCall' || part.type === 'toolResult' || part.type === 'agentMessage' || part.type === 'compaction'
    const firstActivity = message.parts.findIndex(isActivity)
    let lastActivity = -1
    for (let index = message.parts.length - 1; index >= 0; index -= 1) {
      if (isActivity(message.parts[index])) {
        lastActivity = index
        break
      }
    }
    const finalNarrative = firstActivity < 0 ? -1 : primaryNarrativeStart(message.parts, firstActivity + 1)
    const workEnd = finalNarrative >= 0 ? finalNarrative : lastActivity + 1
    const before = firstActivity < 0 ? message.parts : message.parts.slice(0, firstActivity)
    const work = firstActivity < 0 ? [] : message.parts.slice(firstActivity, workEnd)
    const after = firstActivity < 0 ? [] : message.parts.slice(workEnd)
    const hasVisibleActivity = work.some(
      (part) => part.type === 'agentMessage' || part.type === 'compaction' || (part.type === 'thinking' && showReasoning) || ((part.type === 'toolCall' || part.type === 'toolResult') && showTools),
    )
    const hiddenMiddleNarrative = !hasVisibleActivity ? work.filter((part) => part.type === 'text' || part.type === 'image') : []
    const copyableNarrative = hasVisibleActivity ? [...before, ...after] : [...before, ...hiddenMiddleNarrative, ...after]
    const copyableText = copyableNarrative.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    return (
      <article className="message message--assistant">
        <div className="assistant-mark">
          <AssistantHarnessMark harness={harness} />
        </div>
        <div className="message__content">
          {renderNarrative(before, 'before', message.streaming)}
          {hasVisibleActivity ? (
            <WorkDisclosure message={message} parts={work} showReasoning={showReasoning} showTools={showTools} />
          ) : (
            renderNarrative(hiddenMiddleNarrative, 'middle', message.streaming)
          )}
          {renderNarrativeWithActivity(after, 'after', showReasoning, showTools, message.streaming)}
          {message.streaming && !hasVisibleActivity ? (
            <div className="streaming-state" aria-live="polite">
              <ThinkingDots /> {HARNESS_SHORT_NAMES[harness]} is working
            </div>
          ) : null}
          {!message.streaming ? <MessageActions message={message} text={copyableText} /> : null}
        </div>
      </article>
    )
  },
  (previous, next) => previous.message === next.message && previous.harness === next.harness && previous.showReasoning === next.showReasoning && previous.showTools === next.showTools,
)

function SessionReferenceText({ text, references, onOpen }: { text: string; references: RoutedSessionReference[]; onOpen?(sessionId: string, harness: HarnessId): void }) {
  if (!references.length) return <InlineText text={text} />
  const ordered = [...references].sort((left, right) => right.label.length - left.label.length)
  const lines = text.split('\n')
  return <>{lines.map((line, lineIndex) => {
    const parts: ReactNode[] = []
    let cursor = 0
    while (cursor < line.length) {
      let foundIndex = -1
      let found: RoutedSessionReference | undefined
      for (let index = cursor; index < line.length; index += 1) {
        const before = line[index - 1]
        found = ordered.find((reference) => {
          const after = line[index + reference.label.length]
          return (before === undefined || /[\s([{"'`]/.test(before))
            && line.startsWith(reference.label, index)
            && (after === undefined || /[\s.,!?;:()[\]{}"'`]/.test(after))
        })
        if (found) { foundIndex = index; break }
      }
      if (!found || foundIndex < 0) { parts.push(line.slice(cursor)); break }
      if (foundIndex > cursor) parts.push(line.slice(cursor, foundIndex))
      const reference = found
      parts.push(<button
        type="button"
        key={`${reference.harness}:${reference.sessionId}:${foundIndex}`}
        className="session-reference"
        aria-label={`Open session ${reference.label.slice(1)}`}
        onClick={() => onOpen?.(reference.sessionId, reference.harness)}
      >{reference.label}</button>)
      cursor = foundIndex + reference.label.length
    }
    return <Fragment key={`${lineIndex}-${line.slice(0, 12)}`}>{parts}{lineIndex < lines.length - 1 ? <br /> : null}</Fragment>
  })}</>
}

function visibleUserText(text: string): string {
  const terminal = splitTerminalContextBlock(text)
  const annotations = splitAnnotationBlock(terminal.text)
  const capability = splitCapabilityRouting(annotations.text)
  return splitSessionRouting(capability.text).text
}

function UserText({ text, onOpenSessionReference }: { text: string; onOpenSessionReference?(sessionId: string, harness: HarnessId): void }) {
  // Sent prompts can carry verbose model-facing context blocks. Keep both
  // attachments collapsed and capability routing hidden while preserving the
  // user's own message.
  const terminal = splitTerminalContextBlock(text)
  const annotations = splitAnnotationBlock(terminal.text)
  const capability = splitCapabilityRouting(annotations.text)
  const sessions = splitSessionRouting(capability.text)
  const references = routedSessionReferences(sessions.block)
  if (!sessions.block && !capability.block && !annotations.block && !terminal.block) return <InlineText text={text} />
  return (
    <>
      {sessions.text && sessions.text !== '[Page annotations]' && sessions.text !== '[Terminal selection]' ? <SessionReferenceText text={sessions.text} references={references} onOpen={onOpenSessionReference} /> : null}
      {annotations.block ? (
        <details className="user-annotations">
          <summary>{annotations.count > 0 ? `${annotations.count} page annotation${annotations.count === 1 ? '' : 's'}` : 'Page annotations'}</summary>
          <pre>{annotations.block}</pre>
        </details>
      ) : null}
      {terminal.selection ? (
        <details className="user-annotations user-terminal-context">
          <summary>{`Selected text from ${terminal.label ?? 'terminal'}`}</summary>
          <pre>{terminal.selection}</pre>
        </details>
      ) : null}
    </>
  )
}

export const UserMessage = memo(function UserMessage({ message, onOpenSessionReference }: { message: TranscriptMessage; onOpenSessionReference?(sessionId: string, harness: HarnessId): void }) {
  const copyableText = message.parts.filter((part) => part.type === 'text').map((part) => visibleUserText(part.text)).filter(Boolean).join('\n')
  return (
    <article className="message message--user">
      <div className="user-bubble">
        {message.parts.map((part, index) => (part.type === 'text' ? <UserText key={index} text={part.text} onOpenSessionReference={onOpenSessionReference} /> : part.type === 'image' ? renderImage(part, `user-${index}`) : null))}
      </div>
      {message.steerState ? <div className={`message__steer-state is-${message.steerState}`} role="status">{message.steerState === 'accepted' ? 'Accepted — waiting for the next safe steering point' : 'Read by agent'}</div> : null}
      <MessageActions message={message} text={copyableText} />
    </article>
  )
})

export const SteerReadMarker = memo(function SteerReadMarker({ message }: { message: TranscriptMessage }) {
  return <div className="message message--steer-read" role="status"><span>{messageText(message)}</span></div>
})

export const ActivityMessage = memo(function ActivityMessage({ message, harness = 'prime' }: { message: TranscriptMessage; harness?: HarnessId }) {
  const activityLabel = `${HARNESS_SHORT_NAMES[harness]} message`
  const sourceParts: MessagePart[] =
    message.role === 'system' && !message.parts.some((part) => part.type === 'compaction')
      ? [
          { type: 'toolCall', id: message.id, name: activityLabel },
          { type: 'toolResult', name: activityLabel, text: messageText(message), isError: true },
        ]
      : message.parts
  const parts = sourceParts.flatMap((part, index) =>
    part.type === 'toolResult' && sourceParts[index - 1]?.type !== 'toolCall' ? [{ type: 'toolCall' as const, id: `${message.id}-${index}`, name: part.name ?? 'Tool' }, part] : [part],
  )
  return (
    <article className="message message--activity">
      <WorkTimeline parts={parts} showReasoning showTools />
    </article>
  )
})

export const AgentMessage = memo(function AgentMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = messageText(message)
  const label = message.agentName ? `Message from agent: ${message.agentName}` : 'Message from agent'
  return (
    <article className={`message message--agent ${open ? 'is-open' : ''}`}>
      <button type="button" className="agent-message__summary" aria-expanded={open} aria-controls={contentId} aria-label={label} onClick={() => setOpen((value) => !value)}>
        <PrimeMark size={18} />
        <span className="agent-message__label">Message from agent</span>
        {message.agentName ? <span className="agent-message__name">{message.agentName}</span> : null}
        {open ? <ChevronDown className="agent-message__chevron" size={13} /> : <ChevronRight className="agent-message__chevron" size={13} />}
      </button>
      {open ? (
        <div className="agent-message__content" id={contentId}>
          <MarkdownText text={boundText(text, 40_000, '\n… [Agent message truncated in the desktop view.]')} />
          <MessageActions message={message} />
        </div>
      ) : null}
    </article>
  )
})

export const GoalMessage = memo(function GoalMessage({ message }: { message: TranscriptMessage }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  const text = messageText(message)
  return (
    <article className={`message message--goal ${open ? 'is-open' : ''}`}>
      <button type="button" className="goal-message__summary" aria-expanded={open} aria-controls={contentId} aria-label="Goal summary" onClick={() => setOpen((value) => !value)}>
        <span className="goal-message__icon">
          <Target size={15} />
        </span>
        <span className="goal-message__label">Goal summary</span>
        {open ? <ChevronDown className="goal-message__chevron" size={13} /> : <ChevronRight className="goal-message__chevron" size={13} />}
      </button>
      {open ? (
        <div className="goal-message__content" id={contentId}>
          <MarkdownText text={boundText(text, 40_000, '\n… [Goal summary truncated in the desktop view.]')} />
        </div>
      ) : null}
    </article>
  )
})
