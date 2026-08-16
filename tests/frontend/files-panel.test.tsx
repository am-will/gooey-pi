// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FilesPanel,
  buildTreeFromEntries,
  buildProjectTree,
  filterFileTree,
  flattenVisibleTree,
  collectDirectoryIds,
} from '../../src/components/inspector/FilesPanel'
import type { GitStatus, ProjectFileEntry, ProjectRecord } from '../../src/types/api'

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

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const sampleEntries: ProjectFileEntry[] = [
  { path: 'src', type: 'directory' },
  { path: 'src/components', type: 'directory' },
  { path: 'src/components/chat', type: 'directory' },
  { path: 'src/components/chat/AgentProgress.tsx', type: 'file' },
  { path: 'src/components/chat/ChatPanel.tsx', type: 'file' },
  { path: 'src/components/layout', type: 'directory' },
  { path: 'src/components/layout/AppLayout.tsx', type: 'file' },
  { path: 'src/components/terminal', type: 'directory' },
  { path: 'package.json', type: 'file' },
  { path: 'README.md', type: 'file' },
]

const sampleProject: ProjectRecord = {
  id: 'test-project',
  harness: 'prime',
  name: 'test-project',
  path: '/workspace/test-project',
  folders: ['/workspace/test-project'],
  primaryFolder: '/workspace/test-project',
  pinned: false,
  createdAt: new Date().toISOString(),
  lastOpenedAt: new Date().toISOString(),
  sessionCount: 1,
}

const emptyGit: GitStatus = { isRepo: true, files: [] }

