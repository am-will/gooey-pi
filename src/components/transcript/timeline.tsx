import { memo, useMemo, useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  GitFork,
  Globe2,
  Info,
  Layers3,
  LoaderCircle,
  MessageCircle,
  MessageCircleQuestion,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import type { MessagePart, PrimeCompactionReason, TranscriptMessage } from '@/types/api'
import { useCopyFeedback } from '@/hooks/useCopyFeedback'
import { isRequestedCompactionReason } from '@/lib/compaction-reason'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { boundText } from '@/lib/render-bounds'
import { transcriptText } from '@/lib/transcript-notes'
import { MarkdownText } from '../MarkdownText'
import { SyntaxText } from './syntax'

function timestamp(value?: string | number): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatWorkedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000))
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes === 0) return `${seconds}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  if (hours === 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${hours}h${String(minutes).padStart(2, '0')}m${String(seconds).padStart(2, '0')}s`
}

export type ToolKind = 'question' | 'terminal' | 'web' | 'git' | 'file' | 'mcp'

export function classifyTool(name: string): ToolKind {
  if (/ask[_\s.-]?user|ask\s+(?:a\s+)?question|ui\.select|request[_\s.-]?input/i.test(name)) return 'question'
  if (/bash|shell|terminal|command|exec|process|python|\beval\b/i.test(name)) return 'terminal'
  if (/github|\bgit\b|commit|branch|pull[_\s-]?request/i.test(name)) return 'git'
  if (/browser|web[_\s.-]?search|search[_\s.-]?web|fetch|https?|url|globe/i.test(name)) return 'web'
  if (/read|write|edit|file|path|directory|patch/i.test(name)) return 'file'
  return 'mcp'
}

function toolIcon(kind: ToolKind): ReactNode {
  if (kind === 'question') return <MessageCircleQuestion size={14} />
  if (kind === 'terminal') return <TerminalSquare size={14} />
  if (kind === 'web') return <Globe2 size={14} />
  if (kind === 'git') return <GitFork size={14} />
  if (kind === 'file') return <FileCode2 size={14} />
  return <Wrench size={14} />
}

function serialize(value: unknown, pretty = false): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, pretty ? 2 : undefined) } catch { return String(value) }
}

function toolPreview(part: Extract<MessagePart, { type: 'toolCall' }>): string {
  const raw = part.args
  if (raw && typeof raw === 'object') {
    const args = raw as Record<string, unknown>
    const preferred = args.question ?? args.command ?? args.code ?? args.query ?? args.url ?? args.path ?? args.cwd
    if (typeof preferred === 'string') return boundText(preferred.replace(/\s+/g, ' ').trim(), 180, '…')
  }
  return typeof raw === 'string' ? boundText(raw.replace(/\s+/g, ' ').trim(), 180, '…') : ''
}

function ReasoningPart({ part, streaming = false }: { part: Extract<MessagePart, { type: 'thinking' }>; streaming?: boolean }) {
  const { t } = useI18n()
  return <div className="activity-line activity-line--reasoning"><MarkdownText text={boundText(part.text, 40_000, `\n${t('transcript.truncatedReasoning')}`)} streaming={streaming} /></div>
}

/** Decorative and hidden from assistive technology: render it beside visible status text. */
export function ThinkingDots() {
  return (
    <span className="thinking-dots" aria-hidden="true">
      <span /><span /><span />
    </span>
  )
}

/**
 * Self-ticking elapsed clock for a live work phase. The timer lives inside
 * this leaf component so only the small label re-renders every second, not
 * the whole transcript row. `aria-hidden` keeps the 1-second churn out of
 * screen-reader announcements; the neighbouring state text already carries
 * the semantic (thinking/working), the duration is decorative.
 */
export function LiveElapsed({ since }: { since?: string | number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])
  const startedAt = timestamp(since)
  if (startedAt === undefined) return null
  return <span className="live-elapsed" aria-hidden="true">{formatWorkedDuration(Math.max(0, now - startedAt))}</span>
}

