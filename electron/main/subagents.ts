import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { ChildHistoryPage, ChildRoster, ChildSession, SessionStatus } from '../../src/types/api'
import { branchSummaryTranscriptDialect } from './sessions/bucketed'
import { renderTranscriptLines, textFromContent } from './sessions/transcript'
import { isRecord, requireRecord, requireString } from './validation'

const PAGE_BYTES = 1024 * 1024
const PAGE_RECORDS = 200
const MAX_CHILDREN = 128
const MAX_DEPTH = 8
interface Child { handle: string; path: string; parentId?: string; name: string }
interface Scope { owner: number; parent: string; identity: string; root: string; children: Map<string, Child> }
interface Cursor { scope: Scope; child: Child; offset: number; identity: string }
interface Dependencies {
  authorizeParent(path: unknown): Promise<string>
  liveRoster(path: string): Promise<unknown>
}
interface Window { lines: string[]; start: number; end: number; truncated: boolean }

/** OMP 18.12 persists descendants at <parent-stem>/<child>.jsonl, recursively. */
export class OmpChildService {
  private readonly scopes = new Map<string, Scope>()
  private readonly cursors = new Map<string, Cursor>()
  constructor(private readonly dependencies: Dependencies) {}

  revoke(owner: number): void {
    for (const [key, scope] of this.scopes) if (scope.owner === owner) this.scopes.delete(key)
    for (const [key, cursor] of this.cursors) if (cursor.scope.owner === owner) this.cursors.delete(key)
  }

