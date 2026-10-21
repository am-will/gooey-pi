import { AudioWaveform, Mic, MicOff, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PetDefinition, PrimeWorkApi } from '@/types/api'
import { BUILT_IN_PETS, petDisplayName } from '@/lib/built-in-pets'
import { useI18n } from '@/lib/i18n'
import { PetAvatar, type PetActivity } from './PetAvatar'

interface Position { x: number; y: number }
interface DragState { pointerId: number; dx: number; dy: number; lastX: number; lastY: number; moved: boolean }

function initialPosition(): Position {
  const fallback = { x: Math.max(16, window.innerWidth - 150), y: Math.max(70, window.innerHeight - 180) }
  try {
    const saved = JSON.parse(window.localStorage.getItem('gooeypi:pet-position') ?? '') as Partial<Position>
    return typeof saved.x === 'number' && typeof saved.y === 'number' ? { x: saved.x, y: saved.y } : fallback
  } catch { return fallback }
}

function constrained(position: Position, surfaceHeight: number, surfaceWidth: number): Position {
  return {
    x: Math.max(8, Math.min(window.innerWidth - surfaceWidth - 4, position.x)),
    y: Math.max(54, Math.min(window.innerHeight - surfaceHeight - 8, position.y)),
  }
}

export interface DesktopPetProps {
  pets: PrimeWorkApi['pets']
  petId: string
  agentBusy: boolean
  voiceActive: boolean
  reduceMotion: boolean
  petSize?: number
  voiceActivity?: PetActivity
  voiceMuted?: boolean
  voiceStatus?: string
  voiceError?: string
  onOpenVoice?(): void
  onToggleVoiceMute?(): void
  onCloseVoice?(): void
  onDismiss?(): void
  focusVoiceControl?: boolean
  onVoiceControlFocused?(): void
  children?: ReactNode
}