const ToolPart = memo(function ToolPart({ part, next }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const { copied, copy } = useCopyFeedback()
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const finished = result && !result.streaming
  const kind = classifyTool(part.name)
  const visibleOutput = useMemo(() => {
    if (!open) return ''
    const args = serialize(part.args, true)
    const output = result?.text ?? ''
    return boundText(`${args}${args && output ? '\n\n' : ''}${output}`, 200_000, `\n\n${t('transcript.truncatedOutput')}`)
  }, [open, part.args, result?.text, t])
  const canExpand = Boolean(result?.text) || (typeof part.args === 'string' ? Boolean(part.args) : part.args !== undefined)
  const state = failed ? 'error' : finished ? 'done' : kind === 'question' ? 'waiting' : 'running'
  const preview = toolPreview(part)

  return (
    <div className={`activity-line activity-line--tool activity-line--${kind} is-${state}`}>
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
        <span className="activity-line__icon">{toolIcon(kind)}</span>
        <span className="activity-line__kind">{kind === 'question' ? t('transcript.toolQuestion') : part.name}</span>
        {preview ? <code className="activity-tool__preview"><SyntaxText text={preview} /></code> : null}
        <span className="activity-tool__state">{failed ? <><CircleAlert size={12} /> {t('transcript.state.failed')}</> : finished ? <><Check size={12} /> {t('transcript.state.done')}</> : kind === 'question' ? t('transcript.state.needsInput') : <><LoaderCircle className="spin" size={12} /> {t('transcript.state.running')}</>}</span>
        {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && visibleOutput ? (
        <div className="activity-tool__details">
          <div className="activity-tool__details-toolbar">
            <button type="button" className="activity-tool__copy" aria-label={t('transcript.copyToolContents', { action: t(copied ? 'transcript.copyAction.copied' : 'transcript.copyAction.copy') })} onClick={() => void copy(visibleOutput)}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {t(copied ? 'transcript.copyAction.copied' : 'transcript.copyAction.copy')}
            </button>
          </div>
          <pre className="activity-tool__contents"><SyntaxText text={visibleOutput} /></pre>
        </div>
      ) : null}
    </div>
  )
})

