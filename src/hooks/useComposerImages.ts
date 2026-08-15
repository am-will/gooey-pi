import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { PromptImage } from '@/types/api'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const COMPOSER_IMAGE_ACCEPT = [...supportedImageTypes].join(',')
export const MAX_COMPOSER_IMAGE_COUNT = 8
export const MAX_COMPOSER_IMAGE_SOURCE_BYTES = 1_350_000

export interface ComposerImage extends PromptImage {
  id: string
  name: string
  size: number
}

interface UseComposerImagesOptions {
  imageInputSupported: boolean
  shortName: string
}

function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return window.btoa(binary)
}

function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

export function useComposerImages({ imageInputSupported, shortName }: UseComposerImagesOptions) {
  const [images, setImages] = useState<ComposerImage[]>([])
  const [error, setError] = useState('')
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imagesRef = useRef<ComposerImage[]>([])
  const pendingBatchesRef = useRef(0)
  const errorRevisionRef = useRef(0)
  const reservedCountRef = useRef(0)
  const reservedBytesRef = useRef(0)
  const dragDepthRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateError = useCallback((message: string) => {
    errorRevisionRef.current += 1
    setError(message)
  }, [])

  const ingest = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    const startingErrorRevision = errorRevisionRef.current
    if (!imageInputSupported) {
      updateError('This model does not accept images. Choose a vision model before attaching an image.')
      return
    }
    if (files.some((file) => !supportedImageTypes.has(file.type.toLowerCase()))) {
      updateError(`${shortName} supports PNG, JPEG, GIF, and WebP images.`)
      return
    }

    const sourceBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (imagesRef.current.length + reservedCountRef.current + files.length > MAX_COMPOSER_IMAGE_COUNT) {
      updateError(`You can attach up to ${MAX_COMPOSER_IMAGE_COUNT} images.`)
      return
    }
    const currentBytes = imagesRef.current.reduce((sum, image) => sum + image.size, 0)
    if (currentBytes + reservedBytesRef.current + sourceBytes > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
      updateError('These images are too large to send. Attach smaller images (about 1.3 MB total).')
      return
    }

    reservedCountRef.current += files.length
    reservedBytesRef.current += sourceBytes
    pendingBatchesRef.current += 1
    setProcessing(true)
    try {
      const added = await Promise.all(files.map(async (file, index): Promise<ComposerImage> => ({
        id: crypto.randomUUID(),
        name: file.name || `Attached image ${index + 1}`,
        size: file.size,
        type: 'image',
        mimeType: file.type.toLowerCase(),
        data: base64FromBuffer(await file.arrayBuffer()),
      })))
      if (!mountedRef.current) return
      const next = [...imagesRef.current, ...added]
      imagesRef.current = next
      setImages(next)
      if (errorRevisionRef.current === startingErrorRevision) setError('')
    } catch {
      if (mountedRef.current) updateError(`${shortName} could not read the image.`)
    } finally {
      reservedCountRef.current -= files.length
      reservedBytesRef.current -= sourceBytes
      pendingBatchesRef.current -= 1
      if (mountedRef.current && pendingBatchesRef.current === 0) setProcessing(false)
    }
  }, [imageInputSupported, shortName, updateError])

  const clear = useCallback(() => {
    imagesRef.current = []
    setImages([])
  }, [])

  const remove = useCallback((id: string) => {
    const next = imagesRef.current.filter((image) => image.id !== id)
    imagesRef.current = next
    setImages(next)
    updateError('')
  }, [updateError])

  const restoreWithinLimits = useCallback((restored: ComposerImage[]) => {
    const current = imagesRef.current
    const currentIds = new Set(current.map((image) => image.id))
    let count = current.length + reservedCountRef.current
    let bytes = current.reduce((sum, image) => sum + image.size, 0) + reservedBytesRef.current
    const accepted: ComposerImage[] = []
    let omitted = 0
    for (const image of restored) {
      if (currentIds.has(image.id)) continue
      if (count >= MAX_COMPOSER_IMAGE_COUNT || bytes + image.size > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
        omitted += 1
        continue
      }
      accepted.push(image)
      currentIds.add(image.id)
      count += 1
      bytes += image.size
    }
    if (accepted.length > 0) {
      const next = [...accepted, ...current]
      imagesRef.current = next
      setImages(next)
    }
    return { restored: accepted.length, omitted }
  }, [])

  const onDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragging(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (dragDepthRef.current === 0) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    void ingest(Array.from(event.dataTransfer.files))
  }, [ingest])

  return {
    images,
    imagesRef,
    error,
    setError: updateError,
    processing,
    hasPending: () => pendingBatchesRef.current > 0,
    dragging,
    ingest,
    clear,
    remove,
    restoreWithinLimits,
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
