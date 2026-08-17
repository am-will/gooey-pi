import { useMemo } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { GitStatus, HarnessId, TranscriptMessage } from '@/types/api'
import { ChangesCard } from './ChangesCard'
import { ErrorBoundary } from './ErrorBoundary'
import { MarkdownText } from './MarkdownText'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { OmpMark, PiMark, PrimeMark } from './ui'
import { ActivityMessage, AgentMessage, AssistantMessage, GoalMessage, SteerReadMarker, UserMessage } from './transcript/messages'
import { useTranscriptScroll } from './transcript/scroll'
import { LiveElapsed, ThinkingDots, WorkDisclosure } from './transcript/timeline'

export { classifyTool, formatWorkedDuration } from './transcript/timeline'
export { tokenizeSyntax } from './transcript/syntax'

export function coalesceAssistantTurns(messages: TranscriptMessage[]): TranscriptMessage[] {
  let changed = false
  const grouped: TranscriptMessage[] = []
  for (const message of messages) {
    const previous = grouped.at(-1)
    if (message.role !== 'assistant' || previous?.role !== 'assistant') {
      grouped.push(message)
      continue
    }
    changed = true
    const streaming = Boolean(previous.streaming || message.streaming)
    grouped[grouped.length - 1] = {
      ...previous,
      completedAt: streaming ? undefined : message.completedAt ?? previous.completedAt,
      streaming,
      parts: [...previous.parts, ...message.parts],
    }
  }
  return changed ? grouped : messages
}

interface TranscriptProps {
  messages: TranscriptMessage[]
  git: GitStatus
  /** Active harness; brands the assistant marks and working copy. */
  harness?: HarnessId
  loading?: boolean
  active?: boolean
  showReasoning?: boolean
  showTools?: boolean
  onOpenChanges(): void
  onSuggestion(prompt: string): void
  suggestionsDisabled?: boolean
  /** Render the pinned changes card here; the app docks it beside the composer when false. */
  showPinnedChanges?: boolean
  /** Reserve room for bottom-docked changes and queued-message affordances. */
  bottomDockHasChanges?: boolean
  queuedMessageCount?: number
  onOpenSessionReference?(sessionId: string, harness: HarnessId): void
}


const ASSISTANT_MARKS = { omp: OmpMark, prime: PrimeMark, pi: PiMark } satisfies Record<HarnessId, unknown>
function AssistantMark({ harness, size = 24 }: { harness: HarnessId; size?: number }) {
  const Mark = ASSISTANT_MARKS[harness]
  return <Mark size={size} />
}

function ActiveAssistantMessage({ message, harness, showReasoning, showTools }: { message: TranscriptMessage; harness: HarnessId; showReasoning: boolean; showTools: boolean }) {
  const visibleActivity = message.parts.some((part) => part.type === 'thinking' && showReasoning || (part.type === 'toolCall' || part.type === 'toolResult') && showTools || part.type === 'agentMessage')
  return (
    <article className="message message--assistant">
      <div className="assistant-mark"><AssistantMark harness={harness} /></div>
      <div className="message__content">
        {visibleActivity
          ? <WorkDisclosure message={message} parts={message.parts} showReasoning={showReasoning} showTools={showTools} running />
          : <>
            {message.parts.map((part, index) => part.type === 'text' ? <MarkdownText key={index} text={part.text} /> : null)}
            <div className="streaming-state" aria-live="polite"><ThinkingDots /> {HARNESS_SHORT_NAMES[harness]} is working <LiveElapsed since={message.startedAt ?? message.timestamp} /></div>
          </>}
      </div>
    </article>
  )
}



export function Transcript({ messages, git, harness = 'prime', loading, active = false, showReasoning = true, showTools = true, onOpenChanges, onSuggestion, suggestionsDisabled, showPinnedChanges = true, bottomDockHasChanges = false, queuedMessageCount = 0, onOpenSessionReference }: TranscriptProps) {
  const groupedMessages = useMemo(() => coalesceAssistantTurns(messages), [messages])
  const { announcement, hiddenCount, scrollRef, showEarlier, updatePinnedState, visibleMessages } = useTranscriptScroll(groupedMessages)
  const activeAssistantId = useMemo(() => active && groupedMessages.at(-1)?.role === 'assistant' ? groupedMessages.at(-1)?.id : undefined, [active, groupedMessages])
  const transcriptClasses = [
    'transcript',
    'scroll-area',
    showPinnedChanges && git.files.length ? 'has-pinned-changes' : '',
    bottomDockHasChanges ? 'has-docked-changes' : '',
    queuedMessageCount > 0 ? 'has-queued-messages' : '',
  ].filter(Boolean).join(' ')

  return <>
    <div ref={scrollRef} className={transcriptClasses} aria-busy={loading} onScroll={updatePinnedState}>
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      <div className="transcript__inner">
        {loading ? <div className="transcript-loading"><LoaderCircle className="spin" size={16} /> Loading session…</div> : null}
        {!loading && messages.length === 0 ? <div className="session-welcome">
          <AssistantMark harness={harness} size={34} />
          <h1>What should we work on?</h1>
          <p>{HARNESS_SHORT_NAMES[harness]} can inspect this project, edit files, run tools, and keep working across sessions.</p>
          <div className="prompt-suggestions">
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Summarize this project')}>Summarize this project</button>
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Find a useful next task')}>Find a useful next task</button>
            <button type="button" disabled={suggestionsDisabled} onClick={() => onSuggestion('Run the test suite')}>Run the test suite</button>
          </div>
        </div> : null}
        {hiddenCount > 0 ? <button type="button" className="transcript__show-earlier" onClick={showEarlier}>Show {Math.min(250, hiddenCount)} earlier messages</button> : null}
        {visibleMessages.map((message) => <ErrorBoundary key={message.id} fallback={<div className="message message--render-failure" role="note">This message could not be displayed.</div>}>
          {message.kind === 'steer-read-marker' ? <SteerReadMarker message={message} />
            : message.role === 'user' ? <UserMessage message={message} onOpenSessionReference={onOpenSessionReference} />
            : message.role === 'assistant' ? message.streaming || message.id === activeAssistantId
              ? <ActiveAssistantMessage message={message} harness={harness} showReasoning={showReasoning} showTools={showTools} />
              : <AssistantMessage message={message} harness={harness} showReasoning={showReasoning} showTools={showTools} />
            : message.role === 'agent' ? <AgentMessage message={message} />
            : message.role === 'goal' ? <GoalMessage message={message} />
            : message.role === 'tool' || message.role === 'system' ? <ActivityMessage message={message} harness={harness} />
            : <div className={`message message--${message.role}`}>{message.parts.map((part, partIndex) => part.type === 'text' ? <span key={partIndex}>{part.text}</span> : null)}</div>}
        </ErrorBoundary>)}
        {active && !activeAssistantId ? <article className="message message--assistant transcript-active-placeholder" aria-live="polite">
          <div className="assistant-mark"><AssistantMark harness={harness} /></div><div className="streaming-state"><ThinkingDots /> {HARNESS_SHORT_NAMES[harness]} is working</div>
        </article> : null}
        <div />
      </div>
    </div>
    {showPinnedChanges && git.files.length ? <div className="transcript-changes-pin"><ChangesCard git={git} onOpenChanges={onOpenChanges} /></div> : null}
  </>
}
