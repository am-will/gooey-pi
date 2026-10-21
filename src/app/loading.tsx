import { useI18n, type MessageKey } from '@/lib/i18n'
import type { WorkspaceView } from '@/types/api'

// Suspense fallbacks resolve their copy through MessageKeys so the shell's own
// text follows the interface language without threading strings through props.
export const LoadingPanel = ({ label }: { label: MessageKey }) => {
  const { t } = useI18n()
  return <div className="empty-state" role="status">{t(label)}</div>
}
export const TerminalLoadingPanel = () => {
  const { t } = useI18n()
  return <div className="terminal-drawer terminal-drawer--loading" role="status">{t('app.loading.terminal')}</div>
}
export const VIEW_LOADING_KEYS = {
  projects: 'app.loading.projects', activity: 'app.loading.activity', scheduled: 'app.loading.scheduled', plugins: 'app.loading.plugins', settings: 'app.loading.settings',
} as const satisfies Record<Exclude<WorkspaceView, 'session'>, MessageKey>

