// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRoleSettings } from '../../src/pages/settings/ModelRoleSettings'
import type { AgentRoleConfig, PrimeModelCatalog, PrimeWorkApi } from '../../src/types/api'

const model = {
  key: 'anthropic/claude-opus-5', provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true,
  input: ['text'] as const, contextWindow: 1_000_000, maxTokens: 128_000,
  availableThinkingLevels: ['off', 'medium', 'high', 'xhigh'] as const, fastModeSupported: false, available: true,
}
const catalog: PrimeModelCatalog = {
  primeVersion: '17.2.9',
  refreshedAt: '2026-08-18T00:00:00.000Z',
  models: [
    { ...model, input: [...model.input], availableThinkingLevels: [...model.availableThinkingLevels] },
    {
      ...model, key: 'openai-codex/gpt-5.6-luna', provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna GPT-5.6',
      input: [...model.input], availableThinkingLevels: ['off', 'medium', 'max'],
    },
  ],
  providers: [
    { id: 'anthropic', name: 'anthropic', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
    { id: 'openai-codex', name: 'openai-codex', authMethod: 'external', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
  ],
}

const installedConfig: AgentRoleConfig = {
  supported: true,
  installed: true,
  roles: { default: 'anthropic/claude-opus-5:xhigh', smol: 'openai-codex/gpt-5.6-luna:max' },
  advisor: { enabled: true, subagents: false, syncBacklog: '1', immuneTurns: 2 },
}

function agentConfigApi(config: AgentRoleConfig, set?: PrimeWorkApi['agentConfig']['set']): PrimeWorkApi['agentConfig'] {
  return {
    get: vi.fn(async () => config),
    set: set ?? vi.fn(async () => config),
  }
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function render(node: ReactNode) {
  await act(async () => { root.render(node) })
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
}

function select(label: string): HTMLSelectElement {
  const match = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  if (!match) throw new Error(`Select not found: ${label}`)
  return match
}

async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

describe('ModelRoleSettings harness gating', () => {
  it('renders nothing for a harness whose adapter declares no config CLI', async () => {
    const api = agentConfigApi({ supported: false, installed: false, roles: {}, advisor: null })
    await render(<ModelRoleSettings harness="prime" agentConfig={api} catalog={catalog} />)

    expect(api.get).toHaveBeenCalledWith('prime')
    expect(container.textContent).toBe('')
  })

  it('renders nothing without a desktop bridge', async () => {
    await render(<ModelRoleSettings harness="omp" agentConfig={null} catalog={catalog} />)
    expect(container.textContent).toBe('')
  })

  it('explains a missing CLI instead of showing an empty form', async () => {
    const api = agentConfigApi({ supported: true, installed: false, roles: {}, advisor: null, warning: 'OMP is not installed.' })
    await render(<ModelRoleSettings harness="omp" agentConfig={api} catalog={catalog} />)

    expect(container.textContent).toContain('OMP is not installed.')
    expect(container.querySelectorAll('select')).toHaveLength(0)
    expect([...container.querySelectorAll('button')].some((item) => item.textContent?.includes('Save'))).toBe(false)
  })

  it('re-reads the live configuration when the harness changes', async () => {
    const api = agentConfigApi(installedConfig)
    await render(<ModelRoleSettings harness="omp" agentConfig={api} catalog={catalog} />)
    await render(<ModelRoleSettings harness="pi" agentConfig={api} catalog={catalog} />)

    expect(api.get).toHaveBeenNthCalledWith(1, 'omp')
    expect(api.get).toHaveBeenNthCalledWith(2, 'pi')
  })
})

describe('ModelRoleSettings editing', () => {
  it('splits each stored selector into its model and thinking level', async () => {
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig)} catalog={catalog} />)

    expect(select('Default model').value).toBe('anthropic/claude-opus-5')
    expect(select('Default thinking level').value).toBe('xhigh')
    expect(select('Smol model').value).toBe('openai-codex/gpt-5.6-luna')
    expect(select('Smol thinking level').value).toBe('max')
    // An unset role stays unset rather than being silently assigned a model.
    expect(select('Plan model').value).toBe('')
  })

  it('keeps a selector the catalog cannot resolve visible instead of rewriting it', async () => {
    const config: AgentRoleConfig = { ...installedConfig, roles: { default: 'retired/model-9:high' } }
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(config)} catalog={catalog} />)

    expect(select('Default model').value).toBe('retired/model-9:high')
    expect(container.textContent).toContain('not in catalog')
  })

  it('saves only the roles that actually changed', async () => {
    const set = vi.fn(async () => installedConfig)
    const api = agentConfigApi(installedConfig, set)
    await render(<ModelRoleSettings harness="omp" agentConfig={api} catalog={catalog} />)

    await choose(select('Plan model'), 'anthropic/claude-opus-5')
    await choose(select('Plan thinking level'), 'high')
    await click(button('Save model roles'))

    expect(set).toHaveBeenCalledWith({ roles: { plan: 'anthropic/claude-opus-5:high' } }, 'omp')
  })

  it('drops a thinking level the newly chosen model does not offer', async () => {
    const set = vi.fn(async () => installedConfig)
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig, set)} catalog={catalog} />)

    // Opus offers xhigh; Luna does not, so the suffix must not survive.
    await choose(select('Default model'), 'openai-codex/gpt-5.6-luna')
    await click(button('Save model roles'))

    expect(set).toHaveBeenCalledWith({ roles: { default: 'openai-codex/gpt-5.6-luna' } }, 'omp')
  })

  it('saves only the advisor leaves that actually changed', async () => {
    const set = vi.fn(async () => installedConfig)
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig, set)} catalog={catalog} />)

    await choose(select('Catch-up threshold'), '5')
    await click(button('Save model roles'))

    expect(set).toHaveBeenCalledWith({ advisor: { syncBacklog: '5' } }, 'omp')
  })

  it('keeps save inert until something is edited, and after a discard', async () => {
    const set = vi.fn(async () => installedConfig)
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig, set)} catalog={catalog} />)

    expect(button('Save model roles').disabled).toBe(true)
    await choose(select('Plan model'), 'anthropic/claude-opus-5')
    expect(button('Save model roles').disabled).toBe(false)

    await click(button('Discard'))
    expect(button('Save model roles').disabled).toBe(true)
    expect(select('Plan model').value).toBe('')
    expect(set).not.toHaveBeenCalled()
  })

  it('surfaces a rejected save and keeps the edit for another attempt', async () => {
    const set = vi.fn(async () => { throw new Error('OMP rejected modelRoles: Invalid value') })
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig, set)} catalog={catalog} />)

    await choose(select('Plan model'), 'anthropic/claude-opus-5')
    await click(button('Save model roles'))

    expect(container.textContent).toContain('OMP rejected modelRoles: Invalid value')
    expect(select('Plan model').value).toBe('anthropic/claude-opus-5')
    expect(button('Save model roles').disabled).toBe(false)
  })

  it('adopts the configuration the harness reports back after a save', async () => {
    const saved: AgentRoleConfig = {
      ...installedConfig,
      roles: { ...installedConfig.roles, plan: 'anthropic/claude-opus-5:medium' },
    }
    const set = vi.fn(async () => saved)
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig, set)} catalog={catalog} />)

    await choose(select('Plan model'), 'anthropic/claude-opus-5')
    await click(button('Save model roles'))

    // The harness normalized the write; the form follows it rather than its own draft.
    expect(select('Plan thinking level').value).toBe('medium')
    expect(button('Save model roles').disabled).toBe(true)
    expect(container.textContent).toContain('Saved to OMP configuration.')
  })

  it('disables model choice while the catalog is still loading', async () => {
    await render(<ModelRoleSettings harness="omp" agentConfig={agentConfigApi(installedConfig)} catalog={null} />)

    expect(select('Default model').disabled).toBe(true)
    expect(container.textContent).toContain('model catalog has not loaded yet')
  })
})
