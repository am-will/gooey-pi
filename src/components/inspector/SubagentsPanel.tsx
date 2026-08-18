import { memo } from 'react'
import { Check, CircleAlert, LoaderCircle, Users } from 'lucide-react'
import type { SubagentRecord } from '@/types/api'
import { isTerminalSubagentStatus } from '@/lib/subagents'
import type { SubagentFeedMode } from '@/hooks/useSubagents'
import { EmptyState } from '../ui'

interface SubagentsPanelProps {
  /** Short harness name for working copy ("OMP"). */
  shortName?: string
  subagents: SubagentRecord[]
  mode: SubagentFeedMode
  error?: string
}

function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || ms < 0) return undefined
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

function formatTokens(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function statusLabel(subagent: SubagentRecord): string {
  if (subagent.status === 'completed') return 'Finished'
  if (subagent.status === 'failed') return 'Failed'
  if (subagent.status === 'unknown') return 'Unknown'
  return 'Running'
}

/**
 * Live roster of the subagents the active session spawned.
 *
 * The session inbox keys one row on `session.status`, so a session running six
 * subagents reads as a single "running" row. This panel is the per-subagent
 * view: which one is live, what tool it last finished, and how long it has
 * been going.
 */
export const SubagentsPanel = memo(function SubagentsPanel({ shortName = 'OMP', subagents, mode, error }: SubagentsPanelProps) {
  if (error || mode === 'unsupported') {
    return <div className="inspector-scroll scroll-area subagents-panel">
      <EmptyState icon={<CircleAlert size={24} />} title="Subagents unavailable">{error ?? `This ${shortName} session did not report a subagent roster.`}</EmptyState>
    </div>
  }
  if (!subagents.length) {
    return <div className="inspector-scroll scroll-area subagents-panel">
      <EmptyState icon={<Users size={24} />} title="No subagents running">Delegated work appears here while {shortName} runs it, and stays until the next turn starts.</EmptyState>
    </div>
  }
  return (
    <div className="inspector-scroll scroll-area subagents-panel">
      <ul className="subagent-list">
        {subagents.map((subagent) => {
          const running = !isTerminalSubagentStatus(subagent.status)
          const duration = formatDuration(subagent.durationMs)
          const tokens = formatTokens(subagent.tokens)
          const latestTool = subagent.recentTools?.[0]?.tool
          return <li className={`subagent-row subagent-row--${subagent.status}`} key={subagent.id}>
            <span className={`subagent-icon subagent-icon--${subagent.status}`}>
              {running ? <LoaderCircle className="spin" size={14} /> : subagent.status === 'failed' ? <CircleAlert size={14} /> : <Check size={14} />}
            </span>
            <span className="subagent-main">
              <span className="subagent-title">
                <strong>{subagent.description ?? subagent.id}</strong>
                {subagent.agent ? <i>{subagent.agent}</i> : null}
              </span>
              <small className="subagent-intent">{subagent.lastIntent ?? (latestTool ? `Last tool: ${latestTool}` : 'Starting up')}</small>
              <span className="subagent-meta">
                <span>{statusLabel(subagent)}</span>
                {duration ? <span>{duration}</span> : null}
                {subagent.toolCount !== undefined ? <span>{subagent.toolCount} {subagent.toolCount === 1 ? 'tool' : 'tools'}</span> : null}
                {tokens ? <span>{tokens} tokens</span> : null}
                {subagent.resolvedModel ? <span className="truncate" title={subagent.resolvedModel}>{subagent.resolvedModel}</span> : null}
              </span>
            </span>
          </li>
        })}
      </ul>
      {mode === 'poll' ? <p className="subagent-note">This agent does not push subagent updates, so the roster is refreshed on a timer.</p> : null}
    </div>
  )
})
