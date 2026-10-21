import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityBridge, type CapabilityClaim } from '../../electron/main/lib/capability-bridge'

class TestBridge extends CapabilityBridge {
  onAdmission?: () => void
  protected get rateLimit() { this.onAdmission?.(); return 20 }
  protected readonly rateLimitError = 'Too many calls'
  readonly dispatchCall = vi.fn(async (_method: string, params: Record<string, unknown>, claim: CapabilityClaim) => ({ params, sessionPath: claim.sessionPath }))
  protected environmentEntries(url: string, token: string) { return { URL: url, TOKEN: token } }
  protected dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim) { return this.dispatchCall(method, params, claim) }
}
const bridges: TestBridge[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(bridges.splice(0).map((bridge) => bridge.stop())) })
async function fixture() {
  const bridge = new TestBridge()
  bridges.push(bridge)
  await bridge.start()
  const env = bridge.environmentFor({ cwd: '/project' })
  const url = env.URL!
  const token = env.TOKEN!
  const call = (headers: Record<string, string> = {}, body = '{"method":"echo"}', endpoint = url, method = 'POST') => fetch(endpoint, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body,
  })
  return { bridge, call, url, token }
}

describe('loopback capability boundary', () => {
  it('rejects browser origins, unsupported routes, methods, media types and malformed tokens', async () => {
    const { call, url } = await fixture()
    expect((await call({ origin: 'https://attacker.example' })).status).toBe(404)
    expect((await call({}, undefined, undefined, 'PUT')).status).toBe(404)
    expect((await call({ 'content-type': 'text/plain' })).status).toBe(415)
    for (const authorization of ['', 'bearer token', 'Bearer wrong', 'Bearer token extra']) expect((await call({ authorization })).status).toBe(401)
    expect((await call({}, '{"method":"echo","params":[]}')).status).toBe(400)
    expect((await call({}, '{broken')).status).toBe(400)
    expect((await call({}, undefined, url.replace('/v1/call', '/wrong'))).status).toBe(404)
  })

  it('binds the initial session only once and isolates revoked capabilities', async () => {
    const { bridge, call, token } = await fixture()
    bridge.bindSession(token, '/session/one')
    bridge.bindSession(token, '/session/two')
    expect(await (await call()).json()).toMatchObject({ result: { params: {}, sessionPath: '/session/one' } })
    expect(bridge.revoke(token)).toBe(true)
    expect(bridge.revoke(token)).toBe(false)
    expect((await call()).status).toBe(401)
  })

  it('bounds calls per window and retains the existing 24-hour expiry guard', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const { call } = await fixture()
    for (let index = 0; index < 20; index++) expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(429)
    now.mockReturnValue(1_060_000)
    expect((await call()).status).toBe(200)
    now.mockReturnValue(1_000_000 + 24 * 60 * 60_000)
    expect((await call()).status).toBe(401)
  })

  it('rechecks revocation after a streamed request body and refuses oversized bodies', async () => {
    const { bridge, url, token } = await fixture()
    let admitted!: () => void
    const admission = new Promise<void>((resolveAdmission) => { admitted = resolveAdmission })
    bridge.onAdmission = admitted
    const status = new Promise<number>((resolveStatus, reject) => {
      const outgoing = request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (response) => {
        response.resume(); resolveStatus(response.statusCode!)
      })
      outgoing.on('error', reject)
      outgoing.write('{"method":')
      void admission.then(() => { bridge.revoke(token); outgoing.end('"echo"}') })
    })
    expect(await status).toBe(401)
    const next = bridge.environmentFor({ cwd: '/project' })
    await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${next.TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'echo', params: { text: 'x'.repeat(1_100_000) } }) }).catch(() => undefined)
    expect(bridge.dispatchCall).not.toHaveBeenCalled()
  })
})
