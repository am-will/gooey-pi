// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderAuthModal } from '../../src/components/ProviderAuthModal'
import { useProviderCatalog } from '../../src/hooks/useProviderCatalog'
import { ProviderSettings } from '../../src/pages/settings/ProviderSettings'
import type { HarnessId, PrimeModelCatalog, PrimeWorkApi, RuntimeInfo } from '../../src/types/api'

vi.mock('../../src/components/ui', () => ({
  Modal: ({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) => <div role="dialog" aria-label={title}>{children}{footer}</div>,
}))

const model = {
  key: 'openai-codex/gpt-5.6', provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true,
  input: ['text'] as const, contextWindow: 400_000, maxTokens: 128_000,
  availableThinkingLevels: ['low', 'medium', 'high'] as const, fastModeSupported: true, available: true,
}
const catalog: PrimeModelCatalog = {
  primeVersion: '0.7.0',
  refreshedAt: '2026-08-06T00:00:00.000Z',
  models: [
    { ...model, key: 'anthropic/claude-sonnet', provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', input: [...model.input], availableThinkingLevels: ['low', 'high'], enabled: false },
    { ...model, key: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5', input: [...model.input], availableThinkingLevels: ['low', 'high'], enabled: false },
    { ...model, input: [...model.input], availableThinkingLevels: [...model.availableThinkingLevels], enabled: true },
  ],
  providers: [
    { id: 'anthropic', name: 'Anthropic', authMethod: 'api_key', configured: false, modelCount: 14, availableModelCount: 0, enabled: false },
    { id: 'openai-codex', name: 'ChatGPT Plus/Pro', authMethod: 'oauth', configured: true, authSource: 'stored', modelCount: 8, availableModelCount: 8, enabled: true },
  ],
}
const runtime: RuntimeInfo = {
  runtimeId: 'runtime-1', harness: 'prime', cwd: '/tmp/project', isStreaming: false,
  model: { provider: model.provider, id: model.id, name: model.name },
  thinkingLevel: 'medium', serviceTier: 'default',
}
const noop = async () => undefined
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

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject })
  return { promise, resolve, reject }
}

