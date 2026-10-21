import type { MessageKey } from '@/lib/i18n'

/**
 * Session records carry their own title, which is data rather than interface
 * copy: the user can rename it and the harness derives it from the first
 * request. The main process writes a fixed English placeholder until a real
 * title exists, and three renderer checks compare against that exact value, so
 * it must keep travelling through the session record unchanged.
 *
 * Display surfaces therefore map the placeholder back onto a catalog key
 * instead of translating the data. Keep the placeholder value in sync with
 * `electron/main/sessions/metadata.ts` and `electron/main/sessions/bucketed.ts`.
 */
export const UNTITLED_SESSION_TITLE = 'Untitled session'

const UNTITLED_SESSION_TITLE_KEY: MessageKey = 'sidebar.untitledSession'

type Translator = (key: MessageKey, values?: Record<string, string | number>) => string

/** True while a session still carries the main-process placeholder title. */
export function isUntitledSessionTitle(title: string | undefined): boolean {
  return title === UNTITLED_SESSION_TITLE
}

/** Title text for display; the placeholder follows the interface language. */
export function sessionTitleText(title: string, t: Translator): string {
  return isUntitledSessionTitle(title) ? t(UNTITLED_SESSION_TITLE_KEY) : title
}
