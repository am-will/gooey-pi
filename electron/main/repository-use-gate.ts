import { resolve, sep } from 'node:path'
import type { HarnessId } from '../../src/types/api'

export type WorkspaceUseOwner =
  | { kind: 'agent'; harness: HarnessId; runtimeId: string }
  | { kind: 'terminal'; terminalId: string }

export interface WorkspaceUseLease {
  release(): void
}

function describeOwners(owners: readonly WorkspaceUseOwner[]): string {
  const terminals = owners.filter((owner) => owner.kind === 'terminal')
  const agents = owners.filter((owner) => owner.kind === 'agent')
  const details: string[] = []
  if (terminals.length) details.push(`${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`)
  if (agents.length) {
    const harnesses = [...new Set(agents.map((owner) => owner.harness))]
    details.push(`${agents.length} agent${agents.length === 1 ? '' : 's'} (${harnesses.join(', ')})`)
  }
  return details.join(' and ')
}

export class RepositoryUseError extends Error {
  readonly code = 'active-work'

  constructor(readonly owners: readonly WorkspaceUseOwner[]) {
    const hasTerminal = owners.some((owner) => owner.kind === 'terminal')
    const hasAgent = owners.some((owner) => owner.kind === 'agent')
    const hint = hasTerminal && hasAgent
      ? 'Close the terminal or wait for the agent to finish.'
      : hasTerminal
        ? 'Close the terminal.'
        : 'Wait for the agent to finish.'
    super(`Branch checkout is unavailable while ${describeOwners(owners)} ${owners.length === 1 ? 'is' : 'are'} using this folder. ${hint}`)
    this.name = 'RepositoryUseError'
  }
}

interface WorkspaceUse {
  path: string
  owner: WorkspaceUseOwner
  retireIfIdle?: () => Promise<boolean>
}

function contains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export class RepositoryUseGate {
  private readonly workspaceUses = new Set<WorkspaceUse>()
  private readonly activeCheckouts = new Set<string>()
  private changed: Promise<void> = Promise.resolve()
  private signalChanged: () => void = () => undefined
  private readonly admissions = new Map<string, Promise<void>>()

  constructor() {
    this.resetChangedSignal()
  }

  async beginWorkspaceUse(
    pathValue: string,
    owner: WorkspaceUseOwner,
    retireIfIdle?: () => Promise<boolean>,
  ): Promise<WorkspaceUseLease> {
    const path = resolve(pathValue)
    while ([...this.activeCheckouts].some((root) => contains(root, path))) await this.changed
    const use = { path, owner, retireIfIdle }
    this.workspaceUses.add(use)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.workspaceUses.delete(use)
        this.notifyChanged()
      },
    }
  }

  async runBranchCheckout<T>(rootValue: string, action: () => Promise<T>): Promise<T> {
    const root = resolve(rootValue)
    let releaseAdmission!: () => void
    const previousAdmission = this.admissions.get(root) ?? Promise.resolve()
    const admission = new Promise<void>((release) => { releaseAdmission = release })
    this.admissions.set(root, admission)
    await previousAdmission
    try {
      this.activeCheckouts.add(root)
      try {
        const owners: WorkspaceUseOwner[] = []
        for (const use of [...this.workspaceUses].filter((candidate) => contains(root, candidate.path))) {
          if (!use.retireIfIdle || !await use.retireIfIdle()) owners.push(use.owner)
        }
        if (owners.length) throw new RepositoryUseError(owners)
        return await action()
      } finally {
        this.activeCheckouts.delete(root)
        this.notifyChanged()
      }
    } finally {
      releaseAdmission()
      if (this.admissions.get(root) === admission) this.admissions.delete(root)
    }
  }

  private resetChangedSignal(): void {
    this.changed = new Promise<void>((resolveChanged) => { this.signalChanged = resolveChanged })
  }

  private notifyChanged(): void {
    this.signalChanged()
    this.resetChangedSignal()
  }
}
