import { useEffect, useRef } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import { ChildHistoryMessage } from '@/components/ChildHistoryMessage'
import { IconButton } from '@/components/ui'
import type { ChildHistoryState } from '@/hooks/useChildHistory'
import { useI18n } from '@/lib/i18n'
import type { ChildSession } from '@/types/subagents'

export default function ChildHistoryPane({ child, state, onClose, onLoadEarlier, onRefresh, onLatest }: {
  child: ChildSession
  state: ChildHistoryState
  onClose(): void
  onLoadEarlier(): void
  onLatest(): void
  onRefresh(): void
}) {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useEffect(() => {
    if (pinned.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [state.messages])
  return <aside className="child-history-pane" aria-label={t('children.history')}>
    <header><div><span>{t('children.history')}</span><h2>{child.title}</h2><p>{t(`sidebar.status.${child.status}`)} · {t('children.readOnly')}</p></div><IconButton label={t('children.close')} onClick={onClose}><X size={16} /></IconButton></header>
    <div className="child-history-scroll scroll-area" ref={scrollRef} onScroll={() => {
      const node = scrollRef.current
      if (node) pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
    }}>
      {!state.following ? <button type="button" className="button child-history-latest" disabled={state.loading} onClick={() => { pinned.current = true; onLatest() }}>{t('children.latest')}</button> : null}
      {state.olderCursor ? <button type="button" className="button child-history-earlier" disabled={state.loading} onClick={() => { pinned.current = false; onLoadEarlier() }}>{t('children.earlier')}</button> : null}
      {child.task ? <section className="child-history-task"><h3>{t('children.task')}</h3><p>{child.task}</p></section> : null}
      {state.error ? <div className="child-history-error" role="status"><p>{t('children.unavailable')}</p><p>{state.error}</p><button type="button" className="button" disabled={state.loading} onClick={onRefresh}>{t('children.retry')}</button></div> : null}
      {state.loading && !state.messages.length ? <p className="child-history-loading" role="status"><LoaderCircle className="spin" size={15} />{t('children.loading')}</p> : null}
      {!state.loading && !state.error && !state.messages.length ? <p className="child-history-empty">{t('children.empty')}</p> : null}
      {state.messages.map((message) => <ChildHistoryMessage key={message.id} message={message} />)}
      {state.truncated ? <p className="child-history-empty">{t('children.historyLimited')}</p> : null}
    </div>
  </aside>
}
