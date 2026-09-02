import type { Event, WebContents, WebContentsDidStartNavigationEventParams } from 'electron'

/**
 * Ceiling for a single guest call (script, input, capture). Electron never
 * settles `executeJavaScript` when a navigation destroys the execution context
 * that owns its promise, so every guest await needs its own deadline.
 */
export const ACTION_TIMEOUT_MS = 30_000
/**
 * Extra margin before the per-tab queue releases a still-pending action. Each
 * guest call already carries ACTION_TIMEOUT_MS, so reaching this means the
 * action is pathologically stuck and liveness matters more than serialization.
 */
export const QUEUE_RELEASE_GRACE_MS = 5_000

/**
 * A navigation replaced the document while a guest call was in flight. Chromium
 * discards the old execution context together with any promise it owns, so the
 * call can never settle and has to be reported instead of awaited forever.
 */
const NAVIGATION_ABORTED_MESSAGE = 'The page navigated while this action was running, so it was cancelled. Retry once the page settles, or use browser_navigate to go there first.'
const ACTION_TIMED_OUT_MESSAGE = 'The page did not answer this action in time and it was cancelled.'

/**
 * Bounds one guest call. Chromium destroys the execution context that owns an
 * `executeJavaScript` promise when the document is replaced, so the promise
 * neither resolves nor rejects; without this the caller waits forever and the
 * tab's action queue never drains again. Same-document navigations keep the
 * context alive and are ignored.
 */
export function guardGuestCall<T>(guest: WebContents, call: Promise<T>, timeoutMs: number): Promise<T> {
  // Reassigned by the executor below before any listener can fire.
  let cleanup = (): void => {}
  const interrupted = new Promise<never>((_resolveInterrupt, reject) => {
    const fail = (message: string) => {
      cleanup()
      reject(new Error(message))
    }
    const onNavigation = (details: Event<WebContentsDidStartNavigationEventParams>) => {
      // Same-document navigations (pushState/replaceState, fragment) and
      // subframe navigations leave the main-frame context intact.
      if (details.isSameDocument || !details.isMainFrame) return
      fail(NAVIGATION_ABORTED_MESSAGE)
    }
    // Guest destruction is deliberately not an interrupt: Electron settles the
    // pending call itself, and already-running work is never retroactively
    // cancelled. Only a context-replacing navigation strands the promise.
    const timer = setTimeout(() => fail(ACTION_TIMED_OUT_MESSAGE), timeoutMs)
    timer.unref?.()
    guest.on('did-start-navigation', onNavigation)
    cleanup = () => {
      clearTimeout(timer)
      guest.removeListener('did-start-navigation', onNavigation)
    }
  })
  const guarded = call.finally(() => cleanup())
  // Whichever promise loses the race must not surface as an unhandled rejection.
  void guarded.catch(() => undefined)
  void interrupted.catch(() => undefined)
  return Promise.race([guarded, interrupted])
}

/**
 * Keeps the per-tab queue alive. Every guest call is already bounded, so a
 * still-pending action here is pathologically stuck; releasing the tail keeps
 * later actions for the tab runnable instead of silently queueing behind a
 * promise that will never settle.
 */
export function releaseQueueEventually(run: Promise<unknown>, releaseAfterMs: number): Promise<unknown> {
  return new Promise((resolveTail) => {
    const timer = setTimeout(() => resolveTail(undefined), releaseAfterMs)
    timer.unref?.()
    void run.catch(() => undefined).then(() => {
      clearTimeout(timer)
      resolveTail(undefined)
    })
  })
}
