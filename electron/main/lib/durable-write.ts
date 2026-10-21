/**
 * Durable file-replacement primitives for the main-process authority files.
 */
import { errorCode } from '../validation'
import { delay } from './async'

const RETRYABLE_WINDOWS_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** Back-off between Windows rename attempts, about one second in total. */
export const WINDOWS_RENAME_RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 370]

/**
 * Renames `from` over `to`. On win32 a replace can fail briefly while antivirus,
 * indexers or backup agents hold the target open, so EPERM/EACCES/EBUSY are
 * retried after each delay in `delaysMs`. Other platforms and codes fail at once.
 */
export async function renameWithWindowsRetry(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  platform: NodeJS.Platform,
  delaysMs: readonly number[] = WINDOWS_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (platform !== 'win32' || attempt >= delaysMs.length || !RETRYABLE_WINDOWS_RENAME_CODES.has(errorCode(error))) throw error
      await delay(delaysMs[attempt])
    }
  }
}
