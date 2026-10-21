import { useState } from 'react'
import { errorMessage } from '@/lib/errors'
import { formatRelative } from '@/lib/data'
import { useI18n } from '@/lib/i18n'
import type { ProjectRecord, SessionRecord } from '@/types/api'

interface ArchivedChatsSettingsProps {
  /** Sessions the user archived in the active harness. They stay on disk. */
  archived: SessionRecord[]
  projects: ProjectRecord[]
  onRestore(session: SessionRecord): Promise<void> | void
}

function projectLabel(session: SessionRecord, projects: readonly ProjectRecord[]): string {
  const match = projects.find((project) => project.path === session.projectPath)
  return match?.name ?? session.projectPath.split('/').filter(Boolean).pop() ?? session.projectPath
}

export function ArchivedChatsSettings({ archived, projects, onRestore }: ArchivedChatsSettingsProps) {
  const { t } = useI18n()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const sorted = [...archived].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  const restore = async (session: SessionRecord) => {
    if (pendingId) return
    setPendingId(session.id)
    setError('')
    try {
      await onRestore(session)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <>
      <header><h1>{t('archived.title')}</h1><p>{t('archived.description')}</p></header>
      <section className="settings-group">
        <h2>{t('archived.count', { count: sorted.length })}</h2>
        {sorted.length === 0 ? <p className="settings-empty">{t('archived.empty')}</p> : null}
        {sorted.map((session) => (
          <div className="settings-row" key={session.id}>
            <span>
              <strong>{session.title}</strong>
              <small>{projectLabel(session, projects)} · {formatRelative(session.updatedAt)}</small>
            </span>
            <button
              type="button"
              className="button button--compact"
              disabled={pendingId !== null}
              onClick={() => { void restore(session) }}
            >{pendingId === session.id ? t('archived.restoring') : t('archived.restore')}</button>
          </div>
        ))}
        {error ? <p className="settings-error" role="alert">{error}</p> : null}
      </section>
    </>
  )
}
