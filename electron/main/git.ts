import { basename, resolve } from 'node:path'
import type { GitDiff, GitFileChange, GitStatus, GitWorktree, LocalGitBranch, ProcessOutcome } from '../../src/types/api'
import { restrictedGitEnvironment, runProcess, type ProcessResult } from './process-utils'
import { errorMessage, requireGitPath, requireString, stripAnsi } from './validation'

interface Numstat { additions: number; deletions: number }
interface ParsedNumstat { values: Map<string, Numstat>; truncated: boolean }

export const GIT_STATUS_ENTRY_LIMIT = 1_000
export const GIT_DIFF_LINE_LIMIT = 5_000
const GIT_STATUS_OUTPUT_LIMIT = 4 * 1024 * 1024
const GIT_CONFIG_OUTPUT_LIMIT = 512 * 1024
const GIT_DIFF_OUTPUT_LIMIT = 2 * 1024 * 1024
const GIT_ERROR_LIMIT = 2_000
const GIT_IDENTITY_VALUE_LIMIT = 320
const GIT_WORKTREE_OUTPUT_LIMIT = 1024 * 1024
const GIT_WORKTREE_LIMIT = 1_000
const GIT_BRANCH_OUTPUT_LIMIT = 1024 * 1024
const GIT_BRANCH_LIMIT = 1_000
const EMPTY_CONFIG_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
const BASE_GIT_CONFIG = [
  'core.fsmonitor=false',
  `core.hooksPath=${EMPTY_CONFIG_PATH}`,
  'diff.external=',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'status.submoduleSummary=false',
  'submodule.recurse=false',
] as const

function hardenedGitArgs(args: readonly string[], extraConfig: readonly string[] = []): string[] {
  const result = ['--no-pager']
  for (const config of [...BASE_GIT_CONFIG, ...extraConfig]) result.push('-c', config)
  return [...result, ...args]
}

function runGit(cwd: string, args: readonly string[], options: { timeoutMs: number; maxBytes: number; input?: string }, extraConfig: readonly string[] = []): Promise<ProcessResult> {
  return runProcess('git', hardenedGitArgs(args, extraConfig), { cwd, ...options, env: restrictedGitEnvironment() })
}

function resultDetail(result: ProcessResult): string {
  return stripAnsi(result.stderr || result.stdout).trim().slice(0, GIT_ERROR_LIMIT)
}

function processError(operation: string, result: ProcessResult): Error {
  if (result.outputExceeded) return new Error(`${operation} output exceeded the safety limit; the result is incomplete`)
  if (result.timedOut) return new Error(`${operation} timed out; the result is unknown`)
  const detail = resultDetail(result)
  const suffix = result.signal ? ` (signal ${result.signal})` : ` (exit ${result.code})`
  return new Error(detail ? `${operation} failed: ${detail}` : `${operation} failed${suffix}`)
}

function requireProcessSuccess(operation: string, result: ProcessResult): void {
  if (result.code !== 0 || result.timedOut || result.outputExceeded) throw processError(operation, result)
}

export function isNotARepositoryFailure(error: unknown): boolean {
  return /not a git repository/i.test(errorMessage(error))
}

function nextNulField(output: string, cursor: number): { value: string; cursor: number } {
  const end = output.indexOf('\0', cursor)
  if (end < 0) return { value: output.slice(cursor), cursor: output.length }
  return { value: output.slice(cursor, end), cursor: end + 1 }
}

