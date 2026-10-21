import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { saveComposerDraftFromDom } from './lib/composer-draft'
import { I18nProvider, useI18n } from './lib/i18n'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('GooeyPi root element was not found')

/**
 * Rendered when the app subtree fails to mount. It sits outside `App`, so it
 * cannot read the stored language preference; the provider falls back to the
 * system locale rather than leaving the crash screen in English forever.
 */
function AppErrorFallback() {
  const { t } = useI18n()
  return (
    <div className="empty-state app-error-fallback" role="alert">
      <h2>{t('app.error.title')}</h2>
      <p>{t('app.error.body')}</p>
      <div className="empty-state__action">
        <button type="button" className="button button--primary" onClick={() => window.location.reload()}>{t('common.reload')}</button>
      </div>
    </div>
  )
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary
      onCatch={saveComposerDraftFromDom}
      fallback={(
        <I18nProvider preference="system">
          <AppErrorFallback />
        </I18nProvider>
      )}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
