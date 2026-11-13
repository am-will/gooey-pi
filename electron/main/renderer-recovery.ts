import { mt } from './localization'

export type RendererRecovery = { kind: 'ignore' } | { kind: 'reload' | 'manual'; message: string; detail: string }

/** One recoverable crash may reload; repeated failures require a deliberate app restart. */
export function rendererRecovery(reason: string, alreadyRecovered: boolean): RendererRecovery {
  if (reason === 'clean-exit') return { kind: 'ignore' }
  if (!alreadyRecovered && ['crashed', 'oom', 'killed', 'abnormal-exit'].includes(reason)) {
    return { kind: 'reload', message: mt('dialog.recovery.crashedTitle'), detail: mt('dialog.recovery.crashedDetail') }
  }
  return { kind: 'manual', message: mt('dialog.recovery.manualTitle'), detail: mt('dialog.recovery.manualDetail') }
}
