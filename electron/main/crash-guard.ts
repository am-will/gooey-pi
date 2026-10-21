import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CrashGuardOptions {
  /** Resolved lazily so a crash before app readiness still degrades gracefully. */
  logPath: () => string | null
  /** Best-effort child-process cleanup; failures never block the exit. */
  cleanup: () => Promise<unknown>
  exit?: (code: number) => void
  cleanupTimeoutMs?: number
}

export interface CrashGuard {
  /** Runs the fatal path directly; exposed so tests never have to emit real process events. */
  handle(kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void
  dispose(): void
}

/** Log startup and fatal failures through the same best-effort disk boundary. */
export function writeCrashLog(logPath: () => string | null, kind: 'startup' | 'uncaughtException' | 'unhandledRejection', reason: unknown): void {
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  try {
    const path = logPath()
    if (!path) return
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `[${new Date().toISOString()}] ${kind}: ${detail}\n`)
  } catch { /* A diagnostic write must not replace the original failure. */ }
}

/**
 * Last-resort handlers for errors nothing else caught. This is a backstop, not a
 * swallow: the process always exits non-zero after logging and attempting to stop
 * child processes, bounded by a timeout so a hung cleanup cannot keep a broken
 * main process alive.
 */
export function installCrashGuards(options: CrashGuardOptions): CrashGuard {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5_000
  let crashing = false
  const handle = (kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
    if (crashing) return
    crashing = true
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
    writeCrashLog(options.logPath, kind, reason)
    console.error(`GooeyPi fatal ${kind}: ${detail}`)
    const deadline = setTimeout(() => exit(1), cleanupTimeoutMs)
    deadline.unref?.()
    void Promise.resolve()
      .then(() => options.cleanup())
      .catch(() => undefined)
      .then(() => {
        clearTimeout(deadline)
        exit(1)
      })
  }
  const onException = (error: Error): void => handle('uncaughtException', error)
  const onRejection = (reason: unknown): void => handle('unhandledRejection', reason)
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  return {
    handle,
    dispose: () => {
      process.off('uncaughtException', onException)
      process.off('unhandledRejection', onRejection)
    },
  }
}
