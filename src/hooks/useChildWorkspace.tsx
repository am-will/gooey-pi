import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { ChildRosterView } from '@/components/ChildSessionRows'
import { useChildHistory } from '@/hooks/useChildHistory'
import { errorMessage } from '@/lib/errors'
import { useI18n } from '@/lib/i18n'
import type { HarnessId, PrimeWorkApi, SessionRecord } from '@/types/api'
import type { ChildRoster, ChildSession } from '@/types/subagents'

const ChildHistoryPane = lazy(() => import('@/components/ChildHistoryPane'))
type RosterState = { parentFile: string; result: ChildRoster } | { parentFile: string; error: string }
function LoadingChildPane() {
  const { t } = useI18n()
  return <aside className="child-history-pane child-history-loading" aria-label={t('children.history')} role="status"><LoaderCircle className="spin" size={16} />{t('children.loading')}</aside>
}

/** Child inspection owns its reads and selection; the parent workspace is never activated or replaced. */
export function useChildWorkspace({ bridge, parent, harness, visible, compact, setSidebarOpen }: {
  bridge: PrimeWorkApi | null
  parent?: SessionRecord
  harness: HarnessId
  visible: boolean
  compact: boolean
  setSidebarOpen(open: boolean): void
}) {
  const api = bridge?.subagents
  const parentFile = visible ? parent?.filePath : undefined
  const [rosterState, setRosterState] = useState<RosterState>()
  const [selection, setSelection] = useState<{ parentFile: string; child: ChildSession }>()
  const [revision, setRevision] = useState(0)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!parentFile || harness !== 'omp' || !api) return
    let alive = true
    let pending = false
    const refresh = async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const result = await api.list(parentFile, 'omp')
        if (alive) setRosterState({ parentFile, result })
      } catch (error) {
        if (alive) setRosterState({ parentFile, error: errorMessage(error) })
      } finally { pending = false }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3_000)
    const onVisible = () => { if (document.visibilityState !== 'hidden') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [api, harness, parentFile, revision])
  const open = useCallback((child: ChildSession, trigger: HTMLButtonElement) => {
    if (!parentFile || harness !== 'omp') return
    triggerRef.current = trigger
    setSelection({ parentFile, child })
    if (compact) setSidebarOpen(false)
  }, [compact, harness, parentFile, setSidebarOpen])
  const close = useCallback(() => {
    setSelection(undefined)
    if (triggerRef.current?.isConnected) triggerRef.current.focus()
  }, [])
  const selected = harness === 'omp' && selection?.parentFile === parentFile ? selection : undefined
  const currentRoster = rosterState?.parentFile === parentFile ? rosterState : undefined
  const result = currentRoster && 'result' in currentRoster ? currentRoster.result : undefined
  const child = selected && (result?.supported ? result.children.find((item) => item.id === selected.child.id) : undefined) || selected?.child
  const history = useChildHistory(api, child ? parentFile : undefined, child?.id)
  const retry = useCallback(() => setRevision((value) => value + 1), [])
  const roster = useMemo<ChildRosterView | undefined>(() => {
    if (!parentFile) return
    if (harness !== 'omp' || !api) return { kind: 'unavailable', parentFile }
    if (currentRoster && 'error' in currentRoster) return { kind: 'error', parentFile, message: currentRoster.error, retry }
    if (!result) return { kind: 'loading', parentFile }
    if (!result.supported) return { kind: 'unavailable', parentFile, reason: result.reason }
    return { kind: 'ready', parentFile, children: result.children, truncated: result.truncated, selectedId: child?.id, onSelect: open }
  }, [api, child?.id, currentRoster, harness, open, parentFile, result, retry])
  return {
    roster,
    isOpen: Boolean(child),
    pane: child ? <Suspense fallback={<LoadingChildPane />}><ChildHistoryPane key={`${parentFile}\0${child.id}`} child={child} state={history.state} onClose={close} onLoadEarlier={history.loadEarlier} onRefresh={history.refresh} onLatest={history.latest} /></Suspense> : null,
  }
}
