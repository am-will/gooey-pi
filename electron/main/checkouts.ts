import { resolve } from 'node:path'
import type { AppSettings, CheckoutAction, CheckoutCatalog, CheckoutChangeResult, CheckoutStrategy, ProjectRecord } from '../../src/types/api'
import { createAndSwitchGitBranch, createGitWorktree, isNotARepositoryFailure, listGitWorktrees, listLocalGitBranches, resolveGitRepositoryRoot, switchGitBranch, validateGitBranch } from './git'
import type { ProjectService } from './projects'
import { RepositoryUseError, type RepositoryUseGate } from './repository-use-gate'
import { rejectUnknownKeys, requireId, requireRecord, requireString } from './validation'

function parseAction(value: unknown): CheckoutAction {
  const action = requireRecord(value, 'checkout action')
  rejectUnknownKeys(action, action.strategy === 'worktree' && action.operation === 'open'
    ? ['strategy', 'operation', 'path']
    : ['strategy', 'operation', 'branch'], 'checkout action')
  if (action.strategy === 'worktree' && action.operation === 'open') {
    return { strategy: 'worktree', operation: 'open', path: requireString(action.path, 'checkout path', { min: 1, max: 4096 }) }
  }
  if (action.strategy === 'worktree' && action.operation === 'create') {
    return { strategy: 'worktree', operation: 'create', branch: requireString(action.branch, 'branch', { min: 1, max: 255, trim: true }) }
  }
  if (action.strategy === 'branch' && (action.operation === 'switch' || action.operation === 'create')) {
    return { strategy: 'branch', operation: action.operation, branch: requireString(action.branch, 'branch', { min: 1, max: 255, trim: true }) }
  }
  throw new TypeError('checkout action has an invalid strategy or operation')
}

function strategyRefusal(strategy: CheckoutStrategy): CheckoutChangeResult {
  return { kind: 'refused', code: 'strategy-changed', message: `Checkout style changed to ${strategy === 'worktree' ? 'worktrees' : 'branches'}. Reopen the checkout menu and try again.` }
}

export class CheckoutService {
  constructor(
    private readonly strategy: () => AppSettings['checkoutStrategy'],
    private readonly projects: ProjectService,
    private readonly useGate: RepositoryUseGate,
  ) {}

  async list(projectIdValue: unknown): Promise<CheckoutCatalog> {
    const project = await this.projects.resolveCheckoutProject(requireId(projectIdValue, 'project id'))
    const strategy = this.strategy()
    if (strategy === 'branch') {
      const checkouts = await listLocalGitBranches(project.primaryFolder)
      return { strategy, activeName: checkouts.find((branch) => branch.current)?.name ?? '', checkouts }
    }
    try {
      return { strategy, activePath: project.primaryFolder, checkouts: await listGitWorktrees(project.primaryFolder) }
    } catch (error) {
      if (isNotARepositoryFailure(error)) return { strategy, activePath: project.primaryFolder, checkouts: [] }
      throw error
    }
  }

  async execute(projectIdValue: unknown, actionValue: unknown): Promise<CheckoutChangeResult> {
    const projectId = requireId(projectIdValue, 'project id')
    const action = parseAction(actionValue)
    const strategy = this.strategy()
    if (action.strategy !== strategy) return strategyRefusal(strategy)
    const project = await this.projects.resolveCheckoutProject(projectId)
    if (action.strategy === 'worktree') return this.executeWorktree(project, action)
    try {
      const repositoryRoot = await resolveGitRepositoryRoot(project.primaryFolder)
      return await this.useGate.runBranchCheckout(repositoryRoot, async () => this.executeBranch(project, action))
    } catch (error) {
      if (error instanceof RepositoryUseError) return { kind: 'refused', code: 'active-work', message: error.message }
      throw error
    }
  }

  private async executeWorktree(
    project: ProjectRecord,
    action: Extract<CheckoutAction, { strategy: 'worktree' }>,
  ): Promise<CheckoutChangeResult> {
    const worktrees = await listGitWorktrees(project.primaryFolder)
    if (action.operation === 'open') {
      const path = resolve(action.path)
      const linked = worktrees.find((worktree) => resolve(worktree.path) === path)
      if (!linked) return { kind: 'refused', code: 'checkout-not-found', message: 'That worktree is no longer linked to this repository.' }
      if (resolve(project.primaryFolder) === path) {
        return { kind: 'unchanged', project, checkout: { strategy: 'worktree', path } }
      }
      const next = await this.projects.adoptCheckoutWorktree(project.id, project.primaryFolder, path)
      return { kind: 'applied', project: next, checkout: { strategy: 'worktree', path } }
    }
    const branch = await validateGitBranch(project.primaryFolder, action.branch)
    const targetPath = await this.projects.chooseCheckoutWorktreePath(project.primaryFolder, branch, worktrees)
    if (!targetPath) return { kind: 'cancelled' }
    await createGitWorktree(project.primaryFolder, targetPath, branch)
    const next = await this.projects.adoptCheckoutWorktree(project.id, project.primaryFolder, targetPath)
    return { kind: 'applied', project: next, checkout: { strategy: 'worktree', path: targetPath } }
  }

  private async executeBranch(
    project: ProjectRecord,
    action: Extract<CheckoutAction, { strategy: 'branch' }>,
  ): Promise<CheckoutChangeResult> {
    const branch = await validateGitBranch(project.primaryFolder, action.branch)
    const outcome = action.operation === 'create'
      ? await createAndSwitchGitBranch(project.primaryFolder, branch)
      : await switchGitBranch(project.primaryFolder, branch)
    if (outcome.kind === 'not-found') {
      return { kind: 'refused', code: 'checkout-not-found', message: 'That local branch no longer exists.' }
    }
    if (outcome.kind === 'already-exists') {
      return { kind: 'refused', code: 'checkout-already-exists', message: 'That local branch already exists.' }
    }
    if (outcome.kind === 'dirty') {
      const detail = outcome.changedPaths.length ? ` ${outcome.changedPaths.length} changed path${outcome.changedPaths.length === 1 ? '' : 's'} must be resolved first.` : ''
      return { kind: 'refused', code: 'dirty-worktree', message: `Branch checkout requires a clean project. GooeyPi did not modify your files.${detail}` }
    }
    if (outcome.kind === 'unchanged') return { kind: 'unchanged', project, checkout: { strategy: 'branch', branch } }
    return { kind: 'applied', project: await this.projects.refreshCheckoutProject(project.id), checkout: { strategy: 'branch', branch } }
  }
}
