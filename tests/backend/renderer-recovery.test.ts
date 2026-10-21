import { describe, expect, it } from 'vitest'
import { rendererRecovery } from '../../electron/main/renderer-recovery'

describe('renderer recovery policy', () => {
  it('ignores a normal renderer exit', () => {
    expect(rendererRecovery('clean-exit', false)).toEqual({ kind: 'ignore' })
  })

  it.each(['crashed', 'oom', 'killed', 'abnormal-exit'])('offers one reload for %s', (reason) => {
    expect(rendererRecovery(reason, false).kind).toBe('reload')
    expect(rendererRecovery(reason, true).kind).toBe('manual')
  })

  it.each(['launch-failed', 'integrity-failure', 'unknown'])('avoids retry loops for %s', (reason) => {
    expect(rendererRecovery(reason, false).kind).toBe('manual')
  })
})