function parseNumstat(output: string, maxEntries = GIT_STATUS_ENTRY_LIMIT): ParsedNumstat {
  const values = new Map<string, Numstat>()
  let cursor = 0
  let truncated = false
  while (cursor < output.length) {
    const header = nextNulField(output, cursor)
    cursor = header.cursor
    if (!header.value) continue
    const firstTab = header.value.indexOf('\t')
    const secondTab = header.value.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const additions = Number.parseInt(header.value.slice(0, firstTab), 10)
    const deletions = Number.parseInt(header.value.slice(firstTab + 1, secondTab), 10)
    let path = header.value.slice(secondTab + 1)
    if (!path) {
      // With -z, renames are: numstat header, old path, new path.
      const oldPath = nextNulField(output, cursor)
      const newPath = nextNulField(output, oldPath.cursor)
      cursor = newPath.cursor
      path = newPath.value || oldPath.value
    }
    if (!path) continue
    if (values.size >= maxEntries) { truncated = true; break }
    values.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return { values, truncated }
}

function parseBranch(header: string, status: GitStatus): void {
  let value = header.slice(3)
  if (value.startsWith('No commits yet on ')) value = value.slice('No commits yet on '.length)
  if (value.startsWith('Initial commit on ')) value = value.slice('Initial commit on '.length)
  const detailIndex = value.indexOf(' [')
  const details = detailIndex >= 0 ? value.slice(detailIndex + 2, -1) : ''
  const name = detailIndex >= 0 ? value.slice(0, detailIndex) : value
  const upstreamIndex = name.indexOf('...')
  status.branch = upstreamIndex >= 0 ? name.slice(0, upstreamIndex) : name
  if (upstreamIndex >= 0) status.upstream = name.slice(upstreamIndex + 3)
  const ahead = details.match(/ahead (\d+)/)
  const behind = details.match(/behind (\d+)/)
  if (ahead) status.ahead = Number(ahead[1])
  if (behind) status.behind = Number(behind[1])
}

function addStatusChange(status: GitStatus, path: string, code: string, staged: boolean, stats: Map<string, Numstat>): boolean {
  if (status.files.length >= GIT_STATUS_ENTRY_LIMIT) { status.truncated = true; return false }
  const values = stats.get(path) ?? { additions: 0, deletions: 0 }
  const change: GitFileChange = { path, status: code.trim() || code, staged, ...values }
  status.files.push(change)
  return true
}

function parseStatus(output: string, staged: ParsedNumstat, unstaged: ParsedNumstat): GitStatus {
  const status: GitStatus = { isRepo: true, files: [] }
  if (staged.truncated || unstaged.truncated) status.truncated = true
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record) continue
    if (record.startsWith('## ')) { parseBranch(record, status); continue }
    if (record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (!path) continue
    const renamed = code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C'
    if (renamed) cursor = nextNulField(output, cursor).cursor

    const hasIndexChange = code[0] !== ' ' && code[0] !== '?'
    const hasWorktreeChange = code[1] !== ' ' && code[1] !== '!'
    if (hasIndexChange && !addStatusChange(status, path, code, true, staged.values)) break
    if (hasWorktreeChange && !addStatusChange(status, path, code, false, unstaged.values)) break
  }
  return status
}

function capDiffLines(text: string): { text: string; truncated: boolean } {
  let lines = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    lines += 1
    if (lines > GIT_DIFF_LINE_LIMIT) {
      return {
        text: `${text.slice(0, index)}
[GooeyPi: diff truncated at ${GIT_DIFF_LINE_LIMIT.toLocaleString('en-US')} lines.]`,
        truncated: true,
      }
    }
  }
  return { text, truncated: false }
}

function filterDriverFromKey(key: string): string | undefined {
  const match = key.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/i)
  return match?.[1]
}

/**
 * Reads the repository's effective configuration in one spawn. With
 * `restrictedGitEnvironment` the system and global scopes are disabled, so
 * this reflects the repository scope (plus its includes and the hardened
 * command-line overrides). Later values win, matching Git precedence.
 */
async function repositoryConfig(cwd: string): Promise<Map<string, string>> {
  const result = await runGit(cwd, ['config', '--includes', '--null', '--list'], {
    timeoutMs: 5_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
  })
  requireProcessSuccess('Git configuration inspection', result)
  const config = new Map<string, string>()
  let cursor = 0
  while (cursor < result.stdout.length) {
    const field = nextNulField(result.stdout, cursor)
    cursor = field.cursor
    if (!field.value) continue
    const separator = field.value.indexOf('\n')
    const key = separator < 0 ? field.value : field.value.slice(0, separator)
    const value = separator < 0 ? '' : field.value.slice(separator + 1)
    config.set(key, value)
  }
  return config
}

function filterOverridesFromConfig(config: ReadonlyMap<string, string>): string[] {
  const drivers = new Set<string>()
  for (const key of config.keys()) {
    const driver = filterDriverFromKey(key)
    if (!driver) continue
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(driver)) throw new Error('Git filter configuration contains an unsafe driver name')
    drivers.add(driver)
    if (drivers.size > 128) throw new Error('Git filter configuration exceeds the safety limit')
  }
  const overrides: string[] = []
  for (const driver of drivers) {
    overrides.push(
      `filter.${driver}.clean=`,
      `filter.${driver}.smudge=`,
      `filter.${driver}.process=`,
      `filter.${driver}.required=false`,
    )
  }
  return overrides
}

