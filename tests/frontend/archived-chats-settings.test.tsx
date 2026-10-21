// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArchivedChatsSettings } from '../../src/pages/settings/ArchivedChatsSettings'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project', harness: 'prime', name: 'Gooey Pi', path: '/workspace/gooey-pi', folders: ['/workspace/gooey-pi'],
  primaryFolder: '/workspace/gooey-pi', pinned: false, createdAt: '2026-01-01T00:00:00.000Z',
  lastOpenedAt: '2026-01-01T00:00:00.000Z', sessionCount: 2,
}

function archivedSession(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'session', harness: 'prime', filePath: '/sessions/session.jsonl', projectPath: project.path,
    title: 'Archived chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
    status: 'idle', depth: 0, archived: true, ...overrides,
  }
}

const older = archivedSession({ id: 'older', filePath: '/sessions/older.jsonl', title: 'Older chat', updatedAt: '2026-01-01T00:00:00.000Z' })
const newer = archivedSession({ id: 'newer', filePath: '/sessions/newer.jsonl', title: 'Newer chat', updatedAt: '2026-03-04T00:00:00.000Z' })
const orphaned = archivedSession({
  id: 'orphan', filePath: '/sessions/orphan.jsonl', title: 'Detached chat', projectPath: '/workspace/deleted-repo',
  updatedAt: '2026-02-02T00:00:00.000Z',
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(props: { archived: SessionRecord[]; projects?: ProjectRecord[]; onRestore?: (session: SessionRecord) => Promise<void> | void }) {
  await act(async () => {
    root.render(<ArchivedChatsSettings archived={props.archived} projects={props.projects ?? [project]} onRestore={props.onRestore ?? vi.fn()} />)
  })
}

async function click(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

const rows = () => [...container.querySelectorAll('.settings-row')]
const restoreButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.settings-row button')]

describe('archived chats settings', () => {
  it('lists archived chats newest first with their project and a restore action', async () => {
    await render({ archived: [older, newer] })

    expect(container.querySelector('h1')?.textContent).toBe('Archived chats')
    expect(container.querySelector('.settings-group h2')?.textContent).toBe('2 archived chats')
    expect(rows().map((row) => row.querySelector('strong')?.textContent)).toEqual(['Newer chat', 'Older chat'])
    expect(rows()[0]?.textContent).toContain('Gooey Pi')
    expect(restoreButtons()).toHaveLength(2)
  })

  it('labels a chat whose project is no longer in the sidebar by its folder name', async () => {
    await render({ archived: [orphaned] })
    expect(rows()[0]?.textContent).toContain('deleted-repo')
  })

  it('restores the chat the user chose', async () => {
    const onRestore = vi.fn(async () => undefined)
    await render({ archived: [older, newer], onRestore })

    await click(restoreButtons()[1]!)
    expect(onRestore).toHaveBeenCalledOnce()
    expect(onRestore).toHaveBeenCalledWith(older)
    expect(restoreButtons()[1]?.disabled).toBe(false)
  })

  it('disables every restore control while one restore is in flight', async () => {
    let release: () => void = () => undefined
    const onRestore = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    await render({ archived: [older, newer], onRestore })

    await act(async () => { restoreButtons()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onRestore).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Restoring…')
    expect(restoreButtons().every((button) => button.disabled)).toBe(true)

    await act(async () => { release(); await Promise.resolve() })
    expect(container.textContent).not.toContain('Restoring…')
    expect(restoreButtons().every((button) => button.disabled)).toBe(false)
  })

  it('reports a restore that the main process rejects', async () => {
    const onRestore = vi.fn(async () => { throw new Error('archive bridge offline') })
    await render({ archived: [older], onRestore })

    await click(restoreButtons()[0]!)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('archive bridge offline')
    expect(restoreButtons()[0]?.disabled).toBe(false)
  })

  it('explains the empty state when nothing has been archived', async () => {
    await render({ archived: [] })
    expect(container.querySelector('.settings-group h2')?.textContent).toBe('0 archived chats')
    expect(container.querySelector('.settings-empty')?.textContent).toContain('Nothing archived yet')
    expect(rows()).toHaveLength(0)
  })
})
