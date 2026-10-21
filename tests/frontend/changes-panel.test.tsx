// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangesCard } from '../../src/components/ChangesCard'
import { ChangesPanel } from '../../src/components/inspector/ChangesPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
  Reflect.deleteProperty(window, 'prime')
  vi.restoreAllMocks()
})

describe('ChangesPanel status states', () => {
  it('renders the no-repository state without an error banner', async () => {
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: false, files: [], error: 'Not a Git repository' }} onRefreshGit={vi.fn()} />)
    })
    expect(container.textContent).toContain('No Git repository')
    expect(container.textContent).not.toContain('Git status unavailable')
  })

  it('renders a distinct failure state with retry when the repo exists but status failed', async () => {
    const onRefreshGit = vi.fn()
    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [], error: 'Git status timed out; the result is unknown' }} onRefreshGit={onRefreshGit} />)
    })
    expect(container.textContent).toContain('Git status unavailable')
    expect(container.textContent).toContain('Git status timed out')
    expect(container.textContent).not.toContain('No Git repository')
    act(() => { container.querySelector('button')!.click() })
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })
  it('dismisses the file changes card without opening the inspector', async () => {
    const onOpenChanges = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<ChangesCard git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onOpenChanges={onOpenChanges} onClose={onClose} />)
    })

    act(() => { container.querySelector<HTMLButtonElement>('.changes-card__close')!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenChanges).not.toHaveBeenCalled()
  })

  it('confirms undoing the selected file before restoring it', async () => {
    const restore = vi.fn(async () => true)
    const diff = vi.fn(async () => ({ path: 'file.txt', staged: false, text: '', truncated: false }))
    Object.defineProperty(window, 'prime', { configurable: true, value: { git: { diff, restore } } })
    const onRefreshGit = vi.fn(async () => undefined)

    await act(async () => {
      root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }} onRefreshGit={onRefreshGit} />)
      await Promise.resolve()
    })
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('.diff-header button')].find((button) => button.textContent?.includes('Undo changes'))!.click()
    })
    expect(document.body.textContent).toContain('This discards the staged and unstaged changes')

    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('.modal__footer button')].find((button) => button.textContent === 'Undo changes')!.click()
      await Promise.resolve()
    })
    expect(restore).toHaveBeenCalledWith('/project', ['file.txt'])
    expect(onRefreshGit).toHaveBeenCalledTimes(1)
  })

  it('disables mutating controls and offers an explicit grant for read-only projects', async () => {
    const onGrantProject = vi.fn(async () => undefined)
    const git = {
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 },
        { path: 'staged.txt', status: 'M', staged: true, additions: 1, deletions: 0 },
      ],
    }

    await act(async () => {
      root.render(<ChangesPanel git={git} readOnly onGrantProject={onGrantProject} onRefreshGit={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('read-only because it was discovered from session history')
    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)!
    expect(button('Stage').disabled).toBe(true)
    expect(button('Stage all').disabled).toBe(true)
    expect(button('Undo changes').disabled).toBe(true)
    expect(button('Commit').disabled).toBe(true)
    await act(async () => { button('Add project').click(); await Promise.resolve() })
    expect(onGrantProject).toHaveBeenCalledTimes(1)

    act(() => { button('Staged').click() })
    expect(button('Unstage').disabled).toBe(true)
    expect(button('Unstage all').disabled).toBe(true)
  })

  it('keeps mutating controls enabled for persisted projects', async () => {
    const git = {
      isRepo: true,
      branch: 'main',
      files: [
        { path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 },
        { path: 'staged.txt', status: 'M', staged: true, additions: 1, deletions: 0 },
      ],
    }

    await act(async () => {
      root.render(<ChangesPanel git={git} onRefreshGit={vi.fn()} />)
      await Promise.resolve()
      await Promise.resolve()
    })

    const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === label)!
    expect(button('Stage').disabled).toBe(false)
    expect(button('Stage all').disabled).toBe(false)
    expect(button('Undo changes').disabled).toBe(false)
    expect(button('Commit').disabled).toBe(false)
    act(() => { button('Staged').click() })
    expect(button('Unstage').disabled).toBe(false)
    expect(button('Unstage all').disabled).toBe(false)
  })
})


it('refreshes an unchanged selected file on a new Git snapshot without replacing the diff with a spinner', async () => {
  const diff = vi.fn(async () => ({ text: '+before' }))
  Object.defineProperty(window, 'prime', { configurable: true, value: { git: { diff } } })
  const files = [{ path: 'file.txt', status: 'M', staged: false, additions: 1, deletions: 0 }]
  await act(async () => root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files }} onRefreshGit={() => undefined} />))
  expect(container.querySelector('.diff-view')?.textContent).toContain('+before')
  let resolve: ((value: { text: string }) => void) | undefined
  diff.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await act(async () => root.render(<ChangesPanel cwd="/project" git={{ isRepo: true, files: [...files] }} onRefreshGit={() => undefined} />))
  expect(diff).toHaveBeenCalledTimes(2)
  expect(container.querySelector('.diff-view')?.textContent).toContain('+before')
  await act(async () => { resolve?.({ text: '+after' }) })
  expect(container.querySelector('.diff-view')?.textContent).toContain('+after')
})
