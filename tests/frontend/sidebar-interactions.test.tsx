// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Sidebar, areSidebarPropsEqual, type SidebarProps } from '../../src/components/Sidebar'
import type { ProjectRecord, SessionRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const project: ProjectRecord = { id: 'p', harness: 'omp', name: 'Project', path: '/project', folders: ['/project'], primaryFolder: '/project', pinned: false, createdAt: '2026-01-01', lastOpenedAt: '2026-01-01', sessionCount: 1 }
const session: SessionRecord = { id: 'session-id', harness: 'omp', projectPath: '/project', filePath: '/sessions/session.jsonl', title: 'Saved session', createdAt: '2026-01-01', updatedAt: '2026-01-01', status: 'idle', depth: 0 }
const noop = () => undefined
function props(): SidebarProps {
  return { projects: [project], sessions: [session], activeView: 'session', onSelectProject: noop, onSelectSession: noop, onNavigate: noop, onNewSession: noop, onAddProject: noop, onRemoveProject: noop, onClose: noop, onOpenPalette: noop, onRenameSession: async () => undefined, onArchiveSession: async () => undefined }
}
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
async function click(selector: string) {
  const element = host.querySelector(selector)
  if (!element) throw new Error(`Missing ${selector}`)
  await act(async () => { element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
it('clears hidden search filtering when the search box closes', async () => {
  await act(async () => { root.render(<Sidebar {...props()} />) })
  await click('button[title="Search"]')
  const input = host.querySelector('input#session-search')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'no matching chat')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(host.querySelector('.session-row__title')).toBeNull()
  await click('button[title="Search"]')
  expect(host.querySelector('input#session-search')).toBeNull()
  expect(host.querySelector('.session-row__title')?.textContent).toBe('Saved session')
})
it('compares every present prop, including newly introduced optional props', () => {
  const previous = props()
  expect(areSidebarPropsEqual(previous, { ...previous })).toBe(true)
  const future = { ...previous, futureRosterGeneration: 1 }
  expect(areSidebarPropsEqual(previous, future)).toBe(false)
  expect(areSidebarPropsEqual(future, previous)).toBe(false)
  expect(areSidebarPropsEqual(previous, { ...previous, childRoster: { kind: 'loading', parentFile: session.filePath } })).toBe(false)
})

it('keeps menu interaction inside the layer and dismisses outside or on Escape', async () => {
  await act(async () => { root.render(<Sidebar {...props()} />) })
  await click('.session-row__more')
  const menu = host.querySelector('.session-row__menu')!
  await act(async () => { menu.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  expect(host.querySelector('.session-row__menu')).not.toBeNull()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { menu.dispatchEvent(escape) })
  expect(escape.defaultPrevented).toBe(true)
  expect(host.querySelector('.session-row__menu')).toBeNull()
  await click('.session-row__more')
  await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
  expect(host.querySelector('.session-row__menu')).toBeNull()
})
