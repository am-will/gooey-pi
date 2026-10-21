import { LoaderCircle } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { ChildSession } from '@/types/subagents'

export type ChildRosterView =
  | { kind: 'loading'; parentFile: string }
  | { kind: 'unavailable'; parentFile: string; reason?: string }
  | { kind: 'error'; parentFile: string; message: string; retry(): void }
  | { kind: 'ready'; parentFile: string; children: ChildSession[]; truncated: boolean; selectedId?: string; onSelect(child: ChildSession, trigger: HTMLButtonElement): void }

export function childDepth(child: ChildSession, children: ChildSession[]): number {
  const seen = new Set([child.id])
  let parent = child.parentId
  let depth = 0
  while (parent && depth < 8 && !seen.has(parent)) {
    const ancestor = children.find((candidate) => candidate.id === parent)
    if (!ancestor) break
    seen.add(parent)
    depth += 1
    parent = ancestor.parentId
  }
  return depth
}

export function ChildSessionRows({ roster }: { roster: ChildRosterView }) {
  const { t } = useI18n()
  if (roster.kind === 'unavailable') return <p className="child-roster-note" title={roster.reason}>{t('children.ompOnly')}</p>
  if (roster.kind === 'loading') return <p className="child-roster-note" role="status"><LoaderCircle className="spin" size={11} />{t('children.loading')}</p>
  if (roster.kind === 'error') return <div className="child-roster-note" role="status"><p>{t('children.unavailable')}</p><button type="button" title={roster.message} onClick={roster.retry}>{t('children.retry')}</button></div>
  if (!roster.children.length) return null
  return <div className="child-session-list" aria-label={t('children.roster')}>
    {roster.children.map((child) => <button key={child.id} type="button" className={`child-session-row${roster.selectedId === child.id ? ' is-selected' : ''}`} style={{ paddingLeft: `${8 + childDepth(child, roster.children) * 10}px` }} aria-pressed={roster.selectedId === child.id} onClick={(event) => roster.onSelect(child, event.currentTarget)} title={child.task ?? child.title}>
      <span className="child-session-row__title">{child.title}</span><span className="child-session-row__status">{t(`sidebar.status.${child.status}`)}</span>
    </button>)}
    {roster.truncated ? <p className="child-roster-note">{t('children.rosterLimited')}</p> : null}
  </div>
}
