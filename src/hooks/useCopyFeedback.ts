import { useCallback, useEffect, useRef, useState } from 'react'
import { writeClipboardText } from '@/lib/clipboard'

export interface CopyFeedback {
  /** True for `resetMs` after the most recent successful copy. */
  copied: boolean
  /** Copy `text`; a clipboard rejection clears `copied` instead of throwing. */
  copy(text: string): Promise<void>
}

/**
 * Clipboard copy with a transient "copied" flag for button feedback. Each
 * success restarts the reset timer, and the pending timer is cleared on
 * unmount. A copy that settles after unmount leaves state untouched.
 */
export function useCopyFeedback(resetMs = 1_500): CopyFeedback {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  const copy = useCallback(async (text: string) => {
    let succeeded = true
    try {
      await writeClipboardText(text)
    } catch {
      succeeded = false
    }
    if (!mountedRef.current) return
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    setCopied(succeeded)
    if (succeeded) {
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null
        setCopied(false)
      }, resetMs)
    }
  }, [resetMs])

  return { copied, copy }
}
