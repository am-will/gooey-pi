import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/errors'
import type { PrimeWorkApi, TranscriptMessage } from '@/types/api'
import type { ChildHistoryPage } from '@/types/subagents'

export interface ChildHistoryState {
  messages: TranscriptMessage[]
  olderCursor?: string
  newerCursor?: string
  truncated: boolean
  following: boolean
  loading: boolean
  error?: string
}
const emptyHistory = (): ChildHistoryState => ({ messages: [], loading: true, truncated: false, following: true })

function mergeMessages(older: TranscriptMessage[], newer: TranscriptMessage[]): TranscriptMessage[] {
  const messages = new Map(older.map((message) => [message.id, message]))
  for (const message of newer) messages.set(message.id, message)
  return [...messages.values()]
}

/** Only the selected child owns a history request; closing or switching retires every pending result. */
export function useChildHistory(api: PrimeWorkApi['subagents'] | undefined, parentFile: string | undefined, childId: string | undefined) {
  const owner = parentFile && childId ? `${parentFile}\0${childId}` : undefined
  const [snapshot, setSnapshot] = useState<{ owner?: string; value: ChildHistoryState }>({ value: emptyHistory() })
  const loadEarlierRef = useRef<() => void>(() => undefined)
  const latestRef = useRef<() => void>(() => undefined)
  const refreshRef = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (!owner || !api || !parentFile || !childId) return
    let alive = true
    let pending = false
    let current = emptyHistory()
    const publish = () => { if (alive) setSnapshot({ owner, value: { ...current } }) }
    const applyPage = (page: ChildHistoryPage, older: boolean) => {
      const initial = current.newerCursor === undefined
      const messages = page.reset || initial ? page.messages : older ? mergeMessages(page.messages, current.messages) : mergeMessages(current.messages, page.messages)
      const limit = 1_000
      const cropped = messages.length > limit
      current = {
        messages: older ? messages.slice(0, limit) : messages.slice(-limit),
        following: !older,
        olderCursor: page.reset || initial || older || cropped ? page.olderCursor : current.olderCursor,
        newerCursor: older && !page.reset && !initial ? current.newerCursor : page.newerCursor,
        truncated: cropped || page.truncated || (!page.reset && current.truncated),
        loading: false,
      }
    }
    const load = async (older = false) => {
      if (!alive || pending || document.visibilityState === 'hidden') return
      if (older && !current.olderCursor) return
      pending = true
      current = { ...current, loading: true, error: undefined }
      publish()
      try {
        const cursor = older ? current.olderCursor : current.newerCursor
        const page = await api.history(parentFile, childId, cursor ? { cursor, direction: older ? 'older' : 'newer' } : undefined, 'omp')
        if (!alive) return
        applyPage(page, older)
      } catch (error) {
        if (alive) current = { ...current, loading: false, error: errorMessage(error) }
      } finally {
        pending = false
        publish()
      }
    }
    loadEarlierRef.current = () => { void load(true) }
    refreshRef.current = () => { void load() }
    latestRef.current = () => {
      if (pending) return
      current = emptyHistory()
      publish()
      void load()
    }
    void load()
    const timer = window.setInterval(() => { if (current.following) void load() }, 1_500)
    const onVisible = () => { if (current.following && document.visibilityState !== 'hidden') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      loadEarlierRef.current = () => undefined
      refreshRef.current = () => undefined
      latestRef.current = () => undefined
    }
  }, [api, owner, parentFile, childId])
  return {
    state: snapshot.owner === owner ? snapshot.value : emptyHistory(),
    loadEarlier: useCallback(() => loadEarlierRef.current(), []),
    refresh: useCallback(() => refreshRef.current(), []),
    latest: useCallback(() => latestRef.current(), []),
  }
}
