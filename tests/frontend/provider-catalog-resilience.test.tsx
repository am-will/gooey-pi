// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_RETRY_DELAYS_MS, useProviderCatalog, type ProviderCatalog } from '../../src/hooks/useProviderCatalog'
import type { PrimeModelCatalog } from '../../src/types/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const healthy: PrimeModelCatalog = {
  primeVersion: 'test',
  refreshedAt: '2026-11-24T00:00:00.000Z',
  models: [{
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
  }],
  providers: [{
    id: 'anthropic',
    name: 'Anthropic',
    authMethod: 'api_key',
    configured: true,
    modelCount: 1,
    availableModelCount: 1,
    enabled: true,
  }],
}

// What the main process hands the renderer when pi answered too slowly: the read succeeds over IPC
// and carries an empty catalog plus the reason it is empty, in `warning`.
const degraded = (message = 'Model catalog timed out'): PrimeModelCatalog => ({
  primeVersion: 'test',
  refreshedAt: '2026-11-24T00:00:00.000Z',
  models: [],
  providers: [],
  warning: message,
})

function mockBridge(catalog: () => Promise<PrimeModelCatalog>) {
  const bridge = {
    providers: {
      catalog: vi.fn((_force = false, _harness: string) => catalog()),
      onAuthEvent: vi.fn(() => () => {}),
      saveApiKey: vi.fn(),
      logout: vi.fn(),
      setEnabled: vi.fn(),
      setModelEnabled: vi.fn(),
      startOAuth: vi.fn(),
      respondOAuth: vi.fn(),
      cancelOAuth: vi.fn(),
    },
    agents: { update: vi.fn(async () => ({}) ) },
    sessions: { loadTranscript: vi.fn(async () => ({ messages: [] })) },
  }
  return bridge as unknown as Parameters<typeof useProviderCatalog>[0]['bridge'] & {
    providers: { catalog: ReturnType<typeof vi.fn> }
  }
}

let latest: ProviderCatalog | undefined

/** How many of the catalog calls so far were explicit refreshes (`force === true`). */
function forcedCalls(bridge: { providers: { catalog: ReturnType<typeof vi.fn> } }): number {
  return bridge.providers.catalog.mock.calls.filter((call: unknown[]) => call[0] === true).length
}

// The app hands the hook stable callbacks; inline arrows would re-fire its load effect on every
// render, and React's act() waits for the queue to drain, so it would never settle.
const rememberModel = () => {}
const syncRuntime = async () => {}
const reportError = () => {}

function Probe({ bridge }: { bridge: Parameters<typeof useProviderCatalog>[0]['bridge'] }) {
  latest = useProviderCatalog({
    bridge,
    ready: true,
    harness: 'pi',
    runtime: null,
    activeSession: undefined,
    lastSelectedModel: '',
    rememberModel,
    syncRuntime,
    reportError,
  })
  return null
}

async function mount(bridge: Parameters<typeof useProviderCatalog>[0]['bridge']) {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  await act(async () => {
    root.render(<Probe bridge={bridge} />)
    await vi.advanceTimersByTimeAsync(0)
  })
  return async () => {
    await act(async () => {
      root.unmount()
      await vi.advanceTimersByTimeAsync(0)
    })
    container.remove()
  }
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
    // React's scheduler yields through a MessageChannel, which fake timers do not drive: without a
    // real macrotask turn the refresh never settles and the next retry is never scheduled.
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Walk the whole retry schedule, settling each refresh before advancing to the next delay. */
async function runSchedule(extraMs = 0) {
  for (const delay of CATALOG_RETRY_DELAYS_MS) await tick(delay)
  if (extraMs) await tick(extraMs)
}

describe('provider catalog resilience', () => {
  let teardown: (() => Promise<void>) | undefined

  beforeEach(() => {
    latest = undefined
    // Only the retry scheduler's timers are faked. Faking MessageChannel too would starve React's
    // concurrent scheduler, which yields through it, and every act() below would hang.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(async () => {
    await teardown?.()
    teardown = undefined
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('surfaces a failed catalog instead of leaving the model list silently empty', async () => {
    const bridge = mockBridge(async () => degraded())
    teardown = await mount(bridge)

    expect(latest!.catalog).toEqual(degraded())
    expect(latest!.catalogFailed).toBe(true)
    expect(latest!.catalogError).toBe('Model catalog timed out')
    expect(latest!.modelsByProvider.size).toBe(0)
  })

  it('does not report a failure for a healthy catalog and never retries it', async () => {
    const bridge = mockBridge(async () => healthy)
    teardown = await mount(bridge)

    expect(latest!.catalogFailed).toBe(false)
    expect(latest!.catalogError).toBeNull()
    await tick(60_000)
    expect(bridge.providers.catalog).toHaveBeenCalledTimes(1)
    expect(bridge.providers.catalog.mock.calls[0][0]).toBe(false)
  })

  it('retries a failed catalog on its own and stops once pi answers', async () => {
    const queue = [degraded(), degraded(), Promise.resolve(healthy) as Promise<PrimeModelCatalog>]
    const bridge = mockBridge(() => Promise.resolve(queue.shift() ?? degraded()))
    teardown = await mount(bridge)
    expect(latest!.catalogFailed).toBe(true)

    await tick(CATALOG_RETRY_DELAYS_MS[0])
    expect(bridge.providers.catalog).toHaveBeenLastCalledWith(true, 'pi')

    await tick(CATALOG_RETRY_DELAYS_MS[1])
    expect(latest!.catalogFailed).toBe(false)
    expect(latest!.catalog?.models).toHaveLength(1)

    const forced = forcedCalls(bridge)
    await tick(120_000)
    expect(forcedCalls(bridge)).toBe(forced)
  })

  it('gives up after a bounded number of retries so a dead pi is not hammered', async () => {
    const bridge = mockBridge(async () => degraded())
    teardown = await mount(bridge)

    await runSchedule(60_000)
    const forced = forcedCalls(bridge)
    expect(forced).toBe(CATALOG_RETRY_DELAYS_MS.length)

    await tick(600_000)
    expect(forcedCalls(bridge)).toBe(forced)
  })

  it('restarts the retry schedule when the user asks for the list again', async () => {
    const bridge = mockBridge(async () => degraded())
    teardown = await mount(bridge)

    await runSchedule(1_000)
    expect(forcedCalls(bridge)).toBe(CATALOG_RETRY_DELAYS_MS.length)

    await act(async () => latest!.retryCatalog())
    expect(forcedCalls(bridge)).toBe(CATALOG_RETRY_DELAYS_MS.length + 1)

    await tick(CATALOG_RETRY_DELAYS_MS[0])
    expect(forcedCalls(bridge)).toBe(CATALOG_RETRY_DELAYS_MS.length + 2)
  })
})