describe('provider settings behavior and accessibility', () => {
  it('gives each enable checkbox a provider-specific accessible name and reports toggle failure', async () => {
    const onSetEnabled = vi.fn().mockRejectedValue(new Error('Provider policy was not saved'))
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={onSetEnabled} onSetAllEnabled={noop} onSetAllDisabled={noop} onSetModelEnabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Show Anthropic provider"]')
    expect(checkbox).not.toBeNull()
    await click(checkbox!)

    expect(onSetEnabled).toHaveBeenCalledWith('anthropic', true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Provider policy was not saved')
  })

  it('uses one bulk mutation and exposes the provider and model catalogue UI', async () => {
    const onSetEnabled = vi.fn().mockResolvedValue(undefined)
    const onSetAllEnabled = vi.fn().mockResolvedValue(undefined)
    const onSetAllDisabled = vi.fn().mockResolvedValue(undefined)
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={onSetEnabled} onSetAllEnabled={onSetAllEnabled} onSetAllDisabled={onSetAllDisabled} onSetModelEnabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    expect(container.textContent).toContain('2 providers · 3 models')
    expect(container.textContent).toContain('ChatGPT Plus/Pro')
    expect(container.textContent).toContain('Anthropic')
    const providerRows = [...container.querySelectorAll('.provider-row')]
    expect(providerRows[0]?.textContent).toContain('ChatGPT Plus/Pro')
    expect(providerRows[1]?.textContent).toContain('Anthropic')
    expect(button('Reconnect')).toBeTruthy()
    expect(button('Add key')).toBeTruthy()
    await click(button('Enable all'))
    expect(onSetAllEnabled).toHaveBeenCalledTimes(1)
    expect(onSetEnabled).not.toHaveBeenCalled()
    await click(button('Disable all'))
    expect(onSetAllDisabled).toHaveBeenCalledTimes(1)
    expect(onSetEnabled).not.toHaveBeenCalled()

    await click(button('Models'))
    expect(container.textContent).toContain('GPT-5.6')
    expect(container.textContent).toContain('GPT-5.5')
    expect(container.textContent).toContain('Claude Sonnet')
    expect(container.querySelector('input[aria-label="Search models"]')).not.toBeNull()
    const groups = [...container.querySelectorAll('.provider-model-group')]
    expect(groups).toHaveLength(2)
    expect(groups[0]?.querySelector('.provider-model-group__heading')?.textContent).toContain('ChatGPT Plus/Pro')
    expect(groups[0]?.querySelector('.provider-model-group__heading')?.textContent).toContain('1 of 2 on')
    expect(groups[1]?.querySelector('.provider-model-group__heading')?.textContent).toContain('Anthropic')
    expect(groups[1]?.querySelector('.provider-model-group__heading')?.textContent).toContain('0 of 1 on')
    const openAiModels = [...groups[0]!.querySelectorAll('.provider-model-row')]
    expect(openAiModels[0]?.textContent).toContain('GPT-5.6')
    expect(openAiModels[1]?.textContent).toContain('GPT-5.5')
    const openAiHeader = groups[0]!.querySelector<HTMLButtonElement>('.provider-model-group__heading')
    const openAiContent = groups[0]!.querySelector<HTMLElement>('.provider-model-group__models')
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('true')
    expect(openAiContent?.hidden).toBe(false)
    await click(openAiHeader!)
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('false')
    expect(openAiContent?.hidden).toBe(true)
    await click(openAiHeader!)
    expect(openAiHeader?.getAttribute('aria-expanded')).toBe('true')
    expect(openAiContent?.hidden).toBe(false)
  })

  it('puts each model switch at the far right and sends the model key', async () => {
    const onSetModelEnabled = vi.fn().mockResolvedValue(undefined)
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={noop} onLogout={noop} onSetEnabled={noop} onSetAllEnabled={noop} onSetAllDisabled={noop} onSetModelEnabled={onSetModelEnabled} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    await click(button('Models'))
    const row = container.querySelector('.provider-model-row')
    const toggle = row?.querySelector<HTMLInputElement>('input[aria-label="Show GPT-5.6 model"]')
    expect(toggle).not.toBeNull()
    expect(row?.lastElementChild?.classList.contains('provider-model-row__toggle')).toBe(true)
    await click(toggle!)
    expect(onSetModelEnabled).toHaveBeenCalledWith('openai-codex/gpt-5.6', false)
  })

  it('keeps API-key failures announced inside the active modal', async () => {
    const onSaveApiKey = vi.fn().mockRejectedValue(new Error('Credential rejected'))
    await render(<ProviderSettings catalog={catalog} onRefresh={noop} onSaveApiKey={onSaveApiKey} onLogout={noop} onSetEnabled={noop} onSetAllEnabled={noop} onSetAllDisabled={noop} onSetModelEnabled={noop} onStartOAuth={noop} onOpenDocs={() => undefined} />)

    await click(button('Add key'))
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[type="password"]')
    expect(input).not.toBeNull()
    await enter(input!, 'not-a-real-secret')
    await click(button('Save API key'))

    expect(onSaveApiKey).toHaveBeenCalledWith('anthropic', 'not-a-real-secret')
    const alert = dialog?.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Credential rejected')
    expect(container.querySelector('[role="dialog"]')).toBe(dialog)
  })

  it('uses ordinary buttons for OAuth choices and submits the selected id', async () => {
    const onRespond = vi.fn()
    await render(<ProviderAuthModal event={{ type: 'select', flowId: 'flow-1', providerId: 'openai-codex', promptId: 'prompt-1', message: 'Choose an account', options: [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }] }} onOpen={() => undefined} onRespond={onRespond} onCancel={() => undefined} />)

    expect(container.querySelector('[role="listbox"]')).toBeNull()
    expect(container.querySelector('[role="option"]')).toBeNull()
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toBeTruthy()
    await click(button('Work'))
    expect(onRespond).toHaveBeenCalledWith('prompt-1', 'work')
  })

  it('renders provider prompts without MCP-specific authentication claims', async () => {
    await render(<ProviderAuthModal event={{ type: 'prompt', flowId: 'flow-1', providerId: 'openai-codex', promptId: 'prompt-1', message: 'Paste the authorization code from your browser.', placeholder: 'Authorization code' }} onOpen={() => undefined} onRespond={() => undefined} onCancel={() => undefined} />)

    expect(container.textContent).not.toContain('GooeyPi will finish automatically')
    expect(container.querySelector('label span')?.textContent).toBe('Paste the authorization code from your browser.')
    expect(container.querySelector('input')?.getAttribute('placeholder')).toBe('Authorization code')
  })

  it('keeps provider authentication success and failure results visible until closed', async () => {
    const onClose = vi.fn()
    await render(<ProviderAuthModal event={{ type: 'complete', flowId: 'flow-1', providerId: 'openai-codex' }} onOpen={() => undefined} onRespond={() => undefined} onCancel={onClose} />)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Authentication successful')
    expect(container.textContent).toContain('Provider is connected. Start a new Prime session to use it.')
    await click(button('Close'))
    expect(onClose).toHaveBeenCalledOnce()

    await render(<ProviderAuthModal event={{ type: 'error', flowId: 'flow-2', providerId: 'openai-codex', error: 'Provider rejected the callback' }} onOpen={() => undefined} onRespond={() => undefined} onCancel={() => undefined} />)
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Authentication failed')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Provider rejected the callback')
  })

})

