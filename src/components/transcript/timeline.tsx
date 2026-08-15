import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  GitFork,
  Globe2,
  Layers3,
  LoaderCircle,
  MessageCircle,
  MessageCircleQuestion,
  TerminalSquare,
  Wrench,
} from 'lucide-react'
import type { MessagePart, TranscriptMessage } from '@/types/api'
import { writeClipboardText } from '@/lib/clipboard'
import { boundText } from '@/lib/render-bounds'
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
  if (/bash|shell|terminal|command|exec|process/i.test(name)) return 'terminal'
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
    const preferred = args.question ?? args.command ?? args.query ?? args.url ?? args.path ?? args.cwd
    if (typeof preferred === 'string') return boundText(preferred.replace(/\s+/g, ' ').trim(), 180, '…')
  }
  return boundText(serialize(raw).replace(/\s+/g, ' ').trim(), 180, '…')
}

function ReasoningPart({ part, streaming = false }: { part: Extract<MessagePart, { type: 'thinking' }>; streaming?: boolean }) {
  return <div className="activity-line activity-line--reasoning"><MarkdownText text={boundText(part.text, 40_000, '\n… [Reasoning truncated in the desktop view.]')} streaming={streaming} /></div>
}

export function ThinkingDots({ labelled = false }: { labelled?: boolean }) {
  return (
    <span className="thinking-dots" role={labelled ? 'status' : undefined} aria-label={labelled ? 'Prime is thinking' : undefined} aria-hidden={labelled ? undefined : true}>
      <span /><span /><span />
    </span>
  )
}

