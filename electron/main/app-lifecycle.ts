import { dialog, type BrowserWindow } from 'electron'
import type { RuntimeInfo } from '../../src/types/api'
import type { MacBackgroundController } from './background'
import { StateCompatibilityError, StateMigrationError } from './store'
import { boundedErrorMessage } from './validation'

/** Work that would be lost by quitting: in-flight agent turns and armed schedules. */
export interface ActiveShutdownWork {
  runningAgents: number
  activeSchedules: boolean
}

export interface ShutdownPrompt {
  message: string
  detail: string
}

export function activeShutdownWork(runtimes: readonly RuntimeInfo[], hasActiveSchedules: boolean): ActiveShutdownWork {
  const running = runtimes.filter((runtime) => runtime.isStreaming
    || runtime.isCompacting === true
    || runtime.sessionActions?.active !== undefined
    || (runtime.sessionActions?.queuedCount ?? 0) > 0)
  return { runningAgents: running.length, activeSchedules: hasActiveSchedules }
}

/** Null when nothing is active, which is the signal to close without a prompt. */
export function shutdownPrompt(work: ActiveShutdownWork): ShutdownPrompt | null {
  const details: string[] = []
  if (work.runningAgents > 0) {
    details.push(work.runningAgents === 1
      ? 'An agent run is still in progress and will be stopped.'
      : `${work.runningAgents} agent runs are still in progress and will be stopped.`)
  }
  if (work.activeSchedules) details.push('Scheduled automations will not run while GooeyPi is closed.')
  if (details.length === 0) return null
  return {
    message: work.runningAgents > 0 ? 'Close GooeyPi while an agent is running?' : 'Close GooeyPi?',
    detail: details.join(' '),
  }
}

export async function confirmAppClose(window: BrowserWindow | null, prompt: ShutdownPrompt): Promise<boolean> {
  const options = {
    type: 'warning' as const,
    buttons: ['Cancel', 'Close GooeyPi'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'GooeyPi',
    ...prompt,
  }
  const { response } = window && !window.isDestroyed()
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

export interface StartupFailureDialog {
  title: string
  detail: string
}

export function startupFailureDialog(error: unknown): StartupFailureDialog | null {
  if (error instanceof StateMigrationError) {
    return { title: 'GooeyPi state migration failed', detail: boundedErrorMessage(error, 2_048) }
  }
  if (error instanceof StateCompatibilityError) {
    return { title: 'GooeyPi update required', detail: boundedErrorMessage(error, 2_048) }
  }
  return { title: 'GooeyPi could not start', detail: boundedErrorMessage(error, 2_048) }
}

export async function settleShutdown(
  steps: ReadonlyArray<PromiseLike<unknown>>,
  options: { watchdogMs?: number; log?: (message: string) => void; drain?: () => Promise<unknown> } = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message))
  const watchdogMs = options.watchdogMs ?? 10_000
  const settled = Promise.allSettled(steps).then(async (results) => {
    for (const result of results) {
      if (result.status === 'rejected') log(`GooeyPi shutdown step failed: ${boundedErrorMessage(result.reason)}`)
    }
    try { await options.drain?.() } catch (error) { log(`GooeyPi store shutdown failed: ${boundedErrorMessage(error)}`) }
  })
  let timer: NodeJS.Timeout | undefined
  const watchdog = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log(`GooeyPi shutdown did not finish within ${watchdogMs} ms; quitting anyway`)
      resolve()
    }, watchdogMs)
    timer.unref?.()
  })
  try {
    await Promise.race([settled, watchdog])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function routeAllWindowsClosed(
  shutdownInProgress: boolean,
  background: Pick<MacBackgroundController, 'handleAllWindowsClosed'> | null,
  quit: () => void,
): void {
  if (shutdownInProgress) return
  if (!background?.handleAllWindowsClosed()) quit()
}