export function DesktopPet({ pets, petId, agentBusy, voiceActive, reduceMotion, petSize = 75, voiceActivity, voiceMuted = false, voiceStatus, voiceError, onOpenVoice, onToggleVoiceMute, onCloseVoice, onDismiss, focusVoiceControl = false, onVoiceControlFocused, children }: DesktopPetProps) {
  const { t } = useI18n()
  const normalizedPetSize = Math.max(50, Math.min(125, Math.round(petSize)))
  const avatarSize = Math.round(96 * normalizedPetSize / 100)
  const surfaceWidth = Math.max(112, avatarSize + 24)
  const initialSurfaceHeight = avatarSize + 34
  const [available, setAvailable] = useState<PetDefinition[]>(BUILT_IN_PETS)
  const [position, setPosition] = useState(() => constrained(initialPosition(), initialSurfaceHeight, surfaceWidth))
  const [surfaceHeight, setSurfaceHeight] = useState(initialSurfaceHeight)
  const [dragging, setDragging] = useState(false)
  const [direction, setDirection] = useState<'left' | 'right'>('right')
  const [jumping, setJumping] = useState(false)
  const [dismissArmed, setDismissArmed] = useState(false)
  const dragRef = useRef<DragState | null>(null)
  const positionRef = useRef(position)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const voiceControlRef = useRef<HTMLButtonElement>(null)
  const dismissTargetRef = useRef<HTMLSpanElement>(null)
  const metricsRef = useRef({ width: surfaceWidth, idleHeight: initialSurfaceHeight })
  const hasVoiceDetails = Boolean(voiceError || children)

  useEffect(() => {
    let active = true
    void pets.list().then((items) => { if (active && items.length) setAvailable(items) }).catch(() => undefined)
    return () => { active = false }
  }, [pets])
  useEffect(() => { positionRef.current = position }, [position])
  useEffect(() => {
    const onResize = () => setPosition((current) => constrained(current, surfaceHeight, surfaceWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [surfaceHeight, surfaceWidth])
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const updateBounds = () => {
      const measured = Math.ceil(surface.getBoundingClientRect().height)
      const nextHeight = Math.max(initialSurfaceHeight, measured || (voiceActive ? 320 : initialSurfaceHeight))
      const previous = metricsRef.current
      const sizeChanged = previous.width !== surfaceWidth || previous.idleHeight !== initialSurfaceHeight
      setSurfaceHeight((current) => current === nextHeight ? current : nextHeight)
      setPosition((current) => {
        const anchored = sizeChanged ? {
          x: current.x + (previous.width - surfaceWidth) / 2,
          y: current.y + previous.idleHeight - initialSurfaceHeight,
        } : current
        const next = constrained(anchored, nextHeight, surfaceWidth)
        return next.x === current.x && next.y === current.y ? current : next
      })
      metricsRef.current = { width: surfaceWidth, idleHeight: initialSurfaceHeight }
    }
    updateBounds()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateBounds)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [voiceActive, hasVoiceDetails, initialSurfaceHeight, surfaceWidth])
  useEffect(() => {
    if (!focusVoiceControl || !voiceControlRef.current) return
    voiceControlRef.current.focus()
    onVoiceControlFocused?.()
  }, [focusVoiceControl, onVoiceControlFocused, voiceActive])
  useEffect(() => {
    if (!jumping) return
    const timer = window.setTimeout(() => setJumping(false), reduceMotion ? 80 : 700)
    return () => window.clearTimeout(timer)
  }, [jumping, reduceMotion])

  const pet = useMemo(() => available.find((item) => item.id === petId) ?? available.find((item) => item.id === 'orb') ?? BUILT_IN_PETS[0], [available, petId])
  const activity: PetActivity = dragging
    ? direction === 'left' ? 'running-left' : 'running-right'
    : jumping ? 'jumping'
      : voiceActive ? voiceActivity ?? 'speaking'
        : agentBusy ? 'working' : 'idle'

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y, lastX: event.clientX, lastY: event.clientY, moved: false }
    setDismissArmed(false)
    setDragging(true)
  }
  const isOverDismissTarget = (clientX: number, clientY: number) => {
    const bounds = dismissTargetRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width === 0 || bounds.height === 0) return false
    const radius = Math.min(bounds.width, bounds.height) / 2 + 12
    const dx = clientX - (bounds.left + bounds.width / 2)
    const dy = clientY - (bounds.top + bounds.height / 2)
    return dx * dx + dy * dy <= radius * radius
  }
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const deltaX = event.clientX - drag.lastX
    const deltaY = event.clientY - drag.lastY
    if (Math.abs(deltaX) > 1) setDirection(deltaX < 0 ? 'left' : 'right')
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    drag.moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 2
    setDismissArmed(isOverDismissTarget(event.clientX, event.clientY))
    const next = constrained({ x: event.clientX - drag.dx, y: event.clientY - drag.dy }, surfaceHeight, surfaceWidth)
    positionRef.current = next
    setPosition(next)
  }
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragging(false)
    const shouldDismiss = !cancelled && onDismiss && isOverDismissTarget(event.clientX, event.clientY)
    setDismissArmed(false)
    if (shouldDismiss) {
      onDismiss()
      return
    }
    window.localStorage.setItem('gooeypi:pet-position', JSON.stringify(positionRef.current))
    if (!drag.moved) setJumping(true)
  }
  const moveByKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const movement = event.shiftKey ? 24 : 8
    const delta = event.key === 'ArrowLeft' ? { x: -movement, y: 0 }
      : event.key === 'ArrowRight' ? { x: movement, y: 0 }
        : event.key === 'ArrowUp' ? { x: 0, y: -movement }
          : event.key === 'ArrowDown' ? { x: 0, y: movement } : null
    if (delta) {
      event.preventDefault()
      setDirection(delta.x < 0 ? 'left' : delta.x > 0 ? 'right' : direction)
      setPosition((current) => {
        const next = constrained({ x: current.x + delta.x, y: current.y + delta.y }, surfaceHeight, surfaceWidth)
        positionRef.current = next
        window.localStorage.setItem('gooeypi:pet-position', JSON.stringify(next))
        return next
      })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setJumping(true)
    } else if (onDismiss && (event.key === 'Delete' || event.key === 'Backspace')) {
      event.preventDefault()
      onDismiss()
    }
  }

  return (
    <div
      ref={surfaceRef}
      className={`desktop-pet desktop-pet--${activity}${voiceActive ? ' is-voice-active' : ''}${dismissArmed ? ' is-dismiss-armed' : ''}`}
      style={{ left: position.x, top: position.y, '--pet-avatar-size': `${avatarSize}px`, '--pet-surface-width': `${surfaceWidth}px`, '--pet-surface-min-height': `${initialSurfaceHeight - 8}px` } as React.CSSProperties}
      role={voiceActive ? 'complementary' : undefined}
      aria-label={voiceActive ? t('voice.session.aria') : undefined}
      data-horizontal-edge={position.x > window.innerWidth / 2 ? 'right' : 'left'}
    >
      <div
        className="desktop-pet__drag-target"
        role="button"
        tabIndex={0}
        aria-label={t('pets.dragLabel', { name: petDisplayName(pet, t) })}
        aria-keyshortcuts={onDismiss ? 'Delete Backspace' : undefined}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={(event) => finishDrag(event, true)}
        onKeyDown={moveByKeyboard}
      >
        <span className="desktop-pet__avatar">
          <PetAvatar pet={pet} pets={pets} activity={activity} size={avatarSize} reduceMotion={reduceMotion} />
        </span>
      </div>
      {voiceActive && voiceStatus ? <span className="desktop-pet__voice-status" role="status">{voiceStatus}</span> : null}
      <div className="desktop-pet__voice-controls" aria-label={t('voice.controls.aria')}>
        {!voiceActive && onOpenVoice ? <button ref={voiceControlRef} type="button" className="desktop-pet__voice-open" aria-label={t('voice.open')} title={t('voice.open')} onClick={onOpenVoice}><AudioWaveform size={15} /></button> : null}
        {voiceActive && onToggleVoiceMute ? <button ref={voiceControlRef} type="button" aria-label={voiceMuted ? t('voice.unmute') : t('voice.mute')} title={voiceMuted ? t('voice.unmute') : t('voice.mute')} onClick={onToggleVoiceMute}>{voiceMuted ? <MicOff size={15} /> : <Mic size={15} />}</button> : null}
        {voiceActive && onCloseVoice ? <button type="button" aria-label={t('voice.close')} title={t('voice.close')} onClick={onCloseVoice}><X size={16} /></button> : null}
      </div>
      {voiceError ? <p className="desktop-pet__voice-error" role="alert">{voiceError}</p> : null}
      {children}
      {onDismiss ? createPortal(
        <div
          className={`pet-dismiss-drawer${dragging ? ' is-visible' : ''}${dismissArmed ? ' is-armed' : ''}`}
          role={dragging ? 'status' : undefined}
          aria-hidden={dragging ? undefined : true}
          aria-label={dragging ? (dismissArmed ? t('pets.dismiss.release') : t('pets.dismiss.drag')) : undefined}
        >
          <span ref={dismissTargetRef} className="pet-dismiss-drawer__hitbox" aria-hidden="true" />
          <span className="pet-dismiss-drawer__visual">
            <span className="pet-dismiss-drawer__target"><X size={28} strokeWidth={2.7} /></span>
          </span>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