function ToolPart({ part, next }: { part: Extract<MessagePart, { type: 'toolCall' }>; next?: MessagePart }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const resetCopiedTimerRef = useRef<number | null>(null)
  const result = next?.type === 'toolResult' ? next : undefined
  const failed = result?.isError
  const finished = result && !result.streaming
  const kind = classifyTool(part.name)
  const args = serialize(part.args, true)
  const output = result?.text ?? ''
  const visibleOutput = boundText(`${args}${args && output ? '\n\n' : ''}${output}`, 200_000, '\n\n[Output truncated in the desktop view.]')
  const canExpand = Boolean(visibleOutput)
  const state = failed ? 'error' : finished ? 'done' : kind === 'question' ? 'waiting' : 'running'
  const preview = toolPreview(part)
  useEffect(
    () => () => {
      if (resetCopiedTimerRef.current !== null) window.clearTimeout(resetCopiedTimerRef.current)
    },
    [],
  )

  const copyContents = async () => {
    try {
      await writeClipboardText(visibleOutput)
      setCopied(true)
      if (resetCopiedTimerRef.current !== null) window.clearTimeout(resetCopiedTimerRef.current)
      resetCopiedTimerRef.current = window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className={`activity-line activity-line--tool activity-line--${kind} is-${state}`}>
      <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
        <span className="activity-line__icon">{toolIcon(kind)}</span>
        <span className="activity-line__kind">{kind === 'question' ? 'Question' : part.name}</span>
        {preview ? <code className="activity-tool__preview"><SyntaxText text={preview} /></code> : null}
        <span className="activity-tool__state">{failed ? <><CircleAlert size={12} /> failed</> : finished ? <><Check size={12} /> done</> : kind === 'question' ? 'needs input' : <><LoaderCircle className="spin" size={12} /> running</>}</span>
        {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </button>
      {open && visibleOutput ? (
        <div className="activity-tool__details">
          <div className="activity-tool__details-toolbar">
            <button type="button" className="activity-tool__copy" aria-label={`${copied ? 'Copied' : 'Copy'} tool contents`} onClick={() => void copyContents()}>
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="activity-tool__contents"><SyntaxText text={visibleOutput} /></pre>
        </div>
      ) : null}
    </div>
  )
}

function StandaloneToolResult({ part }: { part: Extract<MessagePart, { type: 'toolResult' }> }) {
  return <div className={`activity-line activity-line--result ${part.isError ? 'is-error' : ''}`}><span className="activity-line__icon">{part.isError ? <CircleAlert size={13} /> : <Check size={13} />}</span><span>{boundText(part.text, 2_000, '…')}</span></div>
}

function AgentActivityPart({ part }: { part: Extract<MessagePart, { type: 'agentMessage' }> }) {
  const [open, setOpen] = useState(false)
  const canExpand = Boolean(part.text)
  return <div className="activity-line activity-line--agent">
    <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
      <span className="activity-line__icon"><MessageCircle size={14} /></span>
      <span className="activity-line__kind">Message from agent</span>
      {part.agentName ? <span className="activity-agent__name">{part.agentName}</span> : null}
      {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
    </button>
    {open && part.text ? <div className="activity-agent__details"><MarkdownText text={boundText(part.text, 40_000, '\n… [Agent message truncated in the desktop view.]')} /></div> : null}
  </div>
}

function compactionReasonLabel(reason: Extract<MessagePart, { type: 'compaction' }>['reason']): string {
  if (reason === 'threshold') return 'automatic threshold'
  if (reason === 'overflow') return 'overflow recovery'
  if (reason === 'requested') return 'requested'
  if (reason === 'manual') return 'manual'
  return 'context'
}

function CompactionPart({ part }: { part: Extract<MessagePart, { type: 'compaction' }> }) {
  const [open, setOpen] = useState(false)
  const canExpand = Boolean(part.summary || part.error)
  const label = part.status === 'running'
    ? 'Compacting context'
    : part.status === 'done'
      ? 'Context compacted'
      : part.status === 'cancelled' ? 'Context compaction cancelled' : part.outcome === 'skipped' ? 'Context compaction skipped' : 'Context compaction failed'
  const state = part.status === 'running'
    ? <><LoaderCircle className="spin" size={12} /> running</>
    : part.status === 'done'
      ? <><Check size={12} /> {part.willRetry ? 'continuing' : 'done'}</>
      : <><CircleAlert size={12} /> {part.status === 'cancelled' ? 'cancelled' : 'needs attention'}</>
  const details = part.error || part.summary
  const tokenLabel = part.tokensBefore === undefined ? '' : `${part.tokensBefore.toLocaleString()} tokens before`
  return <div className={`activity-line activity-line--compaction is-${part.status}`}>
    <button type="button" className="activity-tool__summary" disabled={!canExpand} onClick={() => setOpen((value) => !value)} aria-expanded={canExpand ? open : undefined}>
      <span className="activity-line__icon">{part.status === 'running' ? <LoaderCircle className="spin" size={13} /> : part.status === 'done' ? <Layers3 size={13} /> : <CircleAlert size={13} />}</span>
      <span className="activity-line__kind">{label}</span>
      <span className="activity-compaction__reason">{compactionReasonLabel(part.reason)}</span>
      {tokenLabel ? <span className="activity-compaction__tokens">{tokenLabel}</span> : null}
      <span className="activity-tool__state">{state}</span>
      {canExpand ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
    </button>
    {open && details ? <div className={`activity-compaction__details ${part.status === 'done' ? '' : 'is-error'}`}><MarkdownText text={boundText(details, 40_000, '\n… [Compaction details truncated in the desktop view.]')} /></div> : null}
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
    if (part.type === 'text') return <div className="activity-line activity-line--note" key={key}><MarkdownText text={part.text} /></div>
    return null
  })}</div>
}

function liveWorkStatus(parts: MessagePart[], showReasoning: boolean, showTools: boolean): 'Thinking' | 'Working' {
  let status: 'Thinking' | 'Working' | undefined
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    const next = parts[index + 1]
    if (part.type === 'toolCall' && (next?.type !== 'toolResult' || next.streaming)) return 'Working'
    if (status || part.type === 'image') continue
    if (part.type === 'thinking') status = showReasoning ? 'Thinking' : undefined
    else if (showTools || part.type !== 'toolCall' && part.type !== 'toolResult') status = 'Working'
  }
  return status ?? 'Working'
}

export function WorkDisclosure({ message, parts, showReasoning, showTools, running = message.streaming }: { message: TranscriptMessage; parts: MessagePart[]; showReasoning: boolean; showTools: boolean; running?: boolean }) {
  const [open, setOpen] = useState(false)
  if (running) {
    const status = liveWorkStatus(message.parts, showReasoning, showTools)
    return <section className="work-disclosure is-running" aria-label="Agent work activity">
      <span className="work-disclosure__rail" aria-hidden="true" />
      <div className="work-disclosure__live">
        <div className="work-disclosure__status" role="status"><span>{status}</span><ThinkingDots /></div>
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
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Worked for {duration}</span>
      </button>
      {open ? <WorkTimeline parts={parts} showReasoning={showReasoning} showTools={showTools} /> : null}
    </section>
  )
}