  async list(owner: number, parentValue: unknown): Promise<ChildRoster> {
    const scope = await this.scope(owner, parentValue)
    const children: ChildSession[] = []
    let truncated = false
    let inspected = 0
    let live: unknown
    try { live = await this.dependencies.liveRoster(scope.parent) } catch { /* Persisted children remain readable after runtime exit. */ }
    const snapshots = isRecord(live) && Array.isArray(live.subagents) ? live.subagents.slice(0, MAX_CHILDREN) : []
    const visit = async (directory: string, parentId: string | undefined, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH) { truncated = true; return }
      try {
        await this.safeDirectory(scope, directory)
        const directoryHandle = await opendir(directory)
        const descendants: Child[] = []
        for await (const entry of directoryHandle) {
          if (++inspected > 2048 || children.length >= MAX_CHILDREN) { truncated = true; break }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('.') || entry.name.includes('.bak') || entry.name.startsWith('__advisor')) continue
          const path = join(directory, entry.name)
          try {
            const file = await this.openChild(scope, path)
            try {
              const info = await file.stat()
              let child = scope.children.get(path)
              if (!child) {
                child = { handle: randomUUID(), path, parentId, name: basename(entry.name, '.jsonl') }
                scope.children.set(path, child)
              }
              const prefix = await readWindow(file, 0, Math.min(info.size, 64 * 1024), 'newer')
              let title = child.name
              let task: string | undefined
              for (const line of prefix.lines) {
                let value: unknown
                try { value = JSON.parse(line) } catch { continue }
                if (!isRecord(value)) continue
                if (value.type === 'title' && typeof value.title === 'string' && value.title.trim()) title = value.title.slice(0, 200)
                if (!task && value.type === 'message' && isRecord(value.message) && value.message.role === 'user') task = textFromContent(value.message.content, 1000)
              }
              const snapshot = snapshots.find((value) => isRecord(value) && value.sessionFile === path)
              const status = isRecord(snapshot) ? liveStatus(snapshot.status) : 'unknown'
              if (isRecord(snapshot) && typeof snapshot.task === 'string') task = snapshot.task.slice(0, 1000)
              if (isRecord(snapshot) && typeof snapshot.agent === 'string' && title === child.name) title = snapshot.agent.slice(0, 200)
              children.push({ id: child.handle, parentId, title, status, task, updatedAt: info.mtime.toISOString() })
              descendants.push(child)
            } finally { await file.close() }
          } catch { /* Ignore a disappeared, unreadable, or untrusted artifact. */ }
        }
        for (const child of descendants) {
          if (children.length >= MAX_CHILDREN) { truncated = true; break }
          await visit(child.path.slice(0, -6), child.handle, depth + 1)
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') truncated = true
      }
    }
    await visit(scope.root, undefined, 1)
    // Bound retained handles too, while keeping IDs stable across ordinary refreshes.
    const found = new Set(children.map((child) => child.id))
    for (const [path, child] of scope.children) if (!found.has(child.handle)) scope.children.delete(path)
    return { supported: true, children, truncated }
  }

  async history(owner: number, parentValue: unknown, childValue: unknown, optionsValue: unknown): Promise<ChildHistoryPage> {
    const scope = await this.scope(owner, parentValue)
    const id = requireString(childValue, 'childId', { min: 1, max: 100 })
    const child = [...scope.children.values()].find((value) => value.handle === id)
    if (!child) throw new TypeError('Unknown child for this parent')
    const options = optionsValue === undefined ? {} : requireRecord(optionsValue, 'options')
    const direction = options.direction ?? 'newer'
    if (direction !== 'older' && direction !== 'newer') throw new TypeError('Invalid history direction')
    const token = options.cursor === undefined ? undefined : requireString(options.cursor, 'cursor', { min: 1, max: 100 })
    const cursor = token === undefined ? undefined : this.cursors.get(token)
    if (token && (!cursor || cursor.scope !== scope || cursor.child !== child)) throw new TypeError('Invalid child history cursor')
    let file: FileHandle
    try { file = await this.openChild(scope, child.path) } catch { throw new TypeError('Untrusted child transcript; refresh the child list') }
    try {
      const info = await file.stat()
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
      const reset = Boolean(cursor && (cursor.identity !== identity || cursor.offset > info.size))
      const offset = cursor && !reset ? cursor.offset : info.size
      const page = !cursor || reset || direction === 'older'
        ? await readWindow(file, Math.max(0, offset - PAGE_BYTES), offset, 'older')
        : await readWindow(file, offset, Math.min(info.size, offset + PAGE_BYTES), 'newer')
      const lines = async function* (): AsyncGenerator<string> { yield* page.lines }
      const messages = await renderTranscriptLines(lines(), false, branchSummaryTranscriptDialect())
      return {
        messages, reset, truncated: page.truncated,
        olderCursor: page.start > 0 ? this.cursor({ scope, child, offset: page.start, identity }) : undefined,
        newerCursor: this.cursor({ scope, child, offset: page.end, identity }),
      }
    } finally { await file.close() }
  }

  private cursor(value: Cursor): string {
    for (const [token, cursor] of this.cursors) {
      if (cursor.scope === value.scope && cursor.child === value.child && cursor.identity === value.identity && cursor.offset === value.offset) return token
    }
    const token = randomUUID()
    this.cursors.set(token, value)
    while (this.cursors.size > 2048) {
      const oldest = this.cursors.keys().next().value
      if (oldest !== undefined) this.cursors.delete(oldest)
    }
    return token
  }

  private async scope(owner: number, value: unknown): Promise<Scope> {
    const parent = await this.dependencies.authorizeParent(value)
    if (!parent.endsWith('.jsonl')) throw new TypeError('Invalid parent session')
    const key = `${owner}:${parent}`
    const info = await lstat(parent)
    if (!info.isFile()) throw new TypeError('Invalid parent session')
    const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`
    let scope = this.scopes.get(key)
    if (scope && scope.identity !== identity) {
      for (const [token, cursor] of this.cursors) if (cursor.scope === scope) this.cursors.delete(token)
      scope = undefined
    }
    if (!scope) {
      scope = { owner, parent, identity, root: parent.slice(0, -6), children: new Map() }
      this.scopes.set(key, scope)
      while (this.scopes.size > 64) {
        const oldest = this.scopes.keys().next().value
        if (oldest !== undefined) {
          const evicted = this.scopes.get(oldest)
          this.scopes.delete(oldest)
          for (const [token, cursor] of this.cursors) if (cursor.scope === evicted) this.cursors.delete(token)
        }
      }
    }
    return scope
  }

  private async safeDirectory(scope: Scope, directory: string): Promise<void> {
    const parts = relative(scope.root, directory).split(sep).filter(Boolean)
    if (parts.some((part) => part === '..') || directory !== scope.root && !directory.startsWith(`${scope.root}${sep}`)) throw new TypeError('Invalid child directory')
    let current = scope.root
    for (let i = 0; i <= parts.length; i += 1) {
      const info = await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) throw new TypeError('Untrusted child directory')
      if (i < parts.length) current = join(current, parts[i])
    }
  }

  private async openChild(scope: Scope, path: string): Promise<FileHandle> {
    await this.safeDirectory(scope, dirname(path))
    const expected = await lstat(path)
    if (!expected.isFile() || expected.isSymbolicLink()) throw new TypeError('Untrusted child transcript')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const actual = await file.stat()
      const current = await lstat(path)
      if (current.dev !== actual.dev || current.ino !== actual.ino || !actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || await realpath(path) !== path) throw new TypeError('Child transcript changed during read')
      return file
    } catch (error) { await file.close(); throw error }
  }
}

function liveStatus(value: unknown): SessionStatus {
  switch (value) {
    case 'running': case 'started': case 'pending': return 'running'
    case 'completed': return 'complete'
    case 'failed': case 'aborted': return 'failed'
    default: return 'unknown'
  }
}

async function readWindow(file: FileHandle, start: number, end: number, direction: 'older' | 'newer'): Promise<Window> {
  const buffer = Buffer.alloc(Math.max(0, end - start))
  const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
  const data = buffer.subarray(0, bytesRead)
  let first = 0
  if (start > 0) {
    const previous = Buffer.alloc(1)
    await file.read(previous, 0, 1, start - 1)
    if (previous[0] !== 10) {
      const boundary = data.indexOf(10)
      first = boundary < 0 ? data.length : boundary + 1
    }
  }
  const records: Array<{ text: string; start: number; end: number }> = []
  let offset = first
  let recordCount = 0
  for (let i = first; i < data.length; i += 1) {
    if (data[i] !== 10) continue
    const record = { text: data.subarray(offset, i).toString('utf8'), start: start + offset, end: start + i + 1 }
    records[recordCount % PAGE_RECORDS] = record
    recordCount += 1
    offset = i + 1
    if (direction === 'newer' && recordCount >= PAGE_RECORDS) break
  }
  const pivot = recordCount > PAGE_RECORDS ? recordCount % PAGE_RECORDS : 0
  const selected = [...records.slice(pivot), ...records.slice(0, pivot)]
  // A record larger than the byte budget is skipped explicitly, so paging never stalls.
  const skipped = records.length === 0 && bytesRead === PAGE_BYTES
  return {
    lines: selected.map((record) => record.text),
    start: selected[0]?.start ?? start,
    end: selected.at(-1)?.end ?? (skipped ? start + bytesRead : start),
    truncated: first > 0 || skipped,
  }
}
