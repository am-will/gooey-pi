import { ExternalLink } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import type { ProviderAuthEvent } from '@/types/api'
import { Modal } from './ui'

interface ProviderAuthModalProps {
  event: Exclude<ProviderAuthEvent, { type: 'cancelled' }>
  onOpen(url: string): void
  onRespond(promptId: string, value?: string): void
  onCancel(): void
}

export function ProviderAuthModal({ event, onOpen, onRespond, onCancel }: ProviderAuthModalProps) {
  const [value, setValue] = useState('')
  const selectionLabelId = useId()
  useEffect(() => { setValue('') }, [event.type, 'promptId' in event ? event.promptId : event.flowId])

  const footer = event.type === 'prompt' ? (
    <>
      <button type="button" className="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="button button--primary" disabled={!event.allowEmpty && !value.trim()} onClick={() => onRespond(event.promptId, value)}>Continue</button>
    </>
  ) : event.type === 'complete' || event.type === 'error'
    ? <button type="button" className="button button--primary" onClick={onCancel}>Close</button>
    : <button type="button" className="button" onClick={onCancel}>Cancel login</button>

  const title = event.type === 'complete'
    ? 'Authentication successful'
    : event.type === 'error'
      ? 'Authentication failed'
      : 'Connect provider'

  return (
    <Modal title={title} onClose={onCancel} footer={footer}>
      {event.type === 'auth' ? <div className="provider-auth-step"><p>{event.instructions ?? 'Finish signing in through your browser.'}</p><button type="button" className="button" onClick={() => onOpen(event.url)}><ExternalLink size={13} /> Open sign-in page</button></div> : null}
      {event.type === 'progress' ? <p className="modal-intro" role="status">{event.message}</p> : null}
      {event.type === 'prompt' ? <label className="field"><span>{event.message}</span><input autoFocus value={value} placeholder={event.placeholder} autoComplete="off" spellCheck={false} onChange={(change) => setValue(change.target.value)} onKeyDown={(key) => { if (key.key === 'Enter' && (event.allowEmpty || value.trim())) { key.preventDefault(); onRespond(event.promptId, value) } }} /></label> : null}
      {event.type === 'select' ? <div className="provider-auth-options" role="group" aria-labelledby={selectionLabelId}><p id={selectionLabelId}>{event.message}</p>{event.options.map((option) => <button type="button" key={option.id} onClick={() => onRespond(event.promptId, option.id)}>{option.label}</button>)}</div> : null}
      {event.type === 'complete' ? <p className="modal-intro" role="status">Provider is connected. Start a new Prime session to use it.</p> : null}
      {event.type === 'error' ? <p className="page-inline-error" role="alert">{event.error}</p> : null}
    </Modal>
  )
}
