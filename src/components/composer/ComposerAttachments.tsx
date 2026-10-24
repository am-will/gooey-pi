import { ChevronDown, FileText, ImageIcon, MessageCirclePlus, Paperclip, SquareTerminal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useI18n } from '@/lib/i18n'
import type { BrowserAnnotation, TerminalSelectionContext } from '@/types/api'
import type { ComposerImage, ComposerTextFile, ComposerUnsupportedFile } from '@/hooks/useComposerImages'

interface Props {
  annotations: BrowserAnnotation[]
  terminalSelection?: TerminalSelectionContext
  images: ComposerImage[]
  textFiles: ComposerTextFile[]
  unsupportedFiles: ComposerUnsupportedFile[]
  onRemoveAnnotation(id: string): void
  onClearAnnotations(): void
  onClearTerminalSelection(): void
  onRemoveFile(id: string): void
}

export function ComposerAttachments({ annotations, terminalSelection, images, textFiles, unsupportedFiles, onRemoveAnnotation, onClearAnnotations, onClearTerminalSelection, onRemoveFile }: Props) {
  const { t } = useI18n()
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [terminalSelectionOpen, setTerminalSelectionOpen] = useState(false)
  useEffect(() => {
    if (annotations.length === 0) setAnnotationsOpen(false)
  }, [annotations.length])
  useEffect(() => {
    if (!terminalSelection?.text) setTerminalSelectionOpen(false)
  }, [terminalSelection?.text])
  return (
    <>
    {annotationsOpen && annotations.length ? (
      <div className="composer-annotations" role="region" aria-label={t('composer.annotations.region')}>
        {annotations.map((annotation, index) => {
          return (
            <div className="composer-annotation" key={annotation.id}>
              <span className="composer-annotation__badge" aria-hidden="true">
                {index + 1}
              </span>
              <div className="composer-annotation__body">
                <p>{annotation.comment}</p>
                {annotation.stale ? <small>{t('composer.annotations.stale')}</small> : null}
              </div>
              <button type="button" aria-label={t('composer.annotations.remove', { index: index + 1 })} onClick={() => onRemoveAnnotation(annotation.id)}>
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>
    ) : null}
    {terminalSelectionOpen && terminalSelection?.text ? (
      <div className="composer-terminal-selection" role="region" aria-label={t('composer.terminal.region')}>
        <div>
          <SquareTerminal size={14} aria-hidden="true" />
          <strong>{terminalSelection.label}</strong>
          {terminalSelection.truncated ? <small>{t('composer.terminal.truncated')}</small> : null}
        </div>
        <pre>{terminalSelection.text}</pre>
      </div>
    ) : null}
    {images.length || textFiles.length || unsupportedFiles.length || annotations.length || terminalSelection?.text ? (
      <div className="composer-attachments" aria-label={t('composer.attachments.label')}>
        {annotations.length ? (
          <div className="composer-attachment composer-attachment--annotations" title={t('composer.annotations.title', { count: annotations.length })}>
            <button
              type="button"
              className="composer-attachment__expand"
              aria-expanded={annotationsOpen}
              aria-label={t('composer.annotations.inspect', { count: annotations.length })}
              onClick={() => setAnnotationsOpen((open) => !open)}
            >
              <MessageCirclePlus size={13} />
              <span>{annotations.length}</span>
              <ChevronDown size={11} className={annotationsOpen ? 'is-open' : ''} />
            </button>
            <button
              type="button"
              className="composer-attachment__clear"
              aria-label={t('composer.annotations.clear')}
              onClick={() => {
                setAnnotationsOpen(false)
                onClearAnnotations()
              }}
            >
              <X size={12} />
            </button>
          </div>
        ) : null}
        {terminalSelection?.text ? (
          <div className="composer-attachment composer-attachment--terminal has-selection" title={t('composer.terminal.title', { source: terminalSelection.label })}>
            <button
              type="button"
              className="composer-attachment__expand"
              aria-expanded={terminalSelectionOpen}
              aria-label={t('composer.terminal.inspect', { source: terminalSelection.label })}
              onClick={() => setTerminalSelectionOpen((open) => !open)}
            >
              <SquareTerminal size={13} />
              <span>{terminalSelection.label}</span>
              <small>{t('composer.terminal.selected')}</small><ChevronDown size={11} className={terminalSelectionOpen ? 'is-open' : ''} />
            </button>
            <button type="button" className="composer-attachment__clear" aria-label={t('composer.terminal.clear')} onClick={onClearTerminalSelection}><X size={12} /></button>
          </div>
        ) : null}
        {images.map((image) => (
          <div className="composer-attachment" key={image.id}>
            <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
            <span>
              <ImageIcon size={12} />
              {image.name}
            </span>
            <button
              type="button"
              aria-label={t('composer.attachment.remove', { name: image.name })}
              onClick={() => onRemoveFile(image.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {textFiles.map((file) => (
          <div className="composer-attachment" key={file.id}>
            <span>
              <FileText size={12} />
              {file.name}
            </span>
            <button
              type="button"
              aria-label={t('composer.attachment.remove', { name: file.name })}
              onClick={() => onRemoveFile(file.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {unsupportedFiles.map((file) => (
          <div className="composer-attachment" key={file.id}>
            <span>
              <Paperclip size={12} />
              {file.name}
            </span>
            <button
              type="button"
              aria-label={t('composer.attachment.remove', { name: file.name })}
              onClick={() => onRemoveFile(file.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    ) : null}
    </>
  )
}