function StandaloneToolResult({ part }: { part: Extract<MessagePart, { type: 'toolResult' }> }) {
  return <div className={`activity-line activity-line--result ${part.isError ? 'is-error' : ''}`}><span className="activity-line__icon">{part.isError ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{boundText(part.text, 2_000, '…')}</span></div>
}

function AgentActivityPart({ part }: { part: Extract<MessagePart, { type: 'agentMessage' }> }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const canExpand = Boolean(part.text)
  return <div className="activity-line activity-line--agent">
    <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
      <span className="activity-line__icon"><MessageCircle size={14} /></span>
      <span className="activity-line__kind">{t('transcript.agentMessage')}</span>
      {part.agentName ? <span className="activity-agent__name">{part.agentName}</span> : null}
      {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
    </button>
    {open && part.text ? <div className="activity-agent__details"><MarkdownText text={boundText(part.text, 40_000, `\n${t('transcript.truncatedAgentMessage')}`)} /></div> : null}
  </div>
}

type CompactionPartValue = Extract<MessagePart, { type: 'compaction' }>
type CompactionTone = CompactionPartValue['status'] | 'skipped'

// Keyed by the type, so adding a reason there fails to compile until it has a label here.
const COMPACTION_REASON_KEYS: Record<PrimeCompactionReason, MessageKey> = {
  manual: 'transcript.compaction.reason.manual',
  threshold: 'transcript.compaction.reason.threshold',
  overflow: 'transcript.compaction.reason.overflow',
  requested: 'transcript.compaction.reason.requested',
  idle: 'transcript.compaction.reason.idle',
  incomplete: 'transcript.compaction.reason.incomplete',
}

/** A compaction that ended without running because it was skipped is benign: it reads as a notice, never as a failure. */
function compactionTone(part: CompactionPartValue): CompactionTone {
  return part.status === 'failed' && part.outcome === 'skipped' ? 'skipped' : part.status
}

function compactionLabel(part: CompactionPartValue, tone: CompactionTone, t: ReturnType<typeof useI18n>['t']): string {
  if (tone === 'running') return t('transcript.compaction.running')
  if (tone === 'done') return t('transcript.compaction.done')
  if (tone === 'cancelled') return t('transcript.compaction.cancelled')
  if (tone === 'failed') return t('transcript.compaction.failed')
  // A compaction someone asked for is skipped only when the history is too short for one.
  return t(isRequestedCompactionReason(part.reason) ? 'transcript.compaction.nothingYet' : 'transcript.compaction.skipped')
}

function CompactionPart({ part }: { part: CompactionPartValue }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const canExpand = Boolean(part.summary || part.error)
  const tone = compactionTone(part)
  const state = tone === 'running'
    ? <><LoaderCircle className="spin" size={12} /> {t('transcript.state.running')}</>
    : tone === 'done'
      ? <><Check size={12} /> {t(part.willRetry ? 'transcript.state.continuing' : 'transcript.state.done')}</>
      : tone === 'skipped'
        ? <><Info size={12} /> {t('transcript.state.skipped')}</>
        : <><CircleAlert size={12} /> {t(tone === 'cancelled' ? 'transcript.state.cancelled' : 'transcript.state.needsAttention')}</>
  const details = part.errorKind === 'incomplete' ? t('transcript.compactionIncomplete') : part.error || part.summary
  const tokenLabel = part.tokensBefore === undefined ? '' : t('transcript.compaction.tokensBefore', { count: part.tokensBefore.toLocaleString() })
  // No harness records the trigger with a completed compaction in its session file, so a reloaded row may name none.
  const reasonLabel = part.reason ? t(COMPACTION_REASON_KEYS[part.reason]) : undefined
  return <div className={`activity-line activity-line--compaction is-${tone}`}>
    <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
      <span className="activity-line__icon">{tone === 'running' ? <LoaderCircle className="spin" size={13} /> : tone === 'done' ? <Layers3 size={13} /> : tone === 'skipped' ? <Info size={13} /> : <CircleAlert size={13} />}</span>
      <span className="activity-line__kind">{compactionLabel(part, tone, t)}</span>
      {reasonLabel ? <span className="activity-compaction__reason">{reasonLabel}</span> : null}
      {tokenLabel ? <span className="activity-compaction__tokens">{tokenLabel}</span> : null}
      <span className="activity-tool__state">{state}</span>
      {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
    </button>
    {open && details ? <div className={`activity-compaction__details ${tone === 'done' || tone === 'skipped' ? '' : 'is-error'}`}><MarkdownText text={boundText(details, 40_000, '\n… [Compaction details truncated in the desktop view.]')} /></div> : null}
  </div>
}

/**
 * Streaming reducers splice tool results into the middle of a part list, so
 * index keys detach expanded panels mid-stream. Key on the part's stable id
 * (a tool call keeps its semantic tool id); parts loaded from disk without an
 * id fall back to a type-scoped index, which is stable for static lists.
 */
function partKey(part: MessagePart, index: number): string {
  if (part.type === 'toolCall' && part.id) return part.id
  return part.partId ?? `${part.type}:${index}`
}

export function WorkTimeline({ parts, showReasoning, showTools, streaming = false }: { parts: MessagePart[]; showReasoning: boolean; showTools: boolean; streaming?: boolean }) {
  const { t } = useI18n()
  const pairedResults = new Set<number>()
  return <div className="work-timeline">{parts.map((part, index) => {
    const key = partKey(part, index)
    if (part.type === 'toolResult' && pairedResults.has(index)) return null
    if (part.type === 'compaction') return <CompactionPart key={key} part={part} />
    if (part.type === 'thinking') return showReasoning ? <ReasoningPart key={key} part={part} streaming={streaming} /> : null
    if (part.type === 'toolCall') {
      if (!showTools) return null
      const next = parts[index + 1]
      if (next?.type === 'toolResult') pairedResults.add(index + 1)
      return <ToolPart key={key} part={part} next={next} />
    }
    if (part.type === 'toolResult') return showTools ? <StandaloneToolResult key={key} part={part} /> : null
    if (part.type === 'agentMessage') return <AgentActivityPart key={key} part={part} />
    if (part.type === 'text') return <div className="activity-line activity-line--note" key={key}><MarkdownText text={boundText(transcriptText(part, t), 40_000, '\n… [Note truncated in the desktop view.]')} streaming={streaming} /></div>
    return null
  })}</div>
}

function liveWorkStatusKey(parts: MessagePart[], showReasoning: boolean, showTools: boolean): MessageKey {
  let status: MessageKey | undefined
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const next = parts[index + 1]
    if (part.type === 'toolCall' && (next?.type !== 'toolResult' || next.streaming)) return 'transcript.status.working'
    if (status || part.type === 'image') continue
    if (part.type === 'thinking') status = showReasoning ? 'transcript.status.thinking' : undefined
    else if (showTools || part.type !== 'toolCall' && part.type !== 'toolResult') status = 'transcript.status.working'
  }
  return status ?? 'transcript.status.working'
}

export function WorkDisclosure({ message, parts, showReasoning, showTools, running = message.streaming }: { message: TranscriptMessage; parts: MessagePart[]; showReasoning: boolean; showTools: boolean; running?: boolean }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (running) {
    const status = liveWorkStatusKey(message.parts, showReasoning, showTools)
    return <section className="work-disclosure is-running" aria-label={t('transcript.agentWorkActivity')}>
      <span className="work-disclosure__rail" aria-hidden="true" />
      <div className="work-disclosure__live">
        <div className="work-disclosure__status" role="status"><span>{t(status)}</span><LiveElapsed since={message.startedAt ?? message.timestamp} /><ThinkingDots /></div>
        <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} streaming />
      </div>
    </section>
  }
  const startedAt = timestamp(message.startedAt ?? message.timestamp) ?? 0
  const completedAt = timestamp(message.completedAt) ?? startedAt
  const duration = formatWorkedDuration(Math.max(0, completedAt - startedAt))
  return (
    <section className="work-disclosure">
      <button type="button" className="work-disclosure__button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{t('transcript.workedFor', { duration })}</span>
      </button>
      {open ? <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} /> : null}
    </section>
  )
}
