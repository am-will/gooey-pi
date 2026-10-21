export type RendererRecovery = { kind: 'ignore' } | { kind: 'reload' | 'manual'; message: string; detail: string }

/** One recoverable crash may reload; repeated failures require a deliberate app restart. */
export function rendererRecovery(reason: string, alreadyRecovered: boolean): RendererRecovery {
  if (reason === 'clean-exit') return { kind: 'ignore' }
  if (!alreadyRecovered && ['crashed', 'oom', 'killed', 'abnormal-exit'].includes(reason)) {
    return { kind: 'reload', message: 'The app view stopped unexpectedly.', detail: 'Reload the view to reconnect to your agent sessions.' }
  }
  return { kind: 'manual', message: 'The app view could not recover.', detail: 'Restart GooeyPi to try again. Running agent sessions will be stopped when the app quits.' }
}
