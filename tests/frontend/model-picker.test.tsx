// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../../src/components/ModelPicker'
import { groupModelsByProvider } from '../../src/hooks/useProviderCatalog'
import type { PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const model = (key: string, provider: string, name: string, available = true): PrimeModelDescriptor => ({
  key,
  provider,
  id: key.slice(key.indexOf('/') + 1),
  name,
  reasoning: true,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 32_000,
  availableThinkingLevels: ['medium'],
  fastModeSupported: false,
  available,
})

const models = [
  model('openai/gpt-5.6-sol', 'openai', 'GPT-5.6 Sol'),
  model('openai/gpt-5.6-luna', 'openai', 'GPT-5.6 Luna'),
  model('anthropic/claude-opus-4-8', 'anthropic', 'Claude Opus 4.8'),
  model('anthropic/claude-sonnet-4-7', 'anthropic', 'Claude Sonnet 4.7', false),
]
const providers: PrimeProviderDescriptor[] = [
  { id: 'openai', name: 'OpenAI', authMethod: 'oauth', configured: true, modelCount: 2, availableModelCount: 2, enabled: true },
  { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 2, availableModelCount: 1, enabled: true },
]
const modelsByProvider = groupModelsByProvider(models)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function renderPicker(onChange = vi.fn()) {
  await act(async () => {
    root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={modelsByProvider} providers={providers} onChange={onChange} />)
  })
  return onChange
}

async function openPicker(): Promise<HTMLInputElement> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.model-picker__trigger')?.click()
  })
  return container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
}

function optionLabels(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[role="option"] strong')].map((option) => option.textContent ?? '')
}

async function setSearch(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ModelPicker', () => {
  it('searches model names, ids, and providers', async () => {
    await renderPicker()
    const search = await openPicker()

    expect(document.activeElement).toBe(search)
    expect(optionLabels()).toEqual(['GPT-5.6 Sol', 'GPT-5.6 Luna', 'Claude Opus 4.8', 'Claude Sonnet 4.7'])

    await setSearch(search, 'opus')
    expect(optionLabels()).toEqual(['Claude Opus 4.8'])

    await setSearch(search, 'anthropic')
    expect(optionLabels()).toEqual(['Claude Opus 4.8', 'Claude Sonnet 4.7'])
  })

  it('filters the visible list by provider', async () => {
    await renderPicker()
    await openPicker()

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
        .find((button) => button.textContent === 'Anthropic')?.click()
    })

    expect(optionLabels()).toEqual(['Claude Opus 4.8', 'Claude Sonnet 4.7'])
    expect(container.querySelector('.model-picker__group-heading')?.textContent).toContain('Not connected')
  })

  it('filters to a provider whose id collides with the unfiltered sentinel', async () => {
    const collidingModels = [
      model('all/local-large', 'all', 'Local Large'),
      model('openai/gpt-5.6-sol', 'openai', 'GPT-5.6 Sol'),
    ]
    const collidingProviders: PrimeProviderDescriptor[] = [
      { id: 'all', name: 'All Hands', authMethod: 'api_key', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
      { id: 'openai', name: 'OpenAI', authMethod: 'oauth', configured: true, modelCount: 1, availableModelCount: 1, enabled: true },
    ]
    await act(async () => {
      root.render(<ModelPicker value="openai/gpt-5.6-sol" modelsByProvider={groupModelsByProvider(collidingModels)} providers={collidingProviders} onChange={vi.fn()} />)
    })
    await openPicker()

    await act(async () => {
      ;[...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
        .find((button) => button.textContent === 'All Hands')?.click()
    })

    expect(optionLabels()).toEqual(['Local Large'])
    const chips = [...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
    expect(chips.find((chip) => chip.textContent === 'All')?.getAttribute('aria-pressed')).toBe('false')
    expect(chips.find((chip) => chip.textContent === 'All Hands')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('dismisses with Escape from the provider filters, not just the search field', async () => {
    await renderPicker()
    await openPicker()

    const anthropic = [...container.querySelectorAll<HTMLButtonElement>('.model-picker__providers button')]
      .find((button) => button.textContent === 'Anthropic')!
    await act(async () => {
      anthropic.focus()
      anthropic.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.model-picker__trigger'))
  })

  it('dismisses when keyboard focus leaves the popover', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    await renderPicker()
    const search = await openPicker()

    await act(async () => {
      outside.focus()
      search.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: outside }))
    })

    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('selects an available result from the keyboard and restores trigger focus', async () => {
    const onChange = await renderPicker()
    const search = await openPicker()

    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith('openai/gpt-5.6-luna')
    expect(container.querySelector('.model-picker__popover')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.model-picker__trigger'))
  })

  it('keeps unavailable models visible but prevents selection', async () => {
    const onChange = await renderPicker()
    const search = await openPicker()

    await setSearch(search, 'sonnet')
    const unavailable = container.querySelector<HTMLButtonElement>('[role="option"]')!
    expect(unavailable.getAttribute('aria-disabled')).toBe('true')

    await act(async () => unavailable.click())
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('.model-picker__popover')).not.toBeNull()
  })
})
