import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { PromptImage } from '@/types/api'
import { decodeTextAttachment, isTextAttachmentFile, MAX_TEXT_ATTACHMENT_BYTES } from '@/lib/file-attachments'
import { useI18n } from '@/lib/i18n'

const supportedImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
export const MAX_COMPOSER_FILE_COUNT = 8
export const MAX_COMPOSER_IMAGE_SOURCE_BYTES = 1_350_000

export interface ComposerImage extends PromptImage {
  id: string
  name: string
  size: number
}

/** A text file read in full; it is sent inside the prompt rather than as an image part. */
export interface ComposerTextFile {
  id: string
  name: string
  size: number
  text: string
}

export interface ComposerUnsupportedFile {
  id: string
  name: string
  size: number
  mimeType: string
}

interface UseComposerImagesOptions {
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

export function useComposerImages({ shortName }: UseComposerImagesOptions) {
  const { t } = useI18n()
  const [images, setImages] = useState<ComposerImage[]>([])
  const [textFiles, setTextFiles] = useState<ComposerTextFile[]>([])
  const [unsupportedFiles, setUnsupportedFiles] = useState<ComposerUnsupportedFile[]>([])
  const [error, setError] = useState('')
  const [processing, setProcessing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const imagesRef = useRef<ComposerImage[]>([])
  const textFilesRef = useRef<ComposerTextFile[]>([])
  const unsupportedFilesRef = useRef<ComposerUnsupportedFile[]>([])
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

  const fileName = useCallback((file: File, index: number) => file.name || t('composer.attachment.unnamedFile', { index: index + 1 }), [t])

  const addUnsupported = useCallback((files: readonly File[]) => {
    const added = files.map((file, index): ComposerUnsupportedFile => ({
      id: crypto.randomUUID(),
      name: fileName(file, index),
      size: file.size,
      mimeType: file.type.toLowerCase() || 'application/octet-stream',
    }))
    const next = [...unsupportedFilesRef.current, ...added]
    unsupportedFilesRef.current = next
    setUnsupportedFiles(next)
  }, [fileName])

  const readTextFiles = useCallback(async (files: readonly File[], startingErrorRevision: number) => {
    const oversized = files.find((file) => file.size > MAX_TEXT_ATTACHMENT_BYTES)
    if (oversized) updateError(t('composer.error.textFileTooLarge', { name: fileName(oversized, files.indexOf(oversized)) }))
    const readable = files.filter((file) => file.size <= MAX_TEXT_ATTACHMENT_BYTES)
    if (readable.length === 0) return

    reservedCountRef.current += readable.length
    pendingBatchesRef.current += 1
    setProcessing(true)
    try {
      // `text` is null for bytes that are not UTF-8 text and undefined when the read itself failed.
      const results = await Promise.all(readable.map(async (file) => {
        try {
          return { file, text: decodeTextAttachment(await file.arrayBuffer()) }
        } catch {
          return { file, text: undefined }
        }
      }))
      if (!mountedRef.current) return
      const added = results.flatMap(({ file, text }, index): ComposerTextFile[] => typeof text === 'string'
        ? [{ id: crypto.randomUUID(), name: fileName(file, index), size: file.size, text }]
        : [])
      if (added.length > 0) {
        const next = [...textFilesRef.current, ...added]
        textFilesRef.current = next
        setTextFiles(next)
      }
      const binary = results.filter(({ text }) => text === null).map(({ file }) => file)
      if (binary.length > 0) addUnsupported(binary)
      const failed = results.findIndex(({ text }) => text === undefined)
      if (failed !== -1) updateError(t('composer.error.textFileRead', { name: fileName(results[failed].file, failed) }))
      else if (errorRevisionRef.current === startingErrorRevision) setError('')
    } finally {
      reservedCountRef.current -= readable.length
      pendingBatchesRef.current -= 1
      if (mountedRef.current && pendingBatchesRef.current === 0) setProcessing(false)
    }
  }, [addUnsupported, fileName, t, updateError])

  const readImages = useCallback(async (imageFiles: readonly File[], startingErrorRevision: number) => {
    if (imageFiles.length === 0) return

    const sourceBytes = imageFiles.reduce((sum, file) => sum + file.size, 0)
    const currentBytes = imagesRef.current.reduce((sum, image) => sum + image.size, 0)
    if (currentBytes + reservedBytesRef.current + sourceBytes > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
      updateError(t('composer.error.imagesTooLarge'))
      return
    }

    reservedCountRef.current += imageFiles.length
    reservedBytesRef.current += sourceBytes
    pendingBatchesRef.current += 1
    setProcessing(true)
    try {
      const added = await Promise.all(imageFiles.map(async (file, index): Promise<ComposerImage> => ({
        id: crypto.randomUUID(),
        name: file.name || t('composer.attachment.unnamedImage', { index: index + 1 }),
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
      if (mountedRef.current) updateError(t('composer.error.imageRead', { name: shortName }))
    } finally {
      reservedCountRef.current -= imageFiles.length
      reservedBytesRef.current -= sourceBytes
      pendingBatchesRef.current -= 1
      if (mountedRef.current && pendingBatchesRef.current === 0) setProcessing(false)
    }
  }, [shortName, t, updateError])

  const ingest = useCallback(async (files: readonly File[]) => {
    if (files.length === 0) return
    const startingErrorRevision = errorRevisionRef.current
    if (imagesRef.current.length + textFilesRef.current.length + unsupportedFilesRef.current.length + reservedCountRef.current + files.length > MAX_COMPOSER_FILE_COUNT) {
      updateError(t('composer.error.tooManyFiles', { count: MAX_COMPOSER_FILE_COUNT }))
      return
    }

    const isImage = (file: File) => supportedImageTypes.has(file.type.toLowerCase())
    const imageFiles = files.filter(isImage)
    const textFileCandidates = files.filter((file) => !isImage(file) && isTextAttachmentFile(file))
    const otherFiles = files.filter((file) => !isImage(file) && !isTextAttachmentFile(file))
    if (otherFiles.length > 0) {
      addUnsupported(otherFiles)
      setError('')
    }
    await Promise.all([readTextFiles(textFileCandidates, startingErrorRevision), readImages(imageFiles, startingErrorRevision)])
  }, [addUnsupported, readImages, readTextFiles, t, updateError])

  const clear = useCallback(() => {
    imagesRef.current = []
    textFilesRef.current = []
    unsupportedFilesRef.current = []
    setImages([])
    setTextFiles([])
    setUnsupportedFiles([])
  }, [])

  const remove = useCallback((id: string) => {
    const nextImages = imagesRef.current.filter((image) => image.id !== id)
    const nextTextFiles = textFilesRef.current.filter((file) => file.id !== id)
    const nextFiles = unsupportedFilesRef.current.filter((file) => file.id !== id)
    imagesRef.current = nextImages
    textFilesRef.current = nextTextFiles
    unsupportedFilesRef.current = nextFiles
    setImages(nextImages)
    setTextFiles(nextTextFiles)
    setUnsupportedFiles(nextFiles)
    updateError('')
  }, [updateError])

  const restoreWithinLimits = useCallback((restored: ComposerImage[], restoredTextFiles: readonly ComposerTextFile[] = []) => {
    const current = imagesRef.current
    const currentIds = new Set(current.map((image) => image.id))
    let count = current.length + textFilesRef.current.length + unsupportedFilesRef.current.length + reservedCountRef.current
    let bytes = current.reduce((sum, image) => sum + image.size, 0) + reservedBytesRef.current
    const accepted: ComposerImage[] = []
    let omitted = 0
    for (const image of restored) {
      if (currentIds.has(image.id)) continue
      if (count >= MAX_COMPOSER_FILE_COUNT || bytes + image.size > MAX_COMPOSER_IMAGE_SOURCE_BYTES) {
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
    const currentTextFileIds = new Set(textFilesRef.current.map((file) => file.id))
    const acceptedTextFiles: ComposerTextFile[] = []
    for (const file of restoredTextFiles) {
      if (currentTextFileIds.has(file.id)) continue
      if (count >= MAX_COMPOSER_FILE_COUNT) {
        omitted += 1
        continue
      }
      acceptedTextFiles.push(file)
      count += 1
    }
    if (acceptedTextFiles.length > 0) {
      const next = [...acceptedTextFiles, ...textFilesRef.current]
      textFilesRef.current = next
      setTextFiles(next)
    }
    return { restored: accepted.length + acceptedTextFiles.length, omitted }
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
    textFiles,
    textFilesRef,
    unsupportedFiles,
    unsupportedFilesRef,
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