describe('provider runtime mutations', () => {
  function mountCatalogHook(options: {
    command: PrimeWorkApi['agent']['command']
    syncRuntime?: (runtimeId: string) => Promise<void>
    setEnabled?: PrimeWorkApi['providers']['setEnabled']
    setDisabled?: PrimeWorkApi['providers']['setDisabled']
    harness?: HarnessId
    reportError?: (error: unknown) => void
  }) {
    let value: ReturnType<typeof useProviderCatalog> | undefined
    const catalogMock = vi.fn().mockResolvedValue(catalog)
    const bridge = {
      agent: { command: options.command },
      providers: {
        catalog: catalogMock,
        onAuthEvent: vi.fn().mockReturnValue(() => undefined),
        setEnabled: options.setEnabled ?? vi.fn().mockResolvedValue(catalog),
        setDisabled: options.setDisabled ?? vi.fn().mockResolvedValue(catalog),
      },
    } as unknown as PrimeWorkApi
    const syncRuntime = options.syncRuntime ?? vi.fn().mockResolvedValue(undefined)
    const reportError = options.reportError ?? vi.fn()
    function Harness() {
      value = useProviderCatalog({ bridge, harness: options.harness, runtime, syncRuntime, reportError })
      return null
    }
    return render(<Harness />).then(() => ({ get value() { return value! }, catalogMock, syncRuntime, setDisabled: bridge.providers.setDisabled, reportError }))
  }

  it('serializes rapid reasoning changes and rolls back/synchronizes the latest rejection', async () => {
    const first = deferred<Record<string, unknown>>()
    const second = deferred<Record<string, unknown>>()
    const command = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const hook = await mountCatalogHook({ command })

    act(() => { hook.value.changeEffort('low'); hook.value.changeEffort('high') })
    await act(async () => { await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(1)
    expect(hook.value.effort).toBe('high')

    await act(async () => { first.resolve({}); await first.promise; await Promise.resolve() })
    expect(command).toHaveBeenCalledTimes(2)
    expect(hook.syncRuntime).not.toHaveBeenCalled()

    await act(async () => { second.reject(new Error('thinking rejected')); try { await second.promise } catch { /* expected */ }; await Promise.resolve() })
    expect(hook.value.effort).toBe('low')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(hook.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'thinking rejected' }))
  })

  it('rolls model state back and synchronizes after a rejected model command', async () => {
    const rejected = deferred<Record<string, unknown>>()
    const command = vi.fn().mockReturnValueOnce(rejected.promise)
    const hook = await mountCatalogHook({ command })

    act(() => hook.value.changeModel('openai-codex/gpt-5.5'))
    expect(hook.value.model).toBe('openai-codex/gpt-5.5')
    await act(async () => { rejected.reject(new Error('model rejected')); try { await rejected.promise } catch { /* expected */ }; await Promise.resolve() })

    expect(hook.value.model).toBe('openai-codex/gpt-5.6')
    expect(hook.value.effort).toBe('medium')
    expect(hook.syncRuntime).toHaveBeenCalledWith('runtime-1')
    expect(command).toHaveBeenCalledTimes(1)
  })

  it('accepts main-owned provider enable persistence without writing settings again', async () => {
    const next = { ...catalog, providers: catalog.providers.map((provider) => provider.id === 'anthropic' ? { ...provider, enabled: true } : provider) }
    const setEnabled = vi.fn().mockResolvedValue(next)
    const hook = await mountCatalogHook({ command: vi.fn(), setEnabled })

    await act(async () => { await hook.value.setEnabled('anthropic', true) })
    expect(setEnabled).toHaveBeenCalledWith('anthropic', true, 'prime')
    expect(hook.value.catalog?.providers.find((provider) => provider.id === 'anthropic')?.enabled).toBe(true)
  })

  it('enables every provider with one atomic main-process mutation', async () => {
    const hook = await mountCatalogHook({ command: vi.fn() })

    await act(async () => { await hook.value.setAllEnabled() })
    expect(hook.setDisabled).toHaveBeenCalledWith([], 'prime')
  })

  it('keeps an optimistic fast-mode toggle across a catalog refresh', async () => {
    const hook = await mountCatalogHook({ command: vi.fn().mockResolvedValue({}) })
    await act(async () => { await Promise.resolve() })

    act(() => hook.value.changeFast(true))
    expect(hook.value.fast).toBe(true)

    // A refresh returns a new catalog object; the runtime's stale serviceTier must not revert the toggle.
    hook.catalogMock.mockResolvedValue({ ...catalog })
    await act(async () => { await hook.value.refresh(true) })

    expect(hook.value.fast).toBe(true)
  })

  it('disables every provider and clears an explicitly selected model in one atomic mutation', async () => {
    const hook = await mountCatalogHook({ command: vi.fn() })
    await act(async () => { await Promise.resolve() })

    await act(async () => { await hook.value.setAllDisabled() })
    expect(hook.setDisabled).toHaveBeenCalledWith(['anthropic', 'openai-codex'], 'prime')
    expect(hook.value.model).toBe('auto')
    expect(hook.value.fast).toBe(false)
  })

  it('routes OMP provider visibility to the OMP desktop-settings bucket', async () => {
    const next = { ...catalog, providers: catalog.providers.map((provider) => provider.id === 'anthropic' ? { ...provider, enabled: true } : provider) }
    const setEnabled = vi.fn().mockResolvedValue(next)
    const setDisabled = vi.fn().mockResolvedValue(next)
    const hook = await mountCatalogHook({ command: vi.fn(), harness: 'omp', setEnabled, setDisabled })

    await act(async () => { await hook.value.setEnabled('anthropic', true) })
    expect(setEnabled).toHaveBeenCalledWith('anthropic', true, 'omp')
    await act(async () => { await hook.value.setAllEnabled() })
    expect(setDisabled).toHaveBeenCalledWith([], 'omp')
  })

  it('routes Pi provider visibility to the Pi desktop-settings bucket', async () => {
    const next = { ...catalog, providers: catalog.providers.map((provider) => provider.id === 'anthropic' ? { ...provider, enabled: true } : provider) }
    const setEnabled = vi.fn().mockResolvedValue(next)
    const setDisabled = vi.fn().mockResolvedValue(next)
    const hook = await mountCatalogHook({ command: vi.fn(), harness: 'pi', setEnabled, setDisabled })

    await act(async () => { await hook.value.setEnabled('anthropic', true) })
    expect(setEnabled).toHaveBeenCalledWith('anthropic', true, 'pi')
    await act(async () => { await hook.value.setAllEnabled() })
    expect(setDisabled).toHaveBeenCalledWith([], 'pi')
  })
})
