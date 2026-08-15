import { afterEach, describe, expect, it, vi } from 'vitest'

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  details: Record<string, unknown>
}

interface RegisteredTool {
  name: string
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolResult>
}

function registeredHost() {
  const tools: RegisteredTool[] = []
  const schema = () => ({}) as object
  return {
    tools,
    api: {
      typebox: {
        Type: {
          Object: schema,
          String: schema,
          Number: schema,
          Boolean: schema,
          Array: schema,
          Enum: schema,
          Optional: schema,
        },
      },
      registerTool: (tool: RegisteredTool) => tools.push(tool),
    },
  }
}

function tool(tools: RegisteredTool[], name: string): RegisteredTool {
  const registered = tools.find((candidate) => candidate.name === name)
  if (!registered) throw new Error(`Tool ${name} was not registered`)
  return registered
}

function bridgeResponse(result: unknown, status = 200): Response {
  return { status, json: async () => ({ ok: true, result }) } as Response
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('shipped extension execution contracts', () => {
  it('executes every Prime browser tool through the scoped broker without real network access', async () => {
    vi.stubEnv('PRIME_WORK_BROWSER_URL', 'http://127.0.0.1:1/')
    vi.stubEnv('PRIME_WORK_BROWSER_TOKEN', 'coverage-only-browser-token')
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
      calls.push(request)
      const results: Record<string, unknown> = {
        'terminal.read': '$ npm test\npassed',
        'tabs.list': [{ tabId: 'tab-one' }],
        'tabs.open': { tabId: 'tab-two', url: 'https://example.test/', title: 'Example' },
        screenshot: { data: 'aGVsbG8=', mimeType: 'image/png', url: 'https://example.test/', title: 'Example', width: 800, height: 600 },
      }
      return bridgeResponse(results[request.method] ?? { method: request.method })
    })
    vi.stubGlobal('fetch', fetch)
    const factory = (await import('../../assets/extensions/prime-work-browser')).default
    const { tools, api } = registeredHost()
    factory(api as never)

    expect(tools.map(({ name }) => name)).toEqual([
      'terminal_read',
      'browser_tabs',
      'browser_navigate',
      'browser_screenshot',
      'browser_read_page',
      'browser_click',
      'browser_type',
      'browser_press_key',
      'browser_scroll',
      'browser_evaluate',
    ])
    expect((await tool(tools, 'terminal_read').execute('call-terminal', {})).content[0].text).toContain('<untrusted-terminal-content>')
    await tool(tools, 'browser_tabs').execute('call-list', { action: 'list' })
    expect((await tool(tools, 'browser_tabs').execute('call-open', { action: 'open', url: 'https://example.test/' })).content[0].text).toContain('Opened tab tab-two')
    await tool(tools, 'browser_tabs').execute('call-close', { action: 'close', tab_id: 'tab-two' })
    await tool(tools, 'browser_tabs').execute('call-select', { action: 'select', tab_id: 'tab-one' })
    await expect(tool(tools, 'browser_navigate').execute('call-invalid', {})).rejects.toThrow(/Provide url or action/)
    await tool(tools, 'browser_navigate').execute('call-navigate', { action: 'reload', tab_id: 'tab-one' })
    const screenshot = await tool(tools, 'browser_screenshot').execute('call-screenshot', { tab_id: 'tab-one' })
    expect(screenshot.content[0]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' })
    expect(screenshot.content[1].text).toContain('<untrusted-page-content>')
    await tool(tools, 'browser_read_page').execute('call-read', { mode: 'text', tab_id: 'tab-one' })
    await tool(tools, 'browser_click').execute('call-click', { ref: 3, x: undefined, y: null, tab_id: 'tab-one' })
    await tool(tools, 'browser_type').execute('call-type', { text: 'hello', submit: true, tab_id: 'tab-one' })
    await tool(tools, 'browser_press_key').execute('call-key', { key: 'Enter', modifiers: ['shift'], tab_id: 'tab-one' })
    await tool(tools, 'browser_scroll').execute('call-scroll', { direction: 'down', amount: 600, tab_id: 'tab-one' })
    await tool(tools, 'browser_evaluate').execute('call-evaluate', { code: 'return document.title', tab_id: 'tab-one' })

    expect(calls.map(({ method }) => method)).toEqual([
      'terminal.read',
      'tabs.list',
      'tabs.open',
      'tabs.close',
      'tabs.select',
      'navigate',
      'screenshot',
      'read_page',
      'click',
      'type',
      'press_key',
      'scroll',
      'evaluate',
    ])
    expect(calls.find(({ method }) => method === 'click')?.params).toEqual({ ref: 3, tabId: 'tab-one' })
    expect(fetch.mock.calls.every(([, init]) => init !== undefined && (init.headers as Record<string, string>).authorization === 'Bearer coverage-only-browser-token')).toBe(true)
  })

  it('bounds Prime browser broker failures and rejects an empty screenshot', async () => {
    vi.stubEnv('PRIME_WORK_BROWSER_URL', 'http://127.0.0.1:1/')
    vi.stubEnv('PRIME_WORK_BROWSER_TOKEN', 'coverage-only-browser-token')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const factory = (await import('../../assets/extensions/prime-work-browser')).default
    const { tools, api } = registeredHost()
    factory(api as never)

    fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(tool(tools, 'browser_tabs').execute('call-offline', { action: 'list' })).rejects.toThrow(/GooeyPi is not reachable/)
    fetch.mockResolvedValueOnce({ status: 403, json: async () => ({ ok: false }) } as Response)
    await expect(tool(tools, 'browser_tabs').execute('call-denied', { action: 'list' })).rejects.toThrow(/status 403/)
    fetch.mockResolvedValueOnce(bridgeResponse({ data: null }))
    await expect(tool(tools, 'browser_screenshot').execute('call-empty', {})).rejects.toThrow(/screenshot came back empty/)
  })

  it('executes every collaboration tool through the attributed broker without real network access', async () => {
    vi.stubEnv('GOOEYPI_COLLABORATION_URL', 'http://127.0.0.1:1/')
    vi.stubEnv('GOOEYPI_COLLABORATION_TOKEN', 'coverage-only-collaboration-token')
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> }
      calls.push(request)
      return bridgeResponse(request.method === 'list' ? [{ id: 'peer' }] : { method: request.method, params: request.params })
    })
    vi.stubGlobal('fetch', fetch)
    const factory = (await import('../../assets/extensions/omp-work-collaboration')).default
    const { tools, api } = registeredHost()
    await factory(api as never)

    expect(tools.map(({ name }) => name)).toEqual(['session_list', 'session_models', 'session_create', 'session_read', 'session_send', 'session_wait'])
    expect((await tool(tools, 'session_list').execute('call-list', {})).content[0].text).toContain('peer')
    await tool(tools, 'session_models').execute('call-models', { query: 'sonnet' })
    await tool(tools, 'session_create').execute('call-create', { prompt: 'Review', model: 'provider/model', fast: true })
    await tool(tools, 'session_read').execute('call-read', { target_session_id: 'peer' })
    await tool(tools, 'session_send').execute('call-send', { target_session_id: 'peer', message: 'status?' })
    await tool(tools, 'session_wait').execute('call-wait', { target_session_id: 'peer', after_cursor: 'cursor', timeout_ms: 10 })

    expect(calls).toEqual([
      { method: 'list', params: {} },
      { method: 'models', params: { query: 'sonnet' } },
      { method: 'create', params: { prompt: 'Review', model: 'provider/model', fast: true } },
      { method: 'read', params: { target_session_id: 'peer' } },
      { method: 'send', params: { target_session_id: 'peer', message: 'status?' } },
      { method: 'wait', params: { target_session_id: 'peer', after_cursor: 'cursor', timeout_ms: 10 } },
    ])
    expect(fetch.mock.calls.every(([, init]) => init !== undefined && (init.headers as Record<string, string>).authorization === 'Bearer coverage-only-collaboration-token')).toBe(true)
  })

  it('bounds collaboration transport and broker errors without exposing its test claim', async () => {
    vi.stubEnv('GOOEYPI_COLLABORATION_URL', 'http://127.0.0.1:1/')
    vi.stubEnv('GOOEYPI_COLLABORATION_TOKEN', 'coverage-only-collaboration-token')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const factory = (await import('../../assets/extensions/omp-work-collaboration')).default
    const { tools, api } = registeredHost()
    await factory(api as never)

    fetch.mockRejectedValueOnce(new Error('offline'))
    await expect(tool(tools, 'session_list').execute('call-offline', {})).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).toContain('broker is not reachable')
      expect(String(error)).not.toContain('coverage-only-collaboration-token')
      return true
    })
    fetch.mockResolvedValueOnce({ status: 401, json: async () => ({ ok: false, error: 'claim expired' }) } as Response)
    await expect(tool(tools, 'session_list').execute('call-denied', {})).rejects.toThrow(/claim expired/)
  })
})