function validIdentityValue(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > GIT_IDENTITY_VALUE_LIMIT || /[\0\r\n]/.test(trimmed)) return undefined
  return trimmed
}

async function readGlobalConfigValue(cwd: string, key: 'user.name' | 'user.email'): Promise<string | undefined> {
  const env = restrictedGitEnvironment()
  delete env.GIT_CONFIG_GLOBAL
  for (const name of process.platform === 'win32' ? ['USERPROFILE', 'HOME', 'XDG_CONFIG_HOME'] : ['HOME', 'XDG_CONFIG_HOME']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const result = await runProcess('git', hardenedGitArgs(['config', '--global', '--no-includes', '--get', key]), {
    cwd,
    timeoutMs: 5_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
    env,
  })
  if (result.code === 1 && !result.timedOut && !result.outputExceeded) return undefined
  requireProcessSuccess('Git global identity inspection', result)
  return validIdentityValue(result.stdout)
}

/**
 * Derives commit identity from the already-fetched repository configuration;
 * only a missing repository-scope value costs an extra (global-scope) spawn.
 */
async function commitIdentityOverrides(cwd: string, config: ReadonlyMap<string, string>): Promise<string[]> {
  const localName = validIdentityValue(config.get('user.name') ?? '')
  const localEmail = validIdentityValue(config.get('user.email') ?? '')
  const [globalName, globalEmail] = await Promise.all([
    localName ? Promise.resolve(undefined) : readGlobalConfigValue(cwd, 'user.name'),
    localEmail ? Promise.resolve(undefined) : readGlobalConfigValue(cwd, 'user.email'),
  ])
  const name = localName ?? globalName
  const email = localEmail ?? globalEmail
  return [
    ...(name ? [`user.name=${name}`] : []),
    ...(email ? [`user.email=${email}`] : []),
  ]
}

interface ChangedPathState {
  untracked: boolean
  restorePaths: string[]
}

function changedPathStatesFromStatus(output: string): Map<string, ChangedPathState> {
  const states = new Map<string, ChangedPathState>()
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record || record.startsWith('## ') || record.length < 4) continue
    const code = record.slice(0, 2)
    const pathValue = record.slice(3)
    if (!pathValue) continue
    const path = requireGitPath(pathValue, 'Git status path')
    const restorePaths = [path]
    if (code.includes('R') || code.includes('C')) {
      const previous = nextNulField(output, cursor)
      cursor = previous.cursor
      if (previous.value) restorePaths.push(requireGitPath(previous.value, 'Git status path'))
    }
    states.set(path, { untracked: code === '??', restorePaths })
  }
  return states
}


async function rejectFilteredPaths(cwd: string, paths: readonly string[], overrides: readonly string[]): Promise<void> {
  if (!paths.length) return
  // Feed the paths to one bounded process. Status output and direct mutation inputs
  // are capped, so this inspects every path without an attacker causing an
  // unbounded sequence of check-attr subprocesses.
  const result = await runGit(cwd, ['check-attr', '-z', '--stdin', 'filter'], {
    timeoutMs: 10_000,
    maxBytes: GIT_CONFIG_OUTPUT_LIMIT,
    input: `${paths.join('\0')}\0`,
  }, overrides)
  requireProcessSuccess('Git filter attribute inspection', result)
  const affected: string[] = []
  let cursor = 0
  while (cursor < result.stdout.length) {
    const path = nextNulField(result.stdout, cursor)
    const attribute = nextNulField(result.stdout, path.cursor)
    const value = nextNulField(result.stdout, attribute.cursor)
    cursor = value.cursor
    if (attribute.value !== 'filter' || value.value === 'unspecified' || value.value === 'unset' || !path.value) continue
    affected.push(path.value)
    if (affected.length >= 5) break
  }
  if (!affected.length) return
  const suffix = affected.length === 1 ? affected[0] : `${affected.join(', ')}${paths.length > affected.length ? ', …' : ''}`
  throw new Error(`Git operation blocked because clean/smudge filters cannot run safely for: ${suffix}. Use a trusted Git client with the required filter (for example Git LFS).`)
}

