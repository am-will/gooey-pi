// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectRunControl } from '../../src/components/ProjectRunControl'
import type { ProjectRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const project: ProjectRecord = {
  id: 'project-1',
  harness: 'prime',
  name: 'GooeyPi',
  path: '/repo',
  folders: ['/repo'],
  primaryFolder: '/repo',
  pinned: false,
  createdAt: '2026-08-23T00:00:00.000Z',
  lastOpenedAt: '2026-08-23T00:00:00.000Z',
  sessionCount: 0,
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('ProjectRunControl', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })
  it('opens configuration and focuses the run command when Play has no command', async () => {
    act(() => root.render(<ProjectRunControl project={project} onRun={vi.fn()} onStop={vi.fn()} onSave={vi.fn()} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Run project"]')?.click())
    await act(async () => { await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())) })

    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector<HTMLTextAreaElement>('[placeholder="npm run dev"]'))
  })

  it('runs the saved command and changes the primary action to Stop while active', () => {
    const onRun = vi.fn()
    const onStop = vi.fn()
    const configured = { ...project, scripts: { setup: '', run: 'npm run dev' } }
    act(() => root.render(<ProjectRunControl project={configured} onRun={onRun} onStop={onStop} onSave={vi.fn()} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Run project"]')?.click())
    expect(onRun).toHaveBeenCalledWith('run')

    act(() => root.render(<ProjectRunControl project={configured} activeKind="run" onRun={onRun} onStop={onStop} onSave={vi.fn()} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Stop run script"]')?.click())
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('saves both commands from the shared dropdown', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    act(() => root.render(<ProjectRunControl project={project} onRun={vi.fn()} onStop={vi.fn()} onSave={onSave} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Configure project scripts"]')?.click())
    const fields = container.querySelectorAll<HTMLTextAreaElement>('textarea')
    await act(async () => {
      setTextareaValue(fields[0], 'npm install')
      setTextareaValue(fields[1], 'npm run dev')
    })
    await act(async () => container.querySelector<HTMLButtonElement>('footer .button--primary')?.click())

    expect(onSave).toHaveBeenCalledWith({ setup: 'npm install', run: 'npm run dev' })
  })

  it.each([
    [{ setupLastRun: 'npm install', setupLastExitCode: 0 }, 'Setup completed', 'is-success'],
    [{ setupLastRun: 'npm install', setupLastExitCode: 2 }, 'Setup exited with code 2', 'is-error'],
    [{ setupLastRun: 'npm install' }, 'Setup did not finish', ''],
  ])('shows the setup status for %j', (state, text, statusClass) => {
    const configured = { ...project, scripts: { setup: 'npm install', run: 'npm run dev', ...state } }
    act(() => root.render(<ProjectRunControl project={configured} onRun={vi.fn()} onStop={vi.fn()} onSave={vi.fn()} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Configure project scripts"]')?.click())

    const status = container.querySelector('.project-run-menu__status')
    expect(status?.textContent).toContain(text)
    if (statusClass) expect(status?.classList.contains(statusClass)).toBe(true)
    else expect(status?.classList.contains('is-error')).toBe(false)
  })
})
