// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelPicker } from '../../src/components/ModelPicker'
import { I18nProvider } from '../../src/lib/i18n'
import type { PrimeModelDescriptor, PrimeProviderDescriptor } from '../../src/types/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const provider: PrimeProviderDescriptor = {
  id: 'anthropic',
  name: 'Anthropic',
  authMethod: 'api_key',
  configured: true,
  modelCount: 1,
  availableModelCount: 1,
  enabled: true,
}

const model: PrimeModelDescriptor = {
  key: 'anthropic/claude-sonnet-4-5',
  provider: 'anthropic',
  id: 'claude-sonnet-4-5',
  name: 'Claude Sonnet 4.5',
  reasoning: true,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 8_192,
  availableThinkingLevels: ['low', 'medium', 'high'],
  fastModeSupported: false,
  available: true,
}

function renderPicker(props: Parameters<typeof ModelPicker>[0]) {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  return {
    container,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
    async render() {
      await act(async () => {
        root.render(
          <I18nProvider preference="en">
            <ModelPicker {...props} />
          </I18nProvider>,
        )
      })
    },
  }
}

function trigger(container: HTMLElement) {
  return container.querySelector<HTMLButtonElement>('.model-picker__trigger')!
}

async function openPicker(container: HTMLElement) {
  await act(async () => trigger(container).dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('model picker when the model list failed to load', () => {
  let view: ReturnType<typeof renderPicker> | undefined

  beforeEach(() => {
    view = undefined
  })

  afterEach(async () => {
    await view?.unmount()
    vi.restoreAllMocks()
  })

  it('stays clickable and explains the failure instead of offering an empty list', async () => {
    const onRetryCatalog = vi.fn()
    view = renderPicker({
      value: '',
      modelsByProvider: new Map(),
      providers: [],
      onChange: () => {},
      catalogFailed: true,
      catalogError: 'Model catalog timed out',
      onRetryCatalog,
    })
    await view.render()

    // The old behaviour disabled the trigger whenever the catalog was empty, so
    // the only hint that anything was wrong was a greyed-out "No model available".
    expect(trigger(view!.container).disabled).toBe(false)

    await openPicker(view!.container)
    expect(view!.container.textContent).toContain('Model list unavailable')
    expect(view!.container.textContent).toContain('could not read the models')

    await act(async () => {
      view!.container.querySelector<HTMLButtonElement>('button.model-picker__retry')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRetryCatalog).toHaveBeenCalledTimes(1)
  })

  it('shows the underlying reason without putting it in the accessible name', async () => {
    view = renderPicker({
      value: '',
      modelsByProvider: new Map(),
      providers: [],
      onChange: () => {},
      catalogFailed: true,
      catalogError: 'Model catalog timed out',
      onRetryCatalog: () => {},
    })
    await view.render()
    await openPicker(view!.container)

    const reason = view!.container.querySelector('.model-picker__unavailable-reason')!
    expect(reason.textContent).toBe('Model catalog timed out')
    expect(reason.getAttribute('role')).toBe('status')
  })

  it('disables the retry control while a retry is in flight', async () => {
    const onRetryCatalog = vi.fn()
    view = renderPicker({
      value: '',
      modelsByProvider: new Map(),
      providers: [],
      onChange: () => {},
      catalogFailed: true,
      catalogError: 'Model catalog timed out',
      catalogRetrying: true,
      onRetryCatalog,
    })
    await view.render()
    await openPicker(view!.container)

    const retry = view!.container.querySelector<HTMLButtonElement>('button.model-picker__retry')!
    expect(retry.disabled).toBe(true)
    expect(retry.textContent).toContain('Retrying')
  })

  it('keeps an empty-but-healthy catalog quiet, with nothing to retry', async () => {
    view = renderPicker({
      value: '',
      modelsByProvider: new Map(),
      providers: [],
      onChange: () => {},
    })
    await view.render()

    expect(trigger(view!.container).disabled).toBe(true)
    expect(view!.container.textContent).not.toContain('Model list unavailable')
  })

  it('leaves a working picker untouched', async () => {
    const onChange = vi.fn()
    view = renderPicker({
      value: model.key,
      modelsByProvider: new Map([[provider.id, [model]]]),
      providers: [provider],
      onChange,
      catalogFailed: false,
      catalogError: null,
      onRetryCatalog: () => {},
    })
    await view.render()

    expect(trigger(view!.container).disabled).toBe(false)
    expect(trigger(view!.container).textContent).toContain('Claude Sonnet 4.5')
    await openPicker(view!.container)
    expect(view!.container.textContent).not.toContain('Model list unavailable')
    await act(async () => {
      view!.container.querySelector<HTMLButtonElement>('[role="option"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith(model.key)
  })
})