interface RepositoryContext {
  /** Canonical, authorized repository toplevel; every follow-up command runs here. */
  cwd: string
  /** Filter-neutralizing config overrides derived from the repository configuration. */
  overrides: string[]
  /** Effective repository configuration from the single per-operation config spawn. */
  config: Map<string, string>
}

function parseWorktreeList(output: string, repositoryRoot: string): GitWorktree[] {
  const records = output.split('\0\0').filter(Boolean)
  if (records.length > GIT_WORKTREE_LIMIT) throw new Error('Git worktree list exceeded the safety limit')
  return records.map((record, index) => {
    const fields = record.split('\0').filter(Boolean)
    const pathField = fields.find((field) => field.startsWith('worktree '))
    const headField = fields.find((field) => field.startsWith('HEAD '))
    const branchField = fields.find((field) => field.startsWith('branch '))
    const pathValue = pathField?.slice('worktree '.length)
    const head = headField?.slice('HEAD '.length)
    if (!pathValue || pathValue.length > 4096 || !head || !/^[0-9a-fA-F]{4,64}$/.test(head)) {
      throw new Error(`Git worktree list returned an invalid record at index ${index}`)
    }
    const path = resolve(pathValue)
    const branchRef = branchField?.slice('branch '.length)
    if (branchRef && (branchRef.length > 1024 || !branchRef.startsWith('refs/heads/'))) {
      throw new Error(`Git worktree list returned an invalid branch at index ${index}`)
    }
    const branch = branchRef?.slice('refs/heads/'.length)
    return {
      path,
      name: basename(path) || path,
      branch,
      head: head.toLowerCase(),
      current: path === resolve(repositoryRoot),
      detached: fields.includes('detached') || branch === undefined,
    }
  })
}

async function inspectRepositoryRoot(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  requireProcessSuccess('Git repository root inspection', result)
  const repositoryRoot = result.stdout.trim()
  if (!repositoryRoot || repositoryRoot.length > 4096) throw new Error('Git repository root inspection returned no valid path')
  return resolve(repositoryRoot)
}

export function resolveGitRepositoryRoot(cwd: string): Promise<string> {
  return inspectRepositoryRoot(cwd)
}

/** Caller must authorize cwd before invoking this privileged fixed-argv helper. */
export async function listGitWorktrees(cwd: string): Promise<GitWorktree[]> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const result = await runGit(repositoryRoot, ['worktree', 'list', '--porcelain', '-z'], { timeoutMs: 10_000, maxBytes: GIT_WORKTREE_OUTPUT_LIMIT })
  requireProcessSuccess('Git worktree list', result)
  return parseWorktreeList(result.stdout, repositoryRoot)
}

/** Caller must authorize cwd before invoking this privileged fixed-argv helper. */
export async function validateGitBranch(cwd: string, branchValue: unknown): Promise<string> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = requireString(branchValue, 'branch', { min: 1, max: 255, trim: true })
  const check = await runGit(repositoryRoot, ['check-ref-format', '--branch', branch], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
  requireProcessSuccess('Git branch validation', check)
  return branch
}

/** Caller must authorize cwd and obtain targetPath through a trusted native picker. */
export async function createGitWorktree(cwd: string, targetPath: string, branchValue: unknown): Promise<void> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = await validateGitBranch(repositoryRoot, branchValue)
  const result = await runGit(repositoryRoot, ['worktree', 'add', '-b', branch, '--', resolve(targetPath)], { timeoutMs: 2 * 60_000, maxBytes: GIT_WORKTREE_OUTPUT_LIMIT })
  requireProcessSuccess('Git worktree creation', result)
}

export async function listLocalGitBranches(cwd: string): Promise<LocalGitBranch[]> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const result = await runGit(repositoryRoot, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00', '--sort=refname', 'refs/heads'], {
    timeoutMs: 10_000,
    maxBytes: GIT_BRANCH_OUTPUT_LIMIT,
  })
  requireProcessSuccess('Git local branch list', result)
  const fields = result.stdout.split('\0')
  const branches: LocalGitBranch[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const name = fields[index].replace(/^\n+|\n+$/g, '')
    if (!name) continue
    if (name.length > 255 || /[\0\r\n]/.test(name)) throw new Error('Git local branch list returned an invalid branch')
    branches.push({ name, current: fields[index + 1].trim() === '*' })
    if (branches.length > GIT_BRANCH_LIMIT) throw new Error('Git local branch list exceeded the safety limit')
  }
  return branches
}

