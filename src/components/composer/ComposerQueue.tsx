import { ArrowUp, Clock3, Edit3, Trash2 } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import type { QueuedPrompt } from '@/types/api'

interface Props {
  queuedMessages: QueuedPrompt[]
  harnessQueuedMessageCount: number
  agentName: string
  onSendNow(queued: QueuedPrompt): Promise<void>
  onEdit(queued: QueuedPrompt): void
  onDelete?(queued: QueuedPrompt): void
}

export function ComposerQueue({ queuedMessages, harnessQueuedMessageCount, agentName, onSendNow, onEdit, onDelete }: Props) {
  const { t } = useI18n()
  return (<>
      {queuedMessages.length || harnessQueuedMessageCount ? (
        <section className="composer-queue" aria-label={t('composer.queue.label')} aria-live="polite">
          <div className="composer-queue__header">
            <span><Clock3 size={13} />{t('composer.queue.label')}</span>
            <strong>{queuedMessages.length + harnessQueuedMessageCount}</strong>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((queued) => (
              <div className="composer-queue__item" key={queued.id}>
                <span className="composer-queue__text">{queued.text}</span>
                <span className="composer-queue__actions">
                  <button type="button" className="composer-queue__action" aria-label={t('composer.queue.sendNowDetail', { text: queued.text })} title={t('composer.queue.sendNow')} onClick={() => { void onSendNow(queued) }}><ArrowUp size={13} /></button>
                  <button type="button" className="composer-queue__action" aria-label={t('composer.queue.editDetail', { text: queued.text })} title={t('composer.queue.edit')} onClick={() => { onEdit(queued) }}><Edit3 size={13} /></button>
                  <button type="button" className="composer-queue__action composer-queue__action--delete" aria-label={t('composer.queue.deleteDetail', { text: queued.text })} title={t('composer.queue.delete')} onClick={() => onDelete?.(queued)}><Trash2 size={13} /></button>
                </span>
              </div>
            ))}
            {harnessQueuedMessageCount ? (
              <div className="composer-queue__item composer-queue__item--harness">
                <span className="composer-queue__text">{t('composer.queue.harnessHolding', { agent: agentName, count: harnessQueuedMessageCount })}</span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
  </>)
}
