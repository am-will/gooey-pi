import type { GitFileChange, GitStatus } from '../../src/types/api'
import { requireGitPath } from './validation'

interface Numstat { additions: number; deletions: number }
interface ParsedNumstat { values: Map<string, Numstat>; truncated: boolean }

export const GIT_STATUS_ENTRY_LIMIT = 1_000

export function nextNulField(output: string, cursor: number): { value: string; cursor: number } {
  const end = output.indexOf('\0', cursor)
  if (end < 0) return { value: output.slice(cursor), cursor: output.length }
  return { value: output.slice(cursor, end), cursor: end + 1 }
}

/** Porcelain marks untracked nested repositories with a trailing '/'; strip that directory marker. */
function statusRecordPath(record: string): string {
  const value = record.slice(3)
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function parseNumstat(output: string, maxEntries = GIT_STATUS_ENTRY_LIMIT): ParsedNumstat {
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

export function parseStatus(output: string, staged: ParsedNumstat, unstaged: ParsedNumstat): GitStatus {
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
    const path = statusRecordPath(record)
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

export interface ChangedPathState {
  untracked: boolean
  restorePaths: string[]
  indexRenameSource?: string
}

export function changedPathStatesFromStatus(output: string): Map<string, ChangedPathState> {
  const states = new Map<string, ChangedPathState>()
  let cursor = 0
  while (cursor < output.length) {
    const field = nextNulField(output, cursor)
    cursor = field.cursor
    const record = field.value
    if (!record || record.startsWith('## ') || record.length < 4) continue
    const code = record.slice(0, 2)
    const path = requireGitPath(statusRecordPath(record), 'Git status path')
    const restorePaths = [path]
    let indexRenameSource: string | undefined
    if (code.includes('R') || code.includes('C')) {
      const previous = nextNulField(output, cursor)
      cursor = previous.cursor
      if (previous.value) {
        const source = requireGitPath(previous.value, 'Git status path')
        restorePaths.push(source)
        if (code[0] === 'R') indexRenameSource = source
      }
    }
    states.set(path, { untracked: code === '??', restorePaths, indexRenameSource })
  }
  return states
}
