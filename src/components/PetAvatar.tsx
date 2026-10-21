import { cachedPetSprite } from '@/lib/pet-sprite-cache'
import { useEffect, useState, type CSSProperties } from 'react'
import type { PetDefinition, PrimeWorkApi } from '@/types/api'

export type PetActivity = 'idle' | 'running-left' | 'running-right' | 'speaking' | 'working' | 'waiting' | 'jumping' | 'failed'

const ANIMATIONS: Record<PetActivity, { row: number; frameDurations: readonly number[] }> = {
  idle: { row: 0, frameDurations: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, frameDurations: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, frameDurations: [120, 120, 120, 120, 120, 120, 120, 220] },
  speaking: { row: 3, frameDurations: [140, 140, 140, 280] },
  jumping: { row: 4, frameDurations: [140, 140, 140, 140, 280] },
  failed: { row: 5, frameDurations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frameDurations: [150, 150, 150, 150, 150, 260] },
  working: { row: 8, frameDurations: [150, 150, 150, 150, 150, 280] },
}

function SpritesheetPet({ dataUrl, activity, size, reduceMotion }: { dataUrl: string; activity: PetActivity; size: number; reduceMotion: boolean }) {
  const animation = ANIMATIONS[activity]
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    setFrame(0)
    if (reduceMotion || animation.frameDurations.length <= 1) return
    let frameIndex = 0
    let timer = 0
    const scheduleNextFrame = () => {
      timer = window.setTimeout(() => {
        frameIndex = (frameIndex + 1) % animation.frameDurations.length
        setFrame(frameIndex)
        scheduleNextFrame()
      }, animation.frameDurations[frameIndex])
    }
    scheduleNextFrame()
    return () => window.clearTimeout(timer)
  }, [activity, animation, reduceMotion])
  const height = Math.round(size * 208 / 192)
  return (
    <span className="pet-sprite" style={{ width: size, height } as CSSProperties} aria-hidden="true">
      <img
        src={dataUrl}
        alt=""
        draggable={false}
        style={{
          width: size * 8,
          height: height * 9,
          transform: `translate(${-frame * size}px, ${-animation.row * height}px)`,
        }}
      />
    </span>
  )
}

function OrbPet({ activity, size, reduceMotion }: { activity: PetActivity; size: number; reduceMotion: boolean }) {
  return (
    <span className={`pet-orb pet-orb--${activity}${reduceMotion ? ' is-reduced-motion' : ''}`} style={{ width: size, height: size }} aria-hidden="true">
      <i /><i /><i />
    </span>
  )
}

export function PetAvatar({ pet, pets, activity = 'idle', size = 92, reduceMotion = false }: {
  pet: PetDefinition
  pets: PrimeWorkApi['pets'] | null
  activity?: PetActivity
  size?: number
  reduceMotion?: boolean
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setDataUrl(null)
    if (pet.kind !== 'spritesheet' || !pets) return () => { active = false }
    void cachedPetSprite(pets, pet.id).then((value) => { if (active) setDataUrl(value) }).catch(() => { if (active) setDataUrl(null) })
    return () => { active = false }
  }, [pet.id, pet.kind, pets])
  if (pet.kind === 'orb') return <OrbPet activity={activity} size={size} reduceMotion={reduceMotion} />
  if (dataUrl) return <SpritesheetPet dataUrl={dataUrl} activity={activity} size={size} reduceMotion={reduceMotion} />
  return <span className="pet-placeholder" style={{ width: size, height: Math.round(size * 208 / 192) }} aria-hidden="true" />
}
