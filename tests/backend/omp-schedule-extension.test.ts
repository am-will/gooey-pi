import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OmpExtensionApi } from '../../assets/extensions/omp-work-schedules'
import { AgentScheduleBridge } from '../../electron/main/schedules/agent-bridge'
import { AutomationService } from '../../electron/main/schedules/service'
import { JsonStateStore } from '../../electron/main/store'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface RegisteredTool {
  name: string
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: Array<{ text: string }> }>
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await Promise.all(cleanups.splice(0).map(async (cleanup) => cleanup()))
})

function fakePi() {
  const tools: RegisteredTool[] = []
  const schema = (kind: string) => (...args: unknown[]) => ({ kind, args })
  const pi = {
    typebox: { Type: { Object: schema('object'), String: schema('string'), Boolean: schema('boolean'), Enum: schema('enum'), Optional: schema('optional') } },
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  }
  return { tools, pi: pi as unknown as OmpExtensionApi }
}

async function loadExtension(url?: string, token?: string) {
  vi.resetModules()
  vi.stubEnv('PRIME_WORK_SCHEDULE_URL', url ?? undefined as unknown as string)
  vi.stubEnv('PRIME_WORK_SCHEDULE_TOKEN', token ?? undefined as unknown as string)
  return (await import('../../assets/extensions/omp-work-schedules')).default
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'omp-schedule-extension-'))
  const service = new AutomationService(new JsonStateStore(join(dir, 'state.json')), {
    validateTarget: async () => undefined,
    validateExecution: async () => undefined,
    run: async () => ({}),
    now: () => new Date('2030-01-01T00:00:00Z'),
  })
  const bridge = new AgentScheduleBridge({
    service, harness: 'omp', skillPath: '/app/skills/schedules',
    resolveScope: async ({ sessionPath }) => ({ projectId: 'omp-project', sessionId: sessionPath ? 'omp-session' : undefined }),
  })
  await bridge.start()
  cleanups.push(async () => { await bridge.stop(); rmSync(dir, { recursive: true, force: true }) })
  const environment = bridge.environmentFor({ cwd: '/project', sessionPath: '/sessions/omp.jsonl' })
  const factory = await loadExtension(environment.PRIME_WORK_SCHEDULE_URL, environment.PRIME_WORK_SCHEDULE_TOKEN)
  const { tools, pi } = fakePi()
  factory(pi)
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
  return { service, tools, tool }
}

describe('omp-work-schedules extension', () => {
  it('registers only when a scoped broker claim is available', async () => {
    const factory = await loadExtension()
    const { tools, pi } = fakePi()
    factory(pi)
    expect(tools).toEqual([])
  })

  it('forwards tool cancellation to the broker fetch', async () => {
    const factory = await loadExtension('http://127.0.0.1:1/v1/call', 'token')
    const { tools, pi } = fakePi()
    factory(pi)
    const controller = new AbortController()
    controller.abort(new Error('Cancelled by caller'))
    const fetchCall = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(options.signal).toBe(controller.signal)
      throw controller.signal.reason
    })
    vi.stubGlobal('fetch', fetchCall)
    await expect(tools[0].execute('cancel', {}, controller.signal)).rejects.toThrow('Cancelled by caller')
  })

  it('creates, lists, updates, and manages OMP schedules through the broker', async () => {
    const { service, tools, tool } = await fixture()
    expect(tools.map((candidate) => candidate.name)).toEqual([
      'scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage',
    ])
    await tool('scheduled_task_create_once').execute('one', { prompt: 'Check OMP', at: '2030-01-02T00:00:00Z', target: 'current_session' })
    const task = service.list('omp')[0]
    expect(task).toMatchObject({ harness: 'omp', prompt: 'Check OMP', target: { kind: 'session', sessionId: 'omp-session' } })
    await tool('scheduled_task_update').execute('two', { id: task.id, title: 'Updated OMP task', thinking: 'high' })
    expect(service.get(task.id)).toMatchObject({ title: 'Updated OMP task', execution: { model: 'auto', thinking: 'high', speed: 'normal' } })
    await tool('scheduled_task_manage').execute('three', { id: task.id, action: 'pause' })
    expect(service.get(task.id).status).toBe('paused')
    const listed = await tool('scheduled_tasks_list').execute('four', {})
    expect(listed.content[0].text).toContain('Updated OMP task')
  })
})
