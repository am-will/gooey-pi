import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentScheduleBridge } from '../../electron/main/schedules/agent-bridge'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []
const bridges: AgentScheduleBridge[] = []
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function fixture(harness: 'prime' | 'omp' = 'prime') {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-agent-schedules-'))
  dirs.push(dir)
  const service = new AutomationService(new JsonStateStore(join(dir, 'state.json')), {
    validateTarget: async () => undefined,
    validateExecution: async () => undefined,
    run: async () => ({}),
    now: () => new Date('2030-01-01T00:00:00Z'),
  })
  const bridge = new AgentScheduleBridge({
    service, harness, skillPath: '/app/skills/prime-work-schedules',
    resolveScope: async ({ sessionPath }) => ({ projectId: 'project-one', sessionId: sessionPath ? 'session-one' : undefined }),
  })
  await bridge.start()
  bridges.push(bridge)
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/one.jsonl' })
  const call = async (method: string, params: Record<string, unknown>, token = environment.PRIME_WORK_SCHEDULE_TOKEN) => {
    const response = await fetch(environment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    return { status: response.status, body: await response.json() as { ok: boolean; result?: unknown; error?: string } }
  }
  return { service, environment, call }
}

describe('AgentScheduleBridge', () => {
  it('revokes only the requested runtime claim and treats repeated revocation as a no-op', async () => {
    const { environment, call } = await fixture()
    const other = bridges[0].environmentFor({ cwd: '/project', sessionPath: '/sessions/two.jsonl' })

    expect(await call('list', {})).toMatchObject({ status: 200 })
    expect(bridges[0].revoke(environment.PRIME_WORK_SCHEDULE_TOKEN)).toBe(true)
    expect(bridges[0].revoke(environment.PRIME_WORK_SCHEDULE_TOKEN)).toBe(false)

    expect(await call('list', {})).toMatchObject({ status: 401 })
    expect(await call('list', {}, other.PRIME_WORK_SCHEDULE_TOKEN)).toMatchObject({ status: 200 })
  })

  it('creates agent-attributed tasks only in the capability current target', async () => {
    const { service, environment, call } = await fixture()
    expect(environment.PRIME_WORK_SCHEDULE_SKILL_PATH).toBe('/app/skills/prime-work-schedules')
    const response = await call('create', {
      target: 'current_session',
      input: {
        title: 'Follow up', prompt: 'Check the deployment',
        timing: { kind: 'once', at: '2030-01-02T00:00:00Z' },
        execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
      },
    })
    expect(response.status).toBe(200)
    expect(service.list()[0]).toMatchObject({ harness: 'prime', createdBy: 'agent', target: { kind: 'session', projectId: 'project-one', sessionId: 'session-one' } })
    const list = await call('list', {})
    expect(list.body.result).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Follow up' })]))
  })

  it('attributes OMP-created tasks to OMP and never lists same-project Prime tasks', async () => {
    const { service, call } = await fixture('omp')
    await service.create({
      prompt: 'Prime-only', target: { kind: 'project', projectId: 'project-one' },
      timing: { kind: 'once', at: '2030-01-02T00:00:00Z' },
      execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    })
    await call('create', {
      target: 'current_project',
      input: { prompt: 'OMP-only', timing: { kind: 'once', at: '2030-01-02T00:00:00Z' }, execution: { model: 'auto', thinking: 'auto', speed: 'normal' } },
    })
    expect((await call('list', {})).body.result).toEqual([expect.objectContaining({ harness: 'omp', prompt: 'OMP-only' })])
  })

  it('rejects non-JSON and missing content types but accepts parameterized application/json', async () => {
    const { environment, call } = await fixture()
    const plain = await fetch(environment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.PRIME_WORK_SCHEDULE_TOKEN}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(plain.status).toBe(415)
    const missing = await fetch(environment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.PRIME_WORK_SCHEDULE_TOKEN}` },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(missing.status).toBe(415)
    const charset = await fetch(environment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST',
      headers: { Authorization: `Bearer ${environment.PRIME_WORK_SCHEDULE_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(charset.status).toBe(200)
    expect((await call('list', {})).status).toBe(200)
  })

  it('rejects missing tokens, browser origins, and unavailable target scopes', async () => {
    const { environment, call } = await fixture()
    expect((await call('list', {}, 'wrong')).status).toBe(401)
    const origin = await fetch(environment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${environment.PRIME_WORK_SCHEDULE_TOKEN}`, Origin: 'https://example.com' },
      body: JSON.stringify({ method: 'list', params: {} }),
    })
    expect(origin.status).toBe(404)
    const noSessionEnvironment = bridges[0].environmentFor({ cwd: '/project' })
    const response = await fetch(noSessionEnvironment.PRIME_WORK_SCHEDULE_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${noSessionEnvironment.PRIME_WORK_SCHEDULE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'create', params: { target: 'current_session', input: {} } }),
    })
    expect(response.status).toBe(400)
  })
})
