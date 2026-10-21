import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceActions, type WorkspaceActionsDeps } from '../../src/hooks/useWorkspaceActions'
import type { ProcessOutcome } from '../../src/types/api'

function fixture(outcome: ProcessOutcome | Error, desktop = true) {
  const mutate = vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome })
  const refresh = vi.fn(async () => undefined)
  const reportError = vi.fn()
  const deps = {
    bridge: desktop ? { plugins: { installExtension: mutate, setMcpSupport: mutate, connectMcp: mutate, setMcpEnabled: mutate, mutateCapability: mutate } } : null,
    settingsState: { settings: { activeHarness: 'omp' } }, pluginSkills: { refresh }, reportError,
  } as unknown as WorkspaceActionsDeps
  return { actions: createWorkspaceActions(() => deps), mutate, refresh, reportError }
}

describe('workspace capability mutation ownership', () => {
  const operations = [
    (actions: ReturnType<typeof createWorkspaceActions>) => actions.installExtension({ source: 'npm:extension', scope: 'user' }),
    (actions: ReturnType<typeof createWorkspaceActions>) => actions.setMcpSupport(true),
    (actions: ReturnType<typeof createWorkspaceActions>) => actions.connectMcp({ name: 'fixture', scope: 'user', type: 'stdio', command: 'fixture' }),
    (actions: ReturnType<typeof createWorkspaceActions>) => actions.setMcpEnabled({ name: 'fixture', scope: 'user', enabled: true }),
    (actions: ReturnType<typeof createWorkspaceActions>) => actions.mutateCapability({ name: 'fixture', scope: 'user', kind: 'mcp', action: 'disable' }),
  ]
  it.each(operations)('refreshes the catalog only after an accepted mutation', async (operation) => {
    const accepted = fixture({ ok: true, output: '' })
    await expect(operation(accepted.actions)).resolves.toEqual({ ok: true, output: '' })
    expect(accepted.refresh).toHaveBeenCalledOnce()
    expect(accepted.mutate.mock.calls[0].at(-1)).toBe('omp')
    const refused = fixture({ ok: false, output: 'refused' })
    await expect(operation(refused.actions)).resolves.toEqual({ ok: false, output: 'refused' })
    expect(refused.refresh).not.toHaveBeenCalled()
  })
  it.each(operations)('reports a failed mutation once and retains the outcome contract', async (operation) => {
    const error = new Error('fixture failure')
    const failed = fixture(error)
    await expect(operation(failed.actions)).resolves.toEqual({ ok: false, output: error.message })
    expect(failed.reportError).toHaveBeenCalledExactlyOnceWith(error)
    expect(failed.refresh).not.toHaveBeenCalled()
    const blocked = fixture({ ok: true, output: '' }, false)
    await expect(operation(blocked.actions)).resolves.toMatchObject({ ok: false, reason: 'blocked' })
    expect(blocked.mutate).not.toHaveBeenCalled()
  })
})
