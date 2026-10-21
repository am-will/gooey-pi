import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptMessage } from '@/types/api'
import { useI18n } from '@/lib/i18n'
import { newestWindow } from '@/lib/render-bounds'

/** `shortName` names the active harness in screen-reader announcements ("OMP is working."). */
export function useTranscriptScroll(messages: TranscriptMessage[], shortName: string) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousCountRef = useRef(0)
  const previousStreamingRef = useRef(false)
  const pinnedToBottomRef = useRef(true)
  const [visibleLimit, setVisibleLimit] = useState(250)
  const [announcement, setAnnouncement] = useState('')
  const streaming = messages.some((message) => message.streaming)
  const visibleMessages = useMemo(() => newestWindow(messages, visibleLimit), [messages, visibleLimit])
  const hiddenCount = messages.length - visibleMessages.length

  useEffect(() => {
    const firstLoadedTranscript = previousCountRef.current === 0 && messages.length > 0
    const scroller = scrollRef.current
    let frame: number | undefined
    if (firstLoadedTranscript) {
      frame = requestAnimationFrame(() => scroller && typeof scroller.scrollTo === 'function' && scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
      pinnedToBottomRef.current = true
    } else if (streaming && pinnedToBottomRef.current) {
      frame = requestAnimationFrame(() => scroller && typeof scroller.scrollTo === 'function' && scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }))
    }
    if (previousStreamingRef.current && !streaming) setAnnouncement(`${shortName} response complete.`)
    else if (!previousStreamingRef.current && streaming) setAnnouncement(`${shortName} is working.`)
    previousStreamingRef.current = streaming
    previousCountRef.current = messages.length
    return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [messages, streaming, shortName])

  const updatePinnedState = () => {
    const scroller = scrollRef.current
    if (scroller) pinnedToBottomRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120
  }

  const showEarlier = () => setVisibleLimit((limit) => Math.min(messages.length, limit + 250))

  return { announcement, hiddenCount, scrollRef, showEarlier, updatePinnedState, visibleMessages }
}