export type GitWorktreeCleanliness =
  | { kind: 'clean' }
  | { kind: 'dirty'; changedPaths: string[]; truncated: boolean }

export type GitBranchChangeResult =
  | { kind: 'applied' }
  | { kind: 'unchanged' }
  | { kind: 'not-found' }
  | { kind: 'already-exists' }
  | Extract<GitWorktreeCleanliness, { kind: 'dirty' }>

async function inspectGitWorktreeCleanAtRoot(repositoryRoot: string, overrides: readonly string[]): Promise<GitWorktreeCleanliness> {
  const result = await runGit(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], {
    timeoutMs: 10_000,
    maxBytes: GIT_STATUS_OUTPUT_LIMIT,
  }, overrides)
  requireProcessSuccess('Git worktree inspection', result)
  if (!result.stdout) return { kind: 'clean' }
  const changedPaths: string[] = []
  let cursor = 0
  while (cursor < result.stdout.length && changedPaths.length < 20) {
    const record = nextNulField(result.stdout, cursor)
    cursor = record.cursor
    if (record.value.length < 4) continue
    changedPaths.push(record.value.slice(3))
    if (record.value[0] === 'R' || record.value[0] === 'C' || record.value[1] === 'R' || record.value[1] === 'C') {
      cursor = nextNulField(result.stdout, cursor).cursor
    }
  }
  return { kind: 'dirty', changedPaths, truncated: cursor < result.stdout.length }
}

export async function inspectGitWorktreeClean(cwd: string): Promise<GitWorktreeCleanliness> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  return inspectGitWorktreeCleanAtRoot(repositoryRoot, filterOverridesFromConfig(await repositoryConfig(repositoryRoot)))
}

async function changeGitBranch(cwd: string, branchValue: unknown, create: boolean): Promise<GitBranchChangeResult> {
  const repositoryRoot = await inspectRepositoryRoot(cwd)
  const branch = await validateGitBranch(repositoryRoot, branchValue)
  const branches = await listLocalGitBranches(repositoryRoot)
  const existing = branches.find((candidate) => candidate.name === branch)
  if (!create && !existing) return { kind: 'not-found' }
  if (create && existing) return { kind: 'already-exists' }
  const overrides = filterOverridesFromConfig(await repositoryConfig(repositoryRoot))
  const cleanliness = await inspectGitWorktreeCleanAtRoot(repositoryRoot, overrides)
  if (cleanliness.kind === 'dirty') return cleanliness
  if (existing?.current) return { kind: 'unchanged' }
  if (overrides.length) throw new Error('Git branch checkout is blocked because this repository configures clean/smudge filters. Use a trusted Git client with the required filter support.')
  const result = await runGit(repositoryRoot, create ? ['switch', '--create', branch] : ['switch', '--no-guess', branch], {
    timeoutMs: 2 * 60_000,
    maxBytes: GIT_BRANCH_OUTPUT_LIMIT,
  }, overrides)
  requireProcessSuccess(create ? 'Git branch creation' : 'Git branch switch', result)
  return { kind: 'applied' }
}

export function switchGitBranch(cwd: string, branchValue: unknown): Promise<GitBranchChangeResult> {
  return changeGitBranch(cwd, branchValue, false)
}

export function createAndSwitchGitBranch(cwd: string, branchValue: unknown): Promise<GitBranchChangeResult> {
  return changeGitBranch(cwd, branchValue, true)
}

export class GitService {
  constructor(
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly authorizeReadOnlyCwd: (cwd: string) => Promise<string> = authorizeCwd,
  ) {}

  /**
   * Entry guard for every repository operation: authorizes and canonicalizes
   * the toplevel, fetches the repository configuration once, derives the
   * filter-neutralizing overrides, and — when the operation names its input
   * paths up front — rejects paths that require clean/smudge filters. The
   * whole call graph of one operation reuses this context instead of
   * re-resolving the toplevel or re-reading the configuration.
   */
  private async withRepositoryGuards(
    cwdValue: unknown,
    paths?: readonly string[],
    options?: { readOnly?: boolean },
  ): Promise<RepositoryContext> {
    const authorizer = options?.readOnly ? this.authorizeReadOnlyCwd : this.authorizeCwd
    const cwd = await this.repositoryCwd(requireString(cwdValue, 'cwd', { min: 1, max: 4096 }), authorizer)
    const config = await repositoryConfig(cwd)
    const overrides = filterOverridesFromConfig(config)
    if (paths?.length) await rejectFilteredPaths(cwd, paths, overrides)
    return { cwd, overrides, config }
  }

