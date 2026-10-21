import { useCallback, useEffect, useState } from 'react'

export const TOAST_DURATION_MS = 2_500

export function useToast() {
  const [notification, setNotification] = useState<{ message: string } | null>(null)
  const setToast = useCallback((message: string | null) => setNotification(message === null ? null : { message }), [])

  useEffect(() => {
    if (!notification) return
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [notification])

  return { toast: notification?.message ?? null, setToast }
}