describe('FilesPanel tree building logic', () => {
  it('builds a hierarchical tree with proper depths and ordering', () => {
    const tree = buildTreeFromEntries(sampleEntries, '/workspace/test-project', 0)

    // Top-level should have 'src' (dir), 'package.json' (file), 'README.md' (file)
    // Directories first, then files sorted alphabetically
    expect(tree.map((n) => ({ name: n.name, type: n.type, depth: n.depth }))).toEqual([
      { name: 'src', type: 'directory', depth: 0 },
      { name: 'package.json', type: 'file', depth: 0 },
      { name: 'README.md', type: 'file', depth: 0 },
    ])

    // Inside 'src'
    const srcNode = tree[0]
    expect(srcNode.children.map((n) => ({ name: n.name, type: n.type, depth: n.depth }))).toEqual([
      { name: 'components', type: 'directory', depth: 1 },
    ])

    // Inside 'src/components'
    const componentsNode = srcNode.children[0]
    expect(
      componentsNode.children.map((n) => ({ name: n.name, type: n.type, depth: n.depth })),
    ).toEqual([
      { name: 'chat', type: 'directory', depth: 2 },
      { name: 'layout', type: 'directory', depth: 2 },
      { name: 'terminal', type: 'directory', depth: 2 },
    ])

    // Inside 'src/components/chat'
    const chatNode = componentsNode.children[0]
    expect(
      chatNode.children.map((n) => ({ name: n.name, type: n.type, depth: n.depth })),
    ).toEqual([
      { name: 'AgentProgress.tsx', type: 'file', depth: 3 },
      { name: 'ChatPanel.tsx', type: 'file', depth: 3 },
    ])
  })

  it('creates ancestor directory placeholders if missing from listing', () => {
    const entries: ProjectFileEntry[] = [
      { path: 'a/b/c/deep.txt', type: 'file' },
    ]
    const tree = buildTreeFromEntries(entries, '/root', 0)
    expect(tree.length).toBe(1)
    expect(tree[0].name).toBe('a')
    expect(tree[0].type).toBe('directory')
    expect(tree[0].children[0].name).toBe('b')
    expect(tree[0].children[0].children[0].name).toBe('c')
    expect(tree[0].children[0].children[0].children[0].name).toBe('deep.txt')
    expect(tree[0].children[0].children[0].children[0].depth).toBe(3)
  })

  it('normalizes slashes while preserving backslashes in POSIX filenames', () => {
    const entries: ProjectFileEntry[] = [
      { path: '/src///components/chat/', type: 'directory' },
      { path: '/src///components/chat/AgentProgress.tsx', type: 'file' },
      { path: 'weird\\name.txt', type: 'file' },
    ]
    const tree = buildTreeFromEntries(entries, '/workspace', 0)
    expect(tree.length).toBe(2)
    expect(tree[0].name).toBe('src')
    expect(tree[0].children[0].name).toBe('components')
    expect(tree[0].children[0].children[0].name).toBe('chat')
    expect(tree[0].children[0].children[0].children[0].name).toBe('AgentProgress.tsx')
    expect(tree[0].children[0].children[0].children[0].depth).toBe(3)
    expect(tree[1]).toMatchObject({
      name: 'weird\\name.txt',
      path: 'weird\\name.txt',
      fullPath: '/workspace/weird\\name.txt',
      type: 'file',
      depth: 0,
    })
  })

  it('filters tree nodes keeping matching files and their ancestors', () => {
    const tree = buildTreeFromEntries(sampleEntries, '/workspace/test-project', 0)
    const filtered = filterFileTree(tree, 'AgentProgress')

    expect(filtered.length).toBe(1)
    expect(filtered[0].name).toBe('src')
    expect(filtered[0].children.length).toBe(1)
    expect(filtered[0].children[0].name).toBe('components')
    expect(filtered[0].children[0].children[0].name).toBe('chat')
    expect(filtered[0].children[0].children[0].children[0].name).toBe('AgentProgress.tsx')
  })

  it('flattens visible nodes respecting expanded directories', () => {
    const tree = buildTreeFromEntries(sampleEntries, '/workspace/test-project', 0)
    const allDirIds = collectDirectoryIds(tree)

    // All collapsed by default
    const allCollapsed = flattenVisibleTree(tree, new Set(), false)
    expect(allCollapsed.map((n) => n.name)).toEqual([
      'src',
      'package.json',
      'README.md',
    ])

    // Expand only 'src'
    const srcId = '/workspace/test-project\0src'
    const srcExpanded = flattenVisibleTree(tree, new Set([srcId]), false)
    expect(srcExpanded.map((n) => n.name)).toEqual([
      'src',
      'components',
      'package.json',
      'README.md',
    ])

    // Expand all
    const allVisible = flattenVisibleTree(tree, allDirIds, false)
    expect(allVisible.map((n) => n.name)).toEqual([
      'src',
      'components',
      'chat',
      'AgentProgress.tsx',
      'ChatPanel.tsx',
      'layout',
      'AppLayout.tsx',
      'terminal',
      'package.json',
      'README.md',
    ])
  })

  it('builds multi-root tree with top-level root folders', () => {
    const groups = [
      {
        root: '/workspace/client',
        listing: {
          entries: [{ path: 'App.tsx', type: 'file' as const }],
          skipped: 0,
        },
      },
      {
        root: '/workspace/server',
        listing: {
          entries: [{ path: 'index.ts', type: 'file' as const }],
          skipped: 0,
        },
      },
    ]
    const tree = buildProjectTree(groups, '/workspace/client')
    expect(tree.length).toBe(2)
    expect(tree[0].name).toBe('client')
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children[0].name).toBe('App.tsx')
    expect(tree[0].children[0].depth).toBe(1)
    expect(tree[1].name).toBe('server')
    expect(tree[1].depth).toBe(0)
    expect(tree[1].children[0].name).toBe('index.ts')
    expect(tree[1].children[0].depth).toBe(1)
  })
})

