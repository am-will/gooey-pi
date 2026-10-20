// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectsPage } from '../../src/pages/ProjectsPage'
import type { HarnessId, ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function project(harness: HarnessId): ProjectRecord {
  return { id: 'project-1', harness, name: 'gooey-pi', path: '/work/gooey-pi', primaryFolder: '/work/gooey-pi', folders: ['/work/gooey-pi'], gitBranch: 'main', sessionCount: 2, createdAt: '2026-10-01T10:00:00.000Z', lastOpenedAt: '2026-10-20T10:00:00.000Z', pinned: false, inferred: false }
}

function renderPage(harness: HarnessId, projects: ProjectRecord[]) {
  act(() => root.render(<ProjectsPage harness={harness} projects={projects} sortMode="recent" onAdd={vi.fn()} onOpen={vi.fn()} onRemove={vi.fn()} onTogglePin={vi.fn()} />))
}

describe('Projects page copy', () => {
  it.each([
    ['prime', 'Prime', 'Prime Work'],
    ['omp', 'OMP', 'OMP Work'],
    ['pi', 'Pi', 'Pi Work'],
  ] as const)('names the active %s harness', (harness, shortName, productName) => {
    renderPage(harness, [])
    expect(container.querySelector('.page-header p')?.textContent).toBe(`Local folders and ongoing work available to ${shortName}.`)
    expect(container.textContent).toContain(`Choose a local folder to start persistent ${shortName} sessions.`)

    renderPage(harness, [project(harness)])
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove gooey-pi"]')
    act(() => remove?.click())
    expect(document.body.textContent).toContain(`Remove “gooey-pi” from ${productName}? The folder and saved ${shortName} sessions will not be deleted.`)
  })
})
