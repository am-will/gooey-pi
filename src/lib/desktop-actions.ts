import type { PrimeWorkApi } from '@/types/api'
import { errorMessage } from './errors'

type ShellApi = Pick<PrimeWorkApi['app'], 'openExternal' | 'revealPath'>

/**
 * The main process answers these shell requests with a boolean instead of a
 * rejection so a denied path or URL cannot crash a caller. A dropped `false`
 * would leave the click looking like a no-op, so every caller turns the result
 * into display text: null means the request reached the operating system.
 */
export async function openExternalUrl(app: ShellApi, url: string): Promise<string | null> {
  try {
    return await app.openExternal(url) ? null : `GooeyPi could not open ${url} in your browser.`
  } catch (error) {
    return errorMessage(error)
  }
}

export async function revealPath(app: ShellApi, path: string): Promise<string | null> {
  try {
    return await app.revealPath(path) ? null : `GooeyPi could not reveal ${path} in your file manager.`
  } catch (error) {
    return errorMessage(error)
  }
}