describe('FilesPanel component', () => {
  it('renders empty state when no project is provided', async () => {
    await act(async () => {
      root.render(<FilesPanel git={emptyGit} onReveal={vi.fn()} />)
    })
    expect(container.textContent).toContain('No project files')
    expect(container.textContent).toContain('Choose a local project to inspect files.')
  })

  it('renders files in a hierarchical tree and expands/collapses folders on click', async () => {
    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    const onReveal = vi.fn()
    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={onReveal} />)
      await Promise.resolve()
    })

    expect(listFiles).toHaveBeenCalledWith('/workspace/test-project', 'prime')

    // Root button should show project name
    const treeRoot = container.querySelector('.tree-root')
    expect(treeRoot?.textContent).toContain('test-project')

    // Initially collapsed by default: top-level files and folders only
    const initialItems = [...container.querySelectorAll<HTMLButtonElement>('.file-tree__item')]
    const initialNames = initialItems.map((el) => el.querySelector('.file-tree__name')?.textContent)

    expect(initialNames).toEqual([
      'src',
      'package.json',
      'README.md',
    ])

    // Indentation on top-level
    const srcButton = initialItems[0]
    expect(srcButton.style.paddingLeft).toBe('8px') // depth 0

    // Clicking 'src' expands it -> 'components' appears
    act(() => {
      srcButton.click()
    })

    const afterSrcItems = [...container.querySelectorAll<HTMLButtonElement>('.file-tree__item')]
    const afterSrcNames = afterSrcItems.map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(afterSrcNames).toEqual([
      'src',
      'components',
      'package.json',
      'README.md',
    ])

    const componentsButton = afterSrcItems[1]
    expect(componentsButton.style.paddingLeft).toBe('22px') // depth 1

    // Clicking 'components' expands it -> chat, layout, terminal appear
    act(() => {
      componentsButton.click()
    })

    const afterComponentsItems = [...container.querySelectorAll<HTMLButtonElement>('.file-tree__item')]
    const afterComponentsNames = afterComponentsItems.map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(afterComponentsNames).toEqual([
      'src',
      'components',
      'chat',
      'layout',
      'terminal',
      'package.json',
      'README.md',
    ])

    const chatButton = afterComponentsItems[2]
    expect(chatButton.style.paddingLeft).toBe('36px') // depth 2

    // Clicking 'chat' expands it -> AgentProgress.tsx, ChatPanel.tsx appear
    act(() => {
      chatButton.click()
    })

    const afterChatItems = [...container.querySelectorAll<HTMLButtonElement>('.file-tree__item')]
    const agentProgressButton = afterChatItems[3]
    expect(agentProgressButton.querySelector('.file-tree__name')?.textContent).toBe('AgentProgress.tsx')
    expect(agentProgressButton.style.paddingLeft).toBe('50px') // depth 3

    // Clicking file reveals file
    act(() => {
      agentProgressButton.click()
    })
    expect(onReveal).toHaveBeenCalledWith('/workspace/test-project/src/components/chat/AgentProgress.tsx')

    // Double clicking folder reveals folder
    act(() => {
      componentsButton.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onReveal).toHaveBeenCalledWith('/workspace/test-project/src/components')
  })

  it('displays git modification status for changed files', async () => {
    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    const git: GitStatus = {
      isRepo: true,
      files: [
        { path: 'src/components/chat/AgentProgress.tsx', status: 'M', staged: false, additions: 5, deletions: 2 },
        { path: 'package.json', status: 'A', staged: true, additions: 10, deletions: 0 },
      ],
    }

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={git} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    // Root-level changed file is visible initially
    let statuses = [...container.querySelectorAll('.file-tree__status')].map((el) => el.textContent)
    expect(statuses).toEqual(['A'])

    // Expand all folders to see nested changed file
    const expandAllBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand all folders"]',
    )
    act(() => {
      expandAllBtn?.click()
    })

    statuses = [...container.querySelectorAll('.file-tree__status')].map((el) => el.textContent)
    expect(statuses).toEqual(['M', 'A'])
  })

  it('filters project paths with search input', async () => {
    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    const searchInput = container.querySelector<HTMLInputElement>('.files-search input')!
    await enter(searchInput, 'Progress')

    const filteredNames = [
      ...container.querySelectorAll<HTMLButtonElement>('.file-tree__item'),
    ].map((el) => el.querySelector('.file-tree__name')?.textContent)

    expect(filteredNames).toEqual(['src', 'components', 'chat', 'AgentProgress.tsx'])

    act(() => {
      container.querySelector<HTMLButtonElement>('.file-tree__item.is-directory')?.click()
    })
    await enter(searchInput, '')

    const namesAfterSearch = [
      ...container.querySelectorAll<HTMLButtonElement>('.file-tree__item'),
    ].map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(namesAfterSearch).toEqual(['src', 'package.json', 'README.md'])
  })

  it('displays skipped folder message when skipped > 0', async () => {
    const listFiles = vi.fn(async () => ({
      entries: [{ path: 'App.tsx', type: 'file' as const }],
      skipped: 2,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('2 folders could not be read and were skipped.')
  })

  it('handles collapse all and expand all toolbar actions', async () => {
    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    // Initially all collapsed, toolbar button has label "Expand all folders"
    const expandAllBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand all folders"]',
    )
    expect(expandAllBtn).toBeTruthy()

    act(() => {
      expandAllBtn?.click()
    })

    // Now all 10 nodes are visible
    const expandedNames = [
      ...container.querySelectorAll<HTMLButtonElement>('.file-tree__item'),
    ].map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(expandedNames).toHaveLength(10)

    // Toolbar button changes to "Collapse all folders"
    const collapseAllBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse all folders"]',
    )
    expect(collapseAllBtn).toBeTruthy()

    act(() => {
      collapseAllBtn?.click()
    })

    const collapsedNames = [
      ...container.querySelectorAll<HTMLButtonElement>('.file-tree__item'),
    ].map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(collapsedNames).toEqual(['src', 'package.json', 'README.md'])
  })

  it('renders multi-root project folders in component', async () => {
    const multiProject: ProjectRecord = {
      ...sampleProject,
      folders: ['/workspace/frontend', '/workspace/backend'],
    }

    const listFiles = vi.fn(async (root: string) => {
      if (root.includes('frontend')) {
        return {
          entries: [{ path: 'src/App.tsx', type: 'file' as const }],
          skipped: 0,
        }
      }
      return {
        entries: [{ path: 'src/server.ts', type: 'file' as const }],
        skipped: 0,
      }
    })
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={multiProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.querySelector('.tree-root')?.textContent).toContain('2 project folders')

    // Multi-root starts with root folders collapsed
    const initialNames = [
      ...container.querySelectorAll<HTMLButtonElement>('.file-tree__item'),
    ].map((el) => el.querySelector('.file-tree__name')?.textContent)
    expect(initialNames).toEqual(['frontend', 'backend'])
  })

  it('renders error banner if listFiles fails', async () => {
    const listFiles = vi.fn(async () => {
      throw new Error('Permission denied')
    })
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Unable to list project files: Permission denied')
  })

  it('displays message when search query does not match any file', async () => {
    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={sampleProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    const searchInput = container.querySelector<HTMLInputElement>('.files-search input')!
    await enter(searchInput, 'non-existent-file-name')

    expect(container.textContent).toContain('No files match “non-existent-file-name”.')
  })

  it('lists files for an inferred project discovered from sessions without error', async () => {
    const inferredProject: ProjectRecord = {
      ...sampleProject,
      id: 'inferred-123',
      harness: 'pi',
      inferred: true,
    }

    const listFiles = vi.fn(async () => ({
      entries: sampleEntries,
      skipped: 0,
    }))
    Object.defineProperty(window, 'prime', {
      configurable: true,
      value: { projects: { listFiles } },
    })

    await act(async () => {
      root.render(<FilesPanel project={inferredProject} git={emptyGit} onReveal={vi.fn()} />)
      await Promise.resolve()
    })

    expect(listFiles).toHaveBeenCalledWith('/workspace/test-project', 'pi')
    expect(container.textContent).toContain('test-project')
    expect(container.textContent).toContain('src')
    expect(container.textContent).toContain('package.json')
  })
})
