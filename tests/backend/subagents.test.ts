import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OmpChildService } from '../../electron/main/subagents'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
function record(id: string, parentId: string | null, role: string, content: unknown, extra = {}): string {
  return `${JSON.stringify({ type: 'message', id, parentId, message: { role, content, ...extra } })}\n`
}
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gooeypi-children-')))
  directories.push(dir)
  const parent = join(dir, 'parent.jsonl')
  const root = join(dir, 'parent')
  await writeFile(parent, '{"type":"session","id":"parent"}\n')
  await mkdir(root)
  const child = join(root, 'worker.jsonl')
  await writeFile(child, '{"type":"session","id":"worker"}\n' + record('u', null, 'user', 'Do the task'))
  const authorizeParent = vi.fn(async (path: unknown) => {
    if (path !== parent) throw new TypeError('Unauthorized parent')
    return parent
  })
  const liveRoster = vi.fn(async (): Promise<unknown> => undefined)
  const service = new OmpChildService({ authorizeParent, liveRoster })
  const roster = await service.list(1, parent)
  if (!roster.supported || !roster.children[0]) throw new Error('Missing fixture child')
  return { dir, parent, root, child, service, id: roster.children[0].id, authorizeParent, liveRoster }
}

describe('authorized OMP child observation', () => {
  it('discovers nested persisted children without exposing paths or unrelated directories', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'worker'))
    await writeFile(join(f.root, 'worker', 'grandchild.jsonl'), record('g', null, 'user', 'Nested assignment'))
    await mkdir(join(f.root, 'unrelated'))
    await writeFile(join(f.root, 'unrelated', 'hidden.jsonl'), record('x', null, 'user', 'Unrelated'))
    const roster = await f.service.list(1, f.parent)
    expect(roster).toMatchObject({ supported: true, truncated: false, children: [
      { id: f.id, title: 'worker', task: 'Do the task', status: 'unknown' },
      { parentId: f.id, task: 'Nested assignment' },
    ] })
    expect(JSON.stringify(roster)).not.toContain(f.dir)
  })

  it('uses only matching live snapshot metadata and keeps completed transcripts after runtime exit', async () => {
    const f = await fixture()
    f.liveRoster.mockResolvedValue({ subagents: [{ id: 'worker', sessionFile: f.child, agent: 'Reviewer', status: 'running', task: 'Review changes' }] })
    expect(await f.service.list(1, f.parent)).toMatchObject({ children: [{ id: f.id, title: 'Reviewer', status: 'running', task: 'Review changes' }] })
    f.liveRoster.mockRejectedValue(new Error('Runtime closed'))
    expect(await f.service.list(1, f.parent)).toMatchObject({ children: [{ id: f.id, status: 'unknown' }] })
    expect((await f.service.history(1, f.parent, f.id, undefined)).messages[0]?.parts).toEqual([{ type: 'text', text: 'Do the task' }])
  })

  it('rechecks parent authorization for every list and history read', async () => {
    const f = await fixture()
    f.authorizeParent.mockRejectedValue(new TypeError('Revoked'))
    await expect(f.service.list(1, f.parent)).rejects.toThrow('Revoked')
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Revoked')
  })

  it('rejects child paths, handles from another renderer, and revoked handles', async () => {
    const f = await fixture()
    await expect(f.service.history(1, f.parent, f.child, undefined)).rejects.toThrow('Unknown child')
    await expect(f.service.history(2, f.parent, f.id, undefined)).rejects.toThrow('Unknown child')
    f.service.revoke(1)
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Unknown child')
  })

  it('does not discover symlink files, symlink child directories, or symlink artifact roots', async () => {
    const f = await fixture()
    const secret = join(f.dir, 'secret.jsonl')
    await writeFile(secret, record('s', null, 'user', 'Secret'))
    await symlink(secret, join(f.root, 'link.jsonl'))
    await mkdir(join(f.root, 'worker'))
    await writeFile(join(f.root, 'worker', 'nested.jsonl'), record('n', null, 'user', 'Nested'))
    await rename(join(f.root, 'worker'), join(f.dir, 'outside'))
    await symlink(join(f.dir, 'outside'), join(f.root, 'worker'))
    expect(await f.service.list(1, f.parent)).toMatchObject({ children: [{ id: f.id }] })
    await rename(f.root, join(f.dir, 'moved'))
    await symlink(join(f.dir, 'moved'), f.root)
    expect(await f.service.list(1, f.parent)).toMatchObject({ children: [], truncated: true })
  })

  it('rejects replacing an already-discovered child with a symlink before reading', async () => {
    const f = await fixture()
    await rename(f.child, join(f.dir, 'outside.jsonl'))
    await symlink(join(f.dir, 'outside.jsonl'), f.child)
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Untrusted child')
  })

  it('renders thinking and tool results using the existing transcript normalizer, hiding system prompts', async () => {
    const f = await fixture()
    await appendFile(f.child, record('s', 'u', 'system', 'Private system prompt')
      + JSON.stringify({ type: 'branch_summary', id: 'b', parentId: 's', summary: 'Branch summary' }) + '\n'
      + record('a', 'b', 'assistant', [{ type: 'thinking', thinking: 'Exposed summary' }, { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } }])
      + record('t', 'a', 'toolResult', 'Tool output', { toolCallId: 'call', toolName: 'read' }))
    const page = await f.service.history(1, f.parent, f.id, undefined)
    expect(JSON.stringify(page.messages)).not.toContain('Private system prompt')
    expect(page.messages[1]).toMatchObject({ kind: 'notice', parts: [{ text: 'Branch summary' }] })
    expect(page.messages[2]?.parts).toEqual([
      { type: 'thinking', text: 'Exposed summary' },
      { type: 'toolCall', id: 'call', name: 'read', args: { path: 'a.ts' } },
      { type: 'toolResult', name: 'read', text: 'Tool output', isError: false },
    ])
  })

  it('pages chronologically through all records without duplicates or gaps', async () => {
    const f = await fixture()
    let text = ''
    for (let i = 0; i < 650; i += 1) text += record(`u${i}`, i ? `u${i - 1}` : null, 'user', `Message ${i}`)
    await writeFile(f.child, text)
    let page = await f.service.history(1, f.parent, f.id, undefined)
    let ids = page.messages.map((message) => message.id)
    const newestCursor = page.newerCursor
    while (page.olderCursor) {
      page = await f.service.history(1, f.parent, f.id, { cursor: page.olderCursor, direction: 'older' })
      ids = [...page.messages.map((message) => message.id), ...ids]
    }
    expect(ids).toEqual(Array.from({ length: 650 }, (_, index) => `u${index}`))
    expect((await f.service.history(1, f.parent, f.id, { cursor: newestCursor })).messages).toEqual([])
  })

  it('waits for completed appended JSONL records and then returns them once', async () => {
    const f = await fixture()
    const initial = await f.service.history(1, f.parent, f.id, undefined)
    const next = record('a', 'u', 'assistant', 'Live output')
    await appendFile(f.child, next.slice(0, -1))
    const partial = await f.service.history(1, f.parent, f.id, { cursor: initial.newerCursor })
    expect(partial.messages).toEqual([])
    await appendFile(f.child, '\n')
    const complete = await f.service.history(1, f.parent, f.id, { cursor: partial.newerCursor })
    expect(complete.messages).toMatchObject([{ id: 'a', parts: [{ text: 'Live output' }] }])
    expect((await f.service.history(1, f.parent, f.id, { cursor: complete.newerCursor })).messages).toEqual([])
  })

  it('keeps tool results visible when their call is in an earlier page', async () => {
    const f = await fixture()
    const initial = await f.service.history(1, f.parent, f.id, undefined)
    await appendFile(f.child, record('t', 'u', 'toolResult', 'Output after page boundary', { toolCallId: 'old', toolName: 'bash' }))
    const page = await f.service.history(1, f.parent, f.id, { cursor: initial.newerCursor })
    expect(page.messages).toMatchObject([{ role: 'tool', parts: [{ type: 'toolResult', text: 'Output after page boundary' }] }])
  })

  it('resets history after file shrink or replacement and invalidates handles when the parent is replaced', async () => {
    const f = await fixture()
    const initial = await f.service.history(1, f.parent, f.id, undefined)
    await writeFile(f.child, record('n', null, 'user', 'New'))
    const shrunk = await f.service.history(1, f.parent, f.id, { cursor: initial.newerCursor })
    expect(shrunk).toMatchObject({ reset: true, messages: [{ id: 'n' }] })
    await rename(f.child, `${f.child}.old`)
    await writeFile(f.child, record('r', null, 'user', 'Replacement'))
    expect(await f.service.history(1, f.parent, f.id, { cursor: shrunk.newerCursor })).toMatchObject({ reset: true, messages: [{ id: 'r' }] })
    await rename(f.parent, `${f.parent}.old`)
    await writeFile(f.parent, '{"type":"session","id":"replacement"}\n')
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Unknown child')
  })

  it('rejects forged cursors and cursors belonging to another child', async () => {
    const f = await fixture()
    const page = await f.service.history(1, f.parent, f.id, undefined)
    await writeFile(join(f.root, 'other.jsonl'), record('o', null, 'user', 'Other'))
    const roster = await f.service.list(1, f.parent)
    const other = roster.supported && roster.children.find((child) => child.id !== f.id)
    if (!other) throw new Error('Missing other child')
    await expect(f.service.history(1, f.parent, f.id, { cursor: 'forged' })).rejects.toThrow('Invalid child history cursor')
    await expect(f.service.history(1, f.parent, other.id, { cursor: page.newerCursor })).rejects.toThrow('Invalid child history cursor')
  })

  it('revokes removed children on refresh and rejects parent-crossed handles and cursors', async () => {
    const a = await fixture()
    const b = await fixture()
    const page = await a.service.history(1, a.parent, a.id, undefined)
    a.authorizeParent.mockImplementation(async (path: unknown) => {
      if (path !== a.parent && path !== b.parent) throw new Error('Unauthorized')
      return path
    })
    const roster = await a.service.list(1, b.parent)
    if (!roster.supported || !roster.children[0]) throw new Error('Missing second child')
    await expect(a.service.history(1, b.parent, a.id, undefined)).rejects.toThrow('Unknown child')
    await expect(a.service.history(1, b.parent, roster.children[0].id, { cursor: page.newerCursor })).rejects.toThrow('Invalid child history cursor')
    await rm(a.child)
    await a.service.list(1, a.parent)
    await expect(a.service.history(1, a.parent, a.id, undefined)).rejects.toThrow('Unknown child')
  })

  it('rejects an ancestor symlink installed after nested discovery', async () => {
    const f = await fixture()
    await mkdir(join(f.root, 'worker'))
    await writeFile(join(f.root, 'worker', 'nested.jsonl'), record('n', null, 'user', 'Nested'))
    const roster = await f.service.list(1, f.parent)
    const nested = roster.supported && roster.children.find((child) => child.parentId)
    if (!nested) throw new Error('Missing nested child')
    await rename(join(f.root, 'worker'), join(f.dir, 'moved'))
    await symlink(join(f.dir, 'moved'), join(f.root, 'worker'))
    await expect(f.service.history(1, f.parent, nested.id, undefined)).rejects.toThrow('Untrusted child')
  })

  it('reads an exactly byte-budget-sized record and keeps unchanged cursors stable', async () => {
    const f = await fixture()
    const overhead = Buffer.byteLength(record('exact', null, 'user', ''))
    await writeFile(f.child, record('exact', null, 'user', 'x'.repeat(1024 * 1024 - overhead)))
    const page = await f.service.history(1, f.parent, f.id, undefined)
    expect(page.messages).toMatchObject([{ id: 'exact' }])
    expect(page.truncated).toBe(false)
    const unchanged = await f.service.history(1, f.parent, f.id, { cursor: page.newerCursor })
    expect(unchanged.newerCursor).toBe(page.newerCursor)
    expect(unchanged.messages).toEqual([])
  })

  it('fences a pending parent authorization across revoke and readmission of the same renderer', async () => {
    const f = await fixture()
    let resolveAuthorization: ((value: string) => void) | undefined
    f.authorizeParent.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveAuthorization = resolve }))
    const pending = f.service.list(1, f.parent)
    f.service.revoke(1)
    const fresh = await f.service.list(1, f.parent)
    if (!fresh.supported || !fresh.children[0]) throw new Error('Missing readmitted child')
    expect(fresh.children[0].id).not.toBe(f.id)
    resolveAuthorization?.(f.parent)
    await expect(pending).rejects.toThrow('authorization was revoked')
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Unknown child')
  })

  it('rejects a pending history request after revoke even when the renderer is readmitted', async () => {
    const f = await fixture()
    const page = await f.service.history(1, f.parent, f.id, undefined)
    let release: ((value: string) => void) | undefined
    f.authorizeParent.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const pending = f.service.history(1, f.parent, f.id, { cursor: page.newerCursor })
    f.service.revoke(1)
    await f.service.list(1, f.parent)
    release?.(f.parent)
    await expect(pending).rejects.toThrow('authorization was revoked')
  })

  it('fences a pending live roster across revoke and never restores old handles or cursors', async () => {
    const f = await fixture()
    const page = await f.service.history(1, f.parent, f.id, undefined)
    let resolveRoster: ((value: unknown) => void) | undefined
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    f.liveRoster.mockImplementationOnce(() => new Promise<unknown>((resolve) => { resolveRoster = resolve; entered?.() }))
    const pending = f.service.list(1, f.parent)
    await waiting
    f.service.revoke(1)
    const fresh = await f.service.list(1, f.parent)
    if (!fresh.supported || !fresh.children[0]) throw new Error('Missing readmitted child')
    resolveRoster?.({ subagents: [] })
    await expect(pending).rejects.toThrow('authorization was revoked')
    await expect(f.service.history(1, f.parent, f.id, undefined)).rejects.toThrow('Unknown child')
    await expect(f.service.history(1, f.parent, fresh.children[0].id, { cursor: page.newerCursor })).rejects.toThrow('Invalid child history cursor')
  })

  it('bounds huge records, permits paging past them, and reports skipped content', async () => {
    const f = await fixture()
    const huge = record('huge', 'u', 'assistant', 'x'.repeat(3 * 1024 * 1024))
    await appendFile(f.child, huge + record('after', 'huge', 'user', 'After oversized record'))
    let page = await f.service.history(1, f.parent, f.id, undefined)
    expect(page).toMatchObject({ truncated: true, messages: [{ id: 'after' }] })
    let attempts = 0
    while (page.olderCursor && attempts++ < 8) page = await f.service.history(1, f.parent, f.id, { cursor: page.olderCursor, direction: 'older' })
    expect(attempts).toBeLessThan(8)
    expect(page.messages).toMatchObject([{ id: 'u' }])
  })
})
