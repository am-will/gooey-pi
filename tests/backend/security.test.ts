import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentEventForwarder, AgentRpcManager } from '../../electron/main/agent-rpc'
import { runProcess, stopChildProcesses } from '../../electron/main/process-utils'
import { PluginService } from '../../electron/main/plugins'
import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'
import type { SessionRecord } from '../../src/types/api'
import { waitUntil } from '../helpers/wait'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }
const identities = (...paths: string[]) => Object.fromEntries(paths.map((path) => { const info = lstatSync(path, { bigint: true }); return [realpathSync(path), { dev: info.dev.toString(), ino: info.ino.toString() }] }))
describe('security boundaries', () => {
  it('does not expose project-configured files outside the project root', async () => {
    const project = temp('prime-work-plugin-')
    const config = join(project, '.prime', 'agent')
    mkdirSync(config, { recursive: true })
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ prompts: ['/etc/hosts'] }))
    const service = new PluginService(null, async () => resolve(project))
    const { skills: records } = await service.list(project)
    expect(records.some((record) => record.path === '/private/etc/hosts' || record.path === '/etc/hosts')).toBe(false)
  })

  it('revokes a removed project immediately and ignores a session rooted at filesystem root', async () => {
    const dir = temp('prime-work-project-')
    const folder = join(dir, 'project'); mkdirSync(folder)
    const store = new JsonStateStore(join(dir, 'state.json'))
    await store.update((state) => { state.projects.push({ id: 'project-1', harness: 'prime', name: 'Project', path: folder, folders: [folder], primaryFolder: folder, pinned: false, createdAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), folderIdentities: identities(folder) }) })
    const service = new ProjectService(store, () => null)
    service.bindProviders({
      sessions: async () => [{ id: 'unsafe', harness: 'prime', filePath: join(dir, 'unsafe.jsonl'), projectPath: '/', title: 'unsafe', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', depth: 0, pinned: false, unread: false } satisfies SessionRecord],
      branch: async () => undefined,
    })
    const listed = await service.list()
    expect(listed.some((project) => project.path === '/')).toBe(false)
    expect(await service.authorizeCwd(folder)).toBe(realpathSync(folder))
    expect(await service.remove('project-1')).toBe(true)
    await expect(service.authorizeCwd(folder)).rejects.toThrow(/not inside/)
  })

  it('authorizes an inferred project discovered from sessions for cwd and Git execution', async () => {
    const dir = temp('prime-work-inferred-')
    const folder = join(dir, 'project'); mkdirSync(folder)
    const store = new JsonStateStore(join(dir, 'state.json'))
    const service = new ProjectService(store, () => null)
    let branchCalls = 0
    service.bindProviders({
      sessions: async () => [{ id: 'session', harness: 'prime', filePath: join(dir, 'session.jsonl'), projectPath: folder, title: 'session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'idle', depth: 0, pinned: false, unread: false } satisfies SessionRecord],
      branch: async (cwd) => { branchCalls += 1; await service.authorizeCwd(cwd); return undefined },
    })
    const listed = await service.list()
    expect(listed).toHaveLength(1)
    expect(listed[0].inferred).toBe(true)
    expect(branchCalls).toBe(1)
    expect(await service.authorizeCwd(folder)).toBe(realpathSync(folder))
    expect(await service.remove(listed[0].id)).toBe(true)
    await expect(service.authorizeCwd(folder)).rejects.toThrow(/not inside/)
  })

  it('awaits TERM/KILL escalation for an RPC child that refuses graceful shutdown', async () => {
    const dir = temp('prime-work-agent-stop-')
    const executable = join(dir, 'fake-agent.cjs')
    const pidFile = join(dir, 'pid')
    writeFileSync(executable, `#!/usr/bin/env node
const readline=require('node:readline');const fs=require('node:fs');fs.writeFileSync(process.env.PRIME_WORK_TEST_PID_FILE,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);readline.createInterface({input:process.stdin}).on('line',(line)=>{const v=JSON.parse(line);if(v.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:v.id,command:v.type,success:true,data:{isStreaming:false}})+'\\n')});process.stdin.resume();`)
    chmodSync(executable, 0o755)
    process.env.PRIME_WORK_TEST_PID_FILE = pidFile
    const manager = new AgentRpcManager(executable, async (cwd) => cwd, async (path) => path)
    const runtime = await manager.start({ cwd: dir })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const started = Date.now()
    expect(await manager.stop(runtime.runtimeId)).toBe(true)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_500)
    expect(() => process.kill(pid, 0)).toThrow()
    delete process.env.PRIME_WORK_TEST_PID_FILE
  }, 10_000)

  it('bounds each outbound agent envelope and aggregate bytes while preserving normal events', () => {
    const envelopeEvents: Array<Record<string, unknown>> = []
    const envelopeForwarder = new AgentEventForwarder('runtime-envelope', (envelope) => envelopeEvents.push(envelope.event), {
      maxEvents: 100,
      maxEnvelopeBytes: 512,
      maxWindowBytes: 2_000,
      windowMs: 60_000,
    })
    envelopeForwarder.emit({ type: 'normal_event', value: 'ok' })
    envelopeForwarder.emit({ type: 'oversized_event', value: '😀'.repeat(200) })

    expect(envelopeEvents.some((event) => event.type === 'normal_event')).toBe(true)
    expect(envelopeEvents.some((event) => event.type === 'oversized_event')).toBe(false)
    expect(envelopeEvents.some((event) => event.type === 'transport_limit' && String(event.error).includes('envelope byte limit'))).toBe(true)

    const windowEnvelopes: Array<{ runtimeId: string; event: Record<string, unknown> }> = []
    const windowForwarder = new AgentEventForwarder('runtime-window', (envelope) => windowEnvelopes.push(envelope), {
      maxEvents: 100,
      maxEnvelopeBytes: 512,
      maxWindowBytes: 700,
      windowMs: 60_000,
    })
    for (let index = 0; index < 10; index += 1) windowForwarder.emit({ type: 'burst_event', index, value: 'x'.repeat(120) })

    const forwardedBytes = windowEnvelopes.reduce((total, envelope) => total + Buffer.byteLength(JSON.stringify(envelope), 'utf8'), 0)
    expect(forwardedBytes).toBeLessThanOrEqual(700)
    expect(windowEnvelopes.some((envelope) => envelope.event.type === 'burst_event')).toBe(true)
    expect(windowEnvelopes.filter((envelope) => envelope.event.type === 'burst_event').length).toBeLessThan(10)

    const lifecycleEvents: Array<Record<string, unknown>> = []
    const lifecycleForwarder = new AgentEventForwarder('runtime-lifecycle', (envelope) => lifecycleEvents.push(envelope.event), {
      maxEvents: 1, maxEnvelopeBytes: 512, maxWindowBytes: 700, windowMs: 60_000,
    })
    lifecycleForwarder.emit({ type: 'message_update', value: 'first' })
    lifecycleForwarder.emit({ type: 'message_update', value: 'dropped' })
    lifecycleForwarder.emit({ type: 'compaction_start', reason: 'overflow' })
    lifecycleForwarder.emit({ type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true })
    lifecycleForwarder.emit({ type: 'agent_end' })
    expect(lifecycleEvents.some((event) => event.type === 'transport_limit')).toBe(true)
    expect(lifecycleEvents.some((event) => event.type === 'compaction_start')).toBe(true)
    expect(lifecycleEvents.some((event) => event.type === 'compaction_end')).toBe(true)
    expect(lifecycleEvents.some((event) => event.type === 'agent_end')).toBe(true)
  })

  it('closes agent admission before stopAll snapshots in-flight starts', async () => {
    const dir = temp('prime-work-agent-admission-')
    const executable = join(dir, 'fake-agent.cjs')
    const spawnMarker = join(dir, 'spawned')
    writeFileSync(executable, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(spawnMarker)}, 'spawned')
setInterval(()=>{},1000)
`)
    chmodSync(executable, 0o755)

    let releaseAuthorization!: () => void
    let markAuthorizationStarted!: () => void
    const authorizationStarted = new Promise<void>((resolveStarted) => { markAuthorizationStarted = resolveStarted })
    let authorizationCalls = 0
    const manager = new AgentRpcManager(executable, async (cwd) => {
      authorizationCalls += 1
      markAuthorizationStarted()
      await new Promise<void>((resolveAuthorization) => { releaseAuthorization = resolveAuthorization })
      return cwd
    }, async (path) => path)

    const starting = manager.start({ cwd: dir })
    await authorizationStarted
    const stopping = manager.stopAll()
    releaseAuthorization()

    await expect(starting).rejects.toThrow(/shutting down/)
    await stopping
    await expect(manager.start({ cwd: dir })).rejects.toThrow(/shutting down/)
    expect(authorizationCalls).toBe(1)
    expect(existsSync(spawnMarker)).toBe(false)
  })

  it('closes one-shot process admission before the cleanup snapshot', async () => {
    const dir = temp('prime-work-process-admission-')
    const runningMarker = join(dir, 'running')
    const deniedMarker = join(dir, 'denied')
    const running = runProcess(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.argv.at(-1),String(process.pid));setInterval(()=>{},1000)`, runningMarker], { timeoutMs: 30_000 })
    await waitUntil(() => existsSync(runningMarker))
    const pid = Number(readFileSync(runningMarker, 'utf8'))

    const cleanup = stopChildProcesses()
    await expect(runProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(process.argv.at(-1),'unexpected')`, deniedMarker])).rejects.toThrow(/admission is closed/)
    await cleanup
    await running

    expect(existsSync(deniedMarker)).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

})
