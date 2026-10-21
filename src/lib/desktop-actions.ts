import { formattingLocaleTag, translate } from '@/lib/i18n'
import type { PrimeWorkApi } from '@/types/api'
import { errorMessage } from './errors'

type ShellApi = Pick<PrimeWorkApi['app'], 'openExternal' | 'revealPath'>

/**
 * The main process answers these shell requests with a boolean instead of a
 * rejection so a denied path or URL cannot crash a caller. A dropped `false`
 * would leave the click looking like a no-op, so every caller turns the result
 * into display text: null means the request reached the operating system.
 *
 * Callers toast the returned text, and this module has no React context, so the
 * copy is resolved through the app-wide locale mirror when the reply arrives.
 */
export async function openExternalUrl(app: ShellApi, url: string): Promise<string | null> {
  try {
    return await app.openExternal(url) ? null : translate(formattingLocaleTag(), 'error.openExternalFailed', { url })
  } catch (error) {
    return errorMessage(error)
  }
}

export async function revealPath(app: ShellApi, path: string): Promise<string | null> {
  try {
    return await app.revealPath(path) ? null : translate(formattingLocaleTag(), 'error.revealPathFailed', { path })
  } catch (error) {
    return errorMessage(error)
  }
}
