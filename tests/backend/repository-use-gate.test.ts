import { describe, expect, it } from 'vitest'
import { RepositoryUseGate } from '../../electron/main/repository-use-gate'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('RepositoryUseGate', () => {
  it('retires an idle resident agent before branch checkout', async () => {
    const gate = new RepositoryUseGate()
    let lease!: { release(): void }
    const retireIfIdle = async (): Promise<boolean> => {
      lease.release()
      return true
    }
    lease = await gate.beginWorkspaceUse('/repo/packages/app', { kind: 'agent', harness: 'prime', runtimeId: 'runtime-1' }, retireIfIdle)

    await expect(gate.runBranchCheckout('/repo', async () => 'changed')).resolves.toBe('changed')
  })

  it('refuses a branch checkout while an agent is busy', async () => {
    const gate = new RepositoryUseGate()
    const lease = await gate.beginWorkspaceUse(
      '/repo/packages/app',
      { kind: 'agent', harness: 'prime', runtimeId: 'runtime-1' },
      async () => false,
    )

    await expect(gate.runBranchCheckout('/repo', async () => 'changed')).rejects.toMatchObject({ code: 'active-work' })
    lease.release()
  })

  it('names mixed workspace owners blocking branch checkout', async () => {
    const gate = new RepositoryUseGate()
    const terminal = await gate.beginWorkspaceUse('/repo', { kind: 'terminal', terminalId: 'terminal-1' })
    const prime = await gate.beginWorkspaceUse('/repo', { kind: 'agent', harness: 'prime', runtimeId: 'prime-runtime' })
    const omp = await gate.beginWorkspaceUse('/repo', { kind: 'agent', harness: 'omp', runtimeId: 'omp-runtime' })

    await expect(gate.runBranchCheckout('/repo', async () => 'changed')).rejects.toMatchObject({
      message: 'Branch checkout is unavailable while 1 terminal and 2 agents (prime, omp) are using this folder. Close the terminal or wait for the agent to finish.',
    })
    terminal.release()
    prime.release()
    omp.release()
  })

  it('holds new workspace users until a branch checkout finishes', async () => {
    const gate = new RepositoryUseGate()
    const checkoutStarted = deferred()
    const releaseCheckout = deferred()
    const checkout = gate.runBranchCheckout('/repo', async () => {
      checkoutStarted.resolve()
      await releaseCheckout.promise
    })
    await checkoutStarted.promise

    let admitted = false
    const leasePromise = gate.beginWorkspaceUse('/repo', { kind: 'terminal', terminalId: 'terminal-1' }).then((lease) => {
      admitted = true
      return lease
    })
    await Promise.resolve()
    expect(admitted).toBe(false)

    releaseCheckout.resolve()
    await checkout
    const lease = await leasePromise
    expect(admitted).toBe(true)
    lease.release()
  })

  it('does not serialize unrelated repositories', async () => {
    const gate = new RepositoryUseGate()
    const checkoutStarted = deferred()
    const releaseCheckout = deferred()
    const checkout = gate.runBranchCheckout('/repo-a', async () => {
      checkoutStarted.resolve()
      await releaseCheckout.promise
    })
    await checkoutStarted.promise

    const lease = await gate.beginWorkspaceUse('/repo-b', { kind: 'terminal', terminalId: 'terminal-2' })
    lease.release()
    await expect(gate.runBranchCheckout('/repo-b', async () => 'other')).resolves.toBe('other')
    releaseCheckout.resolve()
    await checkout
  })
})
