// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { CheckoutCatalog, GitWorktree } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const worktrees: GitWorktree[] = [
  { path: '/repo', name: 'repo', branch: 'main', head: 'abc123', current: true, detached: false },
  { path: '/repo-feature', name: 'repo-feature', branch: 'feature/picker', head: 'def456', current: false, detached: false },
]
const worktreeCatalog: CheckoutCatalog = { strategy: 'worktree', activePath: '/repo', checkouts: worktrees }

function props(overrides: Record<string, unknown> = {}) {
  return {
    busy: false,
    model: '',
    effort: 'medium' as const,
    modelsByProvider: new Map(),
    providers: [],
    reasoningLevels: ['medium' as const],
    fast: false,
    fastSupported: false,
    fastAvailable: false,
    imageInputSupported: true,
    skills: [],
    checkoutCatalog: worktreeCatalog,
    onExecuteCheckout: vi.fn(),
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    onFastChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...overrides,
  }
}

describe('composer worktree picker', () => {
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
    window.sessionStorage.clear()
  })

  it('does not expose an automatic model choice before the catalog loads', () => {
    act(() => root.render(<Composer {...props()} />))

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Model: No model available"]')
    expect(trigger?.textContent).toContain('No model available')
    expect(trigger?.disabled).toBe(true)
  })

  it('shows the checkout name instead of a generic Workspace label before the catalog loads', () => {
    act(() => root.render(<Composer {...props({ checkoutCatalog: undefined, checkoutLabel: 'feature/current' })} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Checkout: feature/current"]')
    expect(trigger?.textContent).toContain('feature/current')
    expect(trigger?.textContent).not.toBe('Workspace')
  })

  it('shows the active branch and switches to another worktree', async () => {
    const onExecuteCheckout = vi.fn()
    act(() => root.render(<Composer {...props({ onExecuteCheckout })} />))

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Checkout: main"]')
    expect(trigger).not.toBeNull()
    expect(container.textContent).not.toContain('Local')
    act(() => trigger?.click())

    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    expect(options).toHaveLength(2)
    expect(options[0].getAttribute('aria-checked')).toBe('true')
    expect(options[1].textContent).toContain('feature/picker')
    expect(options[1].textContent).toContain('/repo-feature')

    await act(async () => options[1].click())
    expect(onExecuteCheckout).toHaveBeenCalledWith({ strategy: 'worktree', operation: 'open', path: '/repo-feature' })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('creates a worktree from an inline branch form', async () => {
    const onExecuteCheckout = vi.fn().mockResolvedValue(undefined)
    act(() => root.render(<Composer {...props({ onExecuteCheckout })} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Checkout: main"]')?.click())

    const input = container.querySelector<HTMLInputElement>('[placeholder="New branch name"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, 'feature/new-picker')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const form = input.closest('form')!
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(onExecuteCheckout).toHaveBeenCalledWith({ strategy: 'worktree', operation: 'create', branch: 'feature/new-picker' })
    expect(container.querySelector('[role="menu"]')).toBeNull()
  })

  it('switches local branches without showing checkout folders', () => {
    const onExecuteCheckout = vi.fn()
    const checkoutCatalog: CheckoutCatalog = {
      strategy: 'branch',
      activeName: 'main',
      checkouts: [{ name: 'main', current: true }, { name: 'feature/local', current: false }],
    }
    act(() => root.render(<Composer {...props({ checkoutCatalog, onExecuteCheckout })} />))
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Checkout: main"]')?.click())

    expect(container.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('Git branches')
    expect(container.textContent).not.toContain('/repo')
    const options = container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    act(() => options[1].click())
    expect(onExecuteCheckout).toHaveBeenCalledWith({ strategy: 'branch', operation: 'switch', branch: 'feature/local' })
  })

  it('restores an unsent draft and model after the composer remounts', async () => {
    act(() => root.render(<Composer {...props({ draftKey: 'project:new', model: 'openai:chosen' })} />))
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Keep this prompt')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => root.unmount())
    root = createRoot(container)
    const onModelChange = vi.fn()
    act(() => root.render(<Composer {...props({ draftKey: 'project:new', model: '', onModelChange })} />))
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt')
    expect(onModelChange).toHaveBeenCalledWith('openai:chosen')
  })
})
