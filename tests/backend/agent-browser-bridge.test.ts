import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserBridge } from '../../electron/main/browser/agent-bridge'
import type { AgentBrowserService } from '../../electron/main/browser/agent-service'
import { waitUntil } from '../helpers/wait'

class TestAgentBrowserBridge extends AgentBrowserBridge {
  requestsFor(token: string): number | undefined { return this.claimForToken(token)?.requests }
}

const bridges: AgentBrowserBridge[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
})

function fakeService() {
  const calls: Array<{ method: string; sessionKey: string; params: Record<string, unknown> }> = []
  const record = (method: string) => async (sessionKey: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, sessionKey, params })
    return { method }
  }
  const service = {
    listTabs: record('tabs.list'),
    openTab: record('tabs.open'),
    closeTabScoped: record('tabs.close'),
    selectTabScoped: record('tabs.select'),
    navigate: record('navigate'),
    screenshot: record('screenshot'),
    click: record('click'),
    type: record('type'),
    pressKey: record('press_key'),
    scroll: record('scroll'),
    readPage: record('read_page'),
    evaluate: record('evaluate'),
  }
  return { calls, service: service as unknown as AgentBrowserService }
}

function fakeTerminals() {
  return { readActive: vi.fn((sessionKey: string) => ({ label: 'zsh 2', cwd: '/project', content: '$ npm test\npassed', truncated: false, sessionKey })) }
}

async function fixture(scope: { cwd: string; sessionPath?: string } = { cwd: '/project', sessionPath: '/sessions/one.jsonl' }) {
  const { calls, service } = fakeService()
  const terminals = fakeTerminals()
  const bridge = new TestAgentBrowserBridge({ service, terminals, extensionPath: '/app/extensions/prime-work-browser.ts', skillPath: '/app/skills/prime-work-browser' })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor(scope)
  const call = async (method: string, params: Record<string, unknown> = {}, token = environment.PRIME_WORK_BROWSER_TOKEN) => {
    const response = await fetch(environment.PRIME_WORK_BROWSER_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: string } }
  }
  return { bridge, calls, terminals, environment, call }
}

describe('AgentBrowserBridge', () => {
  it('rejects a revoked runtime token immediately without affecting active runtimes', async () => {
    const { bridge, call, environment } = await fixture()
    const active = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/active.jsonl' })

    expect(bridge.revoke(environment.PRIME_WORK_BROWSER_TOKEN)).toBe(true)
    expect(bridge.revoke(environment.PRIME_WORK_BROWSER_TOKEN)).toBe(false)

    expect(await call('tabs.list')).toMatchObject({ status: 401 })
    expect(await call('tabs.list', {}, active.PRIME_WORK_BROWSER_TOKEN)).toMatchObject({ status: 200 })
  })

  it('returns 401 without dispatch when a claim is revoked after headers but before the full body', async () => {
    const { bridge, calls, environment } = await fixture()
    const token = environment.PRIME_WORK_BROWSER_TOKEN!
    const body = JSON.stringify({ method: 'tabs.list', params: {} })
    const request = httpRequest(environment.PRIME_WORK_BROWSER_URL!, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    })
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request.on('response', (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
    })

    request.write(body.slice(0, -1))
    await waitUntil(() => bridge.requestsFor(token) === 1)
    expect(bridge.revoke(token)).toBe(true)
    request.end(body.slice(-1))

    await expect(response).resolves.toMatchObject({ status: 401, body: expect.stringContaining('Capability expired') })
    expect(calls).toHaveLength(0)
  })

  it('exposes the extension and skill paths and dispatches scoped methods', async () => {
    const { calls, environment, call } = await fixture()
    expect(environment.PRIME_WORK_BROWSER_EXTENSION_PATH).toBe('/app/extensions/prime-work-browser.ts')
    expect(environment.PRIME_WORK_BROWSER_SKILL_PATH).toBe('/app/skills/prime-work-browser')
    const response = await call('tabs.open', { url: 'https://example.com' })
    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('tabs.open')
    expect(calls[0].params).toEqual({ url: 'https://example.com' })
    // The session key is canonicalized from the claim's session path, never from request params.
    expect(calls[0].sessionKey.endsWith('one.jsonl')).toBe(true)
    await call('click', { x: 10, y: 20, sessionKey: '/etc/passwd' })
    expect(calls[1].sessionKey.endsWith('one.jsonl')).toBe(true)
  })

  it('rejects missing tokens, wrong routes, browser origins, and unknown methods', async () => {
    const { environment, call } = await fixture()
    expect((await call('tabs.list', {}, 'wrong-token')).status).toBe(401)
    expect((await call('definitely_not_a_method')).status).toBe(400)
    const origin = await fetch(environment.PRIME_WORK_BROWSER_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.PRIME_WORK_BROWSER_TOKEN}`, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ method: 'tabs.list' }),
    })
    expect(origin.status).toBe(404)
    const wrongPath = await fetch(environment.PRIME_WORK_BROWSER_URL!.replace('/v1/call', '/v1/other'), {
      method: 'POST', headers: { Authorization: `Bearer ${environment.PRIME_WORK_BROWSER_TOKEN}` }, body: '{}',
    })
    expect(wrongPath.status).toBe(404)
  })

  it('requires a session scope and accepts one bound after start', async () => {
    const { bridge, calls, environment, call } = await fixture({ cwd: '/project' })
    const before = await call('tabs.list')
    expect(before.status).toBe(409)
    expect(before.body.error).toContain('not available yet')
    expect(calls).toHaveLength(0)
    bridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, '/sessions/late.jsonl')
    const after = await call('tabs.list')
    expect(after.status).toBe(200)
    expect(calls[0].sessionKey.endsWith('late.jsonl')).toBe(true)
    // A bound session scope must never be rebound to another thread.
    bridge.bindSession(environment.PRIME_WORK_BROWSER_TOKEN, '/sessions/other.jsonl')
    await call('tabs.list')
    expect(calls[1].sessionKey.endsWith('late.jsonl')).toBe(true)
  })

  it('reads only the active terminal scoped to the runtime session', async () => {
    const { terminals, call } = await fixture()
    const response = await call('terminal.read', { sessionKey: '/sessions/other.jsonl' })
    expect(response.status).toBe(200)
    expect(terminals.readActive).toHaveBeenCalledOnce()
    expect(terminals.readActive.mock.calls[0][0].endsWith('one.jsonl')).toBe(true)
    expect(response.body.result).toMatchObject({ label: 'zsh 2', content: '$ npm test\npassed' })
  })

  it('propagates service failures as bounded errors', async () => {
    const { calls, service } = fakeService()
    void calls
    ;(service as unknown as Record<string, unknown>).readPage = vi.fn(async () => { throw new Error('boom') })
    const bridge = new AgentBrowserBridge({ service, terminals: fakeTerminals(), extensionPath: '/x.ts', skillPath: '/s' })
    await bridge.start()
    bridges.push(bridge)
    const environment = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
    const response = await fetch(environment.PRIME_WORK_BROWSER_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.PRIME_WORK_BROWSER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'read_page' }),
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toBe('boom')
  })

  it('mints one independent claim per runtime', async () => {
    const { bridge, calls, call } = await fixture()
    const other = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/two.jsonl' })
    const response = await call('tabs.list', {}, other.PRIME_WORK_BROWSER_TOKEN)
    expect(response.status).toBe(200)
    expect(calls[0].sessionKey.endsWith('two.jsonl')).toBe(true)
  })
})
