import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

export const TOAST_DURATION_MS = 2_500

export function useToast() {
  const [notification, setNotification] = useState<{ message: string } | null>(null)
  const setToast = useCallback<Dispatch<SetStateAction<string | null>>>((next) => setNotification((previous) => {
    const message = typeof next === 'function' ? next(previous?.message ?? null) : next
    return message === null ? null : { message }
  }), [])

  useEffect(() => {
    if (!notification) return
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [notification])

  return { toast: notification?.message ?? null, setToast }
}