  async branch(cwd: string): Promise<string | undefined> {
    try {
      const safeCwd = await this.repositoryCwd(cwd, this.authorizeReadOnlyCwd)
      const result = await runGit(safeCwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
      if (result.code === 0 && !result.timedOut && !result.outputExceeded) return result.stdout.trim() || undefined
      const detached = await runGit(safeCwd, ['rev-parse', '--verify', '--short', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
      return detached.code === 0 && !detached.timedOut && !detached.outputExceeded ? `HEAD (${detached.stdout.trim()})` : undefined
    } catch { return undefined }
  }

  async status(cwdValue: unknown): Promise<GitStatus> {
    try {
      const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, undefined, { readOnly: true })
      const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
      requireProcessSuccess('Git status', statusResult)
      await rejectFilteredPaths(cwd, [...changedPathStatesFromStatus(statusResult.stdout).keys()], overrides)
      const [unstagedResult, stagedResult] = await Promise.all([
        runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--numstat', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides),
        runGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--cached', '--numstat', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides),
      ])
      requireProcessSuccess('Git unstaged statistics', unstagedResult)
      requireProcessSuccess('Git staged statistics', stagedResult)
      return parseStatus(statusResult.stdout, parseNumstat(stagedResult.stdout), parseNumstat(unstagedResult.stdout))
    } catch (error) {
      const message = errorMessage(error).slice(0, GIT_ERROR_LIMIT)
      // Only a genuine "not a repository" detection may claim there is no repo.
      // Every other failure (authorization, filter guard, timeout, output limit)
      // reports a repo whose status could not be read.
      if (isNotARepositoryFailure(error)) return { isRepo: false, files: [], error: message || 'Not a Git repository' }
      return { isRepo: true, files: [], error: message || 'Git status failed' }
    }
  }

  async diff(cwdValue: unknown, pathValue?: unknown, stagedValue?: unknown): Promise<GitDiff> {
    const path = pathValue === undefined ? undefined : requireGitPath(pathValue)
    if (stagedValue !== undefined && typeof stagedValue !== 'boolean') throw new TypeError('staged must be a boolean')
    const staged = stagedValue === true
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all']
    if (staged) args.push('--cached')
    if (path) args.push('--', path)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, path ? [path] : undefined, { readOnly: true })
    if (!path) {
      const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
      requireProcessSuccess('Git status', statusResult)
      await rejectFilteredPaths(cwd, [...changedPathStatesFromStatus(statusResult.stdout).keys()], overrides)
    }
    const result = await runGit(cwd, args, { timeoutMs: 30_000, maxBytes: GIT_DIFF_OUTPUT_LIMIT }, overrides)
    if (result.outputExceeded) {
      const error = `Diff output exceeded ${GIT_DIFF_OUTPUT_LIMIT / (1024 * 1024)} MiB and was not displayed.`
      return { path, staged, text: `[GooeyPi: ${error}]`, truncated: true, error }
    }
    requireProcessSuccess('Git diff', result)
    const capped = capDiffLines(result.stdout)
    const error = capped.truncated ? `Diff exceeded ${GIT_DIFF_LINE_LIMIT.toLocaleString('en-US')} lines and was truncated.` : undefined
    return { path, staged, text: capped.text, truncated: capped.truncated, error }
  }

  async stage(cwd: unknown, paths: unknown): Promise<boolean> {
    return this.mutate(cwd, paths, ['add'])
  }

  async unstage(cwdValue: unknown, pathsValue: unknown): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue)
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 }, overrides)
    if (head.timedOut || head.outputExceeded || (head.code !== 0 && head.code !== 1)) requireProcessSuccess('Git HEAD inspection', head)
    const args = head.code === 0
      ? ['restore', '--staged', '--', ...paths]
      : ['rm', '--cached', '--ignore-unmatch', '-r', '-f', '--', ...paths]
    const result = await runGit(cwd, args, { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
    requireProcessSuccess('Git unstage', result)
    return true
  }

  async restore(cwdValue: unknown, pathsValue: unknown): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, paths)
    const statusResult = await runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all', '-z'], { timeoutMs: 15_000, maxBytes: GIT_STATUS_OUTPUT_LIMIT }, overrides)
    requireProcessSuccess('Git status', statusResult)
    const states = changedPathStatesFromStatus(statusResult.stdout)
    const selectedStates = paths.map((path) => states.get(path))
    if (selectedStates.some((state) => !state)) throw new Error('Git restore refused because the selected path has no pending changes')
    const restorePaths = [...new Set(selectedStates.flatMap((state) => state!.restorePaths))]
    await rejectFilteredPaths(cwd, restorePaths, overrides)
    const untracked = restorePaths.filter((path) => states.get(path)?.untracked === true)
    const tracked = restorePaths.filter((path) => !untracked.includes(path))
    const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs: 5_000, maxBytes: 64 * 1024 }, overrides)
    if (head.code !== 0 && head.code !== 1) requireProcessSuccess('Git HEAD inspection', head)
    if (head.code === 0) {
      if (tracked.length) {
        const result = await runGit(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
        requireProcessSuccess('Git restore', result)
      }
    } else if (tracked.length) {
      const result = await runGit(cwd, ['rm', '--cached', '--ignore-unmatch', '-r', '-f', '--', ...tracked], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
      requireProcessSuccess('Git restore', result)
    }
    const pathsToClean = head.code === 0 ? untracked : restorePaths
    if (pathsToClean.length) {
      const result = await runGit(cwd, ['clean', '-f', '--', ...pathsToClean], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
      requireProcessSuccess('Git clean', result)
    }
    return true
  }

  async commit(cwdValue: unknown, messageValue: unknown): Promise<ProcessOutcome> {
    const message = requireString(messageValue, 'commit message', { min: 1, max: 20_000, trim: true })
    // No rejectFilteredPaths here on purpose: commit records already-staged
    // index content and never runs clean/smudge filters — the mutations that
    // feed the index (stage/restore/unstage) are the filter-guarded surface.
    const context = await this.withRepositoryGuards(cwdValue)
    const overrides = [...context.overrides, ...await commitIdentityOverrides(context.cwd, context.config)]
    const result = await runGit(context.cwd, ['commit', '--no-verify', '--no-gpg-sign', '--no-status', '-m', message], { timeoutMs: 2 * 60_000, maxBytes: 64 * 1024 }, overrides)
    if (result.outputExceeded) return { ok: false, reason: 'overflow', output: 'Git commit output exceeded the safety limit; the commit result is unknown. Refresh status before retrying.' }
    if (result.timedOut) return { ok: false, reason: 'timeout', output: 'Git commit timed out; the commit result is unknown. Refresh status before retrying.' }
    const output = stripAnsi(`${result.stdout}${result.stderr}`).trim()
    if (result.code !== 0) return { ok: false, reason: 'exit', output: output || processError('Git commit', result).message }
    return { ok: true, output: output || 'Commit created.' }
  }

  private async repositoryCwd(
    value: string,
    authorizer: (cwd: string) => Promise<string> = this.authorizeCwd,
  ): Promise<string> {
    const cwd = await authorizer(value)
    const result = await runGit(cwd, ['rev-parse', '--show-toplevel'], { timeoutMs: 5_000, maxBytes: 64 * 1024 })
    requireProcessSuccess('Git repository root inspection', result)
    const repositoryRoot = result.stdout.trim()
    if (!repositoryRoot) throw new Error('Git repository root inspection returned no path')
    return authorizer(repositoryRoot)
  }

  private validPaths(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new TypeError('paths must be a non-empty array of at most 500 paths')
    return value.map((path, index) => requireGitPath(path, `paths[${index}]`))
  }

  private async mutate(cwdValue: unknown, pathsValue: unknown, command: string[]): Promise<boolean> {
    const paths = this.validPaths(pathsValue)
    const { cwd, overrides } = await this.withRepositoryGuards(cwdValue, paths)
    const result = await runGit(cwd, [...command, '--', ...paths], { timeoutMs: 30_000, maxBytes: 1024 * 1024 }, overrides)
    requireProcessSuccess(`Git ${command[0]}`, result)
    return true
  }
}
