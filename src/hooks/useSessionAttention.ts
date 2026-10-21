import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { activityClearEntry, companionClearEntry, readClearedActivity, readClearedAttention, writeClearedSignatures, CLEARED_ATTENTION_STORAGE_KEY, CLEARED_ACTIVITY_STORAGE_KEY } from '@/app/session-attention'
import type { SessionRecord } from '@/types/api'

export function useSessionAttention({ setSessions }: { setSessions: Dispatch<SetStateAction<SessionRecord[]>> }) {
  const [clearedAttention, setClearedAttention] = useState<Record<string, string>>(readClearedAttention)
  const [clearedActivity, setClearedActivity] = useState<Record<string, string>>(readClearedActivity)
  useEffect(() => { writeClearedSignatures(CLEARED_ATTENTION_STORAGE_KEY, clearedAttention) }, [clearedAttention])
  useEffect(() => { writeClearedSignatures(CLEARED_ACTIVITY_STORAGE_KEY, clearedActivity) }, [clearedActivity])
  const clearSessionAttention = useCallback((session: SessionRecord) => {
    const signature = companionClearEntry(session)
    if (!signature) return
    setClearedAttention((current) => current[session.id] === signature ? current : { ...current, [session.id]: signature })
  }, [])
  const clearActivity = useCallback((sessions: SessionRecord[]) => {
    if (!sessions.length) return
    const ids = new Set(sessions.map((session) => session.id))
    setClearedActivity((current) => {
      const next = { ...current }
      for (const session of sessions) {
        const signature = activityClearEntry(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setClearedAttention((current) => {
      const next = { ...current }
      for (const session of sessions) {
        const signature = companionClearEntry(session)
        if (signature) next[session.id] = signature
      }
      return next
    })
    setSessions((current) => current.map((session) => ids.has(session.id) ? { ...session, unread: false } : session))
  }, [setSessions])
  return { clearedAttention, clearedActivity, clearSessionAttention, clearActivity }
}
