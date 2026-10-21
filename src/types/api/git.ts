import type { ProjectRecord } from './projects'
export interface GitWorktree {
  path: string
  name: string
  branch?: string
  head: string
  current: boolean
  detached: boolean
}
export const CHECKOUT_STRATEGIES = ['worktree', 'branch'] as const
export type CheckoutStrategy = (typeof CHECKOUT_STRATEGIES)[number]
export interface LocalGitBranch {
  name: string
  current: boolean
}
export type CheckoutCatalog =
  | { strategy: 'worktree'; activePath: string; checkouts: GitWorktree[] }
  | { strategy: 'branch'; activeName: string; checkouts: LocalGitBranch[] }
export type CheckoutAction =
  | { strategy: 'worktree'; operation: 'open'; path: string }
  | { strategy: 'worktree'; operation: 'create'; branch: string }
  | { strategy: 'branch'; operation: 'switch'; branch: string }
  | { strategy: 'branch'; operation: 'create'; branch: string }
export type CheckoutSelection =
  | { strategy: 'worktree'; path: string }
  | { strategy: 'branch'; branch: string }
export type CheckoutRefusalCode =
  | 'strategy-changed'
  | 'active-work'
  | 'dirty-worktree'
  | 'checkout-not-found'
  | 'checkout-already-exists'
export type CheckoutChangeResult =
  | { kind: 'applied'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'unchanged'; project: ProjectRecord; checkout: CheckoutSelection }
  | { kind: 'cancelled' }
  | { kind: 'refused'; code: CheckoutRefusalCode; message: string }
export interface GitFileChange {
  path: string
  status: string
  staged: boolean
  additions: number
  deletions: number
}
export interface GitStatus {
  /** Absolute repository root against which file paths are relative. */
  root?: string
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  files: GitFileChange[]
  truncated?: boolean
  error?: string
}
export interface GitDiff { path?: string; staged: boolean; text: string; truncated: boolean; error?: string }
