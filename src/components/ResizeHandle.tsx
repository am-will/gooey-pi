import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useI18n } from '@/lib/i18n'

type Orientation = 'vertical' | 'horizontal'

interface ResizeHandleProps {
  orientation: Orientation
  label: string
  value: number
  min: number
  max: number
  defaultValue: number
  onChange(value: number): void
}

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(Math.max(min, max), Math.max(min, value)))

export function ResizeHandle({ orientation, label, value, min, max, defaultValue, onChange }: ResizeHandleProps) {
  const { t } = useI18n()
  const cleanupRef = useRef<(() => void) | null>(null)
  const safeMax = Math.max(min, max)
  const readCoordinate = (event: Pick<PointerEvent, 'clientX' | 'clientY'>) => orientation === 'vertical' ? event.clientX : event.clientY

  useEffect(() => () => cleanupRef.current?.(), [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 12
    let next: number | undefined
    if (event.key === 'Home') next = min
    if (event.key === 'End') next = safeMax
    if (orientation === 'vertical' && event.key === 'ArrowLeft') next = value + step
    if (orientation === 'vertical' && event.key === 'ArrowRight') next = value - step
    if (orientation === 'horizontal' && event.key === 'ArrowUp') next = value + step
    if (orientation === 'horizontal' && event.key === 'ArrowDown') next = value - step
    if (next === undefined) return
    event.preventDefault()
    onChange(clamp(next, min, safeMax))
  }

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanupRef.current?.()
    const target = event.currentTarget
    const pointerId = event.pointerId
    const startCoordinate = readCoordinate(event.nativeEvent)
    const startValue = value
    const workspace = target.closest<HTMLElement>('.session-workspace')
    const cssVariable = orientation === 'vertical' ? '--inspector-width' : '--terminal-height'
    let latestValue = startValue
    target.dataset.resizing = 'true'
    document.body.classList.add(`is-resizing-${orientation}`)
    target.setPointerCapture(pointerId)

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      moveEvent.preventDefault()
      latestValue = clamp(startValue - (readCoordinate(moveEvent) - startCoordinate), min, safeMax)
      workspace?.style.setProperty(cssVariable, `${latestValue}px`)
    }
    const finish = (finishEvent?: PointerEvent, commit = true) => {
      if (finishEvent && finishEvent.pointerId !== pointerId) return
      delete target.dataset.resizing
      document.body.classList.remove('is-resizing-vertical', 'is-resizing-horizontal')
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', cancel)
      cleanupRef.current = null
      if (commit && latestValue !== startValue) onChange(latestValue)
      else if (!commit) workspace?.style.setProperty(cssVariable, `${startValue}px`)
    }
    const cancel = (cancelEvent: PointerEvent) => finish(cancelEvent, false)
    cleanupRef.current = () => finish(undefined, false)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', cancel)
  }

  return (
    <div
      className={`resize-handle resize-handle--${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={safeMax}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      title={t('resizeHandle.title', { label })}
      onDoubleClick={() => onChange(clamp(defaultValue, min, safeMax))}
      onKeyDown={handleKeyDown}
      onPointerDown={beginDrag}
    ><span aria-hidden="true" /></div>
  )
}
