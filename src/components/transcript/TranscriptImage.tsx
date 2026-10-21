import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { useAppShellOverlay, useFocusTrap } from '../ui'

interface TranscriptImageProps {
  source: string
  alt: string
}

export function TranscriptImage({ source, alt }: TranscriptImageProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const lightboxRef = useFocusTrap<HTMLElement>(open, () => setOpen(false))
  useAppShellOverlay(open)

  return <>
    <button type="button" className="image-part__preview" aria-label={t('transcript.expandImage')} onClick={() => setOpen(true)}>
      <img className="image-part" src={source} alt={alt} />
    </button>
    {open ? createPortal(
      <div className="image-lightbox" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false)
      }}>
        <section ref={lightboxRef} className="image-lightbox__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <h2 id={titleId} className="sr-only">{t('transcript.expandedImage')}</h2>
          <button type="button" className="image-lightbox__close" aria-label={t('transcript.closeExpandedImage')} onClick={() => setOpen(false)}>
            <X size={18} />
          </button>
          <img className="image-lightbox__image" src={source} alt={alt} />
        </section>
      </div>,
      document.body,
    ) : null}
  </>
}
