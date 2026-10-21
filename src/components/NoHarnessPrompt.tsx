import { useI18n } from '@/lib/i18n'
import { Modal } from './ui'

export function NoHarnessPrompt({ onClose, onOpenHarnessSettings }: { onClose(): void; onOpenHarnessSettings(): void }) {
  const { t } = useI18n()
  return (
    <Modal
      title={t('noHarness.title')}
      onClose={onClose}
      footer={<button type="button" className="button button--primary" onClick={onOpenHarnessSettings}>{t('noHarness.takeMeThere')}</button>}
    >
      <p>{t('noHarness.body1')}</p>
      <p>{t('noHarness.body2')}</p>
    </Modal>
  )
}
