import { ChevronRight, FileCode2, X } from 'lucide-react'
import type { GitStatus } from '@/types/api'
import { useI18n } from '@/lib/i18n'

interface ChangesCardProps {
  git: GitStatus
  onOpenChanges(): void
  onClose?(): void
}

export function ChangesCard({ git, onOpenChanges, onClose }: ChangesCardProps) {
  const { t } = useI18n()
  const additions = git.files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = git.files.reduce((sum, file) => sum + file.deletions, 0)
  return <div className="changes-card">
    <button type="button" className="changes-card__open" onClick={onOpenChanges}>
      <span className="changes-card__icon"><FileCode2 size={16} /></span>
      <span className="changes-card__text"><strong>{t('changesCard.filesChanged', { count: git.files.length })}</strong><small>{t('changesCard.review')}</small></span>
      <span className="diff-count diff-count--add">+{additions}</span><span className="diff-count diff-count--remove">−{deletions}</span><ChevronRight size={14} />
    </button>
    {onClose ? <button type="button" className="changes-card__close" aria-label={t('changesCard.dismiss')} title={t('changesCard.dismiss')} onClick={onClose}><X size={15} /></button> : null}
  </div>
}
