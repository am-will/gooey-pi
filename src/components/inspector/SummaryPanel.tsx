import { memo, useMemo } from 'react'
import { CalendarClock, Check, CircleDot, GitBranch, HeartPulse, LoaderCircle } from 'lucide-react'
import type { AutomationScheduleRecord, GitStatus, NativeHeartbeatRecord, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import { formatRelative } from '@/lib/data'
import { formatSessionCost, formatSessionTokens } from '@/lib/format-cost'
import { MarkdownText } from '../MarkdownText'

interface SummaryPanelProps {
  /** Active harness agent name ("Prime Agent" / "OMP"). */
  agentName?: string
  /** Short harness name for working copy ("Prime" / "OMP"). */
  shortName?: string
  project?: ProjectRecord
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  automations: AutomationScheduleRecord[]
  heartbeats: NativeHeartbeatRecord[]
  onOpenAutomation(id: string): void
}

export interface TranscriptSummary {
  toolCount: number
  lastText?: string
}

/** One pass for the tool count; one reverse walk that stops at the first text part. */
export function summarizeTranscript(messages: TranscriptMessage[]): TranscriptSummary {
  let toolCount = 0
  for (const message of messages) {
    for (const part of message.parts) if (part.type === 'toolCall') toolCount += 1
  }
  let lastText: string | undefined
  for (let index = messages.length - 1; index >= 0 && lastText === undefined; index -= 1) {
    const parts = messages[index].parts
    for (let cursor = parts.length - 1; cursor >= 0; cursor -= 1) {
      const part = parts[cursor]
      if (part.type === 'text') {
        lastText = part.text
        break
      }
    }
  }
  return { toolCount, lastText }
}

export const SummaryPanel = memo(function SummaryPanel({ agentName = 'Prime Agent', shortName = 'Prime', project, runtime, messages, git, automations, heartbeats, onOpenAutomation }: SummaryPanelProps) {
  const { toolCount, lastText } = useMemo(() => summarizeTranscript(messages), [messages])
  const active = Boolean(runtime?.isStreaming || runtime?.isCompacting)
  const sessionCost = formatSessionCost(runtime?.sessionUsage)
  const sessionTokens = formatSessionTokens(runtime?.sessionUsage)
  return (
    <div className="inspector-scroll scroll-area summary-panel">
      <section className="summary-hero">
        <span className={`run-state ${active ? 'is-running' : ''}`}>{active ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}{runtime?.isCompacting ? 'Compacting context' : active ? `${shortName} is working` : 'Ready'}</span>
        <h2>{runtime?.isCompacting ? 'Compacting the session context' : active ? 'Working through the request' : 'Session overview'}</h2>
        <MarkdownText text={lastText !== undefined ? lastText.slice(0, 220) : 'Start a conversation to see a compact summary of the work here.'} />
      </section>
      <section className="summary-section"><h3>Workspace</h3><dl className="detail-list"><div><dt>Project</dt><dd>{project?.name ?? 'No project'}</dd></div><div><dt>Branch</dt><dd><GitBranch size={12} />{git.branch ?? project?.gitBranch ?? '—'}</dd></div><div><dt>Environment</dt><dd>Local</dd></div><div><dt>Working directory</dt><dd title={project?.primaryFolder} className="mono truncate">{project?.primaryFolder ?? '—'}</dd></div></dl></section>
      <section className="summary-section"><h3>Progress</h3><div className="progress-list"><div><Check size={13} /><span>Loaded project context</span></div><div><Check size={13} /><span>{toolCount} tool {toolCount === 1 ? 'call' : 'calls'} recorded</span></div><div className={git.files.length ? 'is-current' : ''}><CircleDot size={13} /><span>{git.files.length ? `${git.files.length} files ready to review` : git.isRepo ? 'No uncommitted changes' : 'Git repository not detected'}</span></div></div></section>
      {automations.length || heartbeats.length ? <section className="summary-section"><h3>Automations</h3><div className="summary-automation-list">
        {automations.slice(0, 2).map((task) => <button type="button" key={task.id} onClick={() => onOpenAutomation(task.id)}>
          <span className="summary-automation-icon"><CalendarClock size={14}/></span><span><strong>{task.title}</strong><small>{task.status}{task.nextRunAt ? ` · Next ${formatRelative(task.nextRunAt)}` : ''}</small></span>
        </button>)}
        {heartbeats.slice(0, Math.max(0, 2 - automations.length)).map((heartbeat) => <button type="button" key={heartbeat.id} onClick={() => onOpenAutomation(heartbeat.id)}>
          <span className="summary-automation-icon is-heartbeat"><HeartPulse size={14}/></span><span><strong>{heartbeat.label ?? (heartbeat.source === 'heartbeat' ? 'Thread heartbeat' : 'Agent heartbeat')}</strong><small>{heartbeat.status}{heartbeat.nextRunAt ? ` · Next ${formatRelative(heartbeat.nextRunAt)}` : ''}</small></span>
        </button>)}
        {automations.length + heartbeats.length > 2 ? <button type="button" className="summary-automation-more" onClick={() => onOpenAutomation(automations[0]?.id ?? heartbeats[0]!.id)}>View all {automations.length + heartbeats.length} automations</button> : null}
      </div></section> : null}
      <section className="summary-section"><h3>Context</h3><div className="context-meter"><div><span>Session context</span><span>Managed</span></div><small>{agentName} monitors and compacts context when needed.</small></div>
        {sessionCost !== null ? <dl className="detail-list summary-cost"><div><dt>Cost</dt><dd title={sessionTokens ?? undefined}>{sessionCost}</dd></div>{sessionTokens ? <div><dt>Tokens</dt><dd className="mono truncate" title={sessionTokens}>{sessionTokens}</dd></div> : null}</dl> : null}</section>
    </div>
  )
})
