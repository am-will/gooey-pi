import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnsupportedRpcCommandError } from '../../electron/main/agent-rpc'
import { HeartbeatService } from '../../electron/main/schedules/heartbeats'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const heartbeat = {
  id: 'heartbeat-one', status: 'active' as const, source: 'rlm_heartbeat' as const,
  prompt: 'poll for steering', schedule: { kind: 'interval', expression: 'every 10s', intervalMs: 10_000 },
  sessionId: 'session-one', sessionFile: '/tmp/session.json', activeSessionId: 'active-one',
  nextRunAt: '2030-01-01T00:00:10.000Z',
}

function fixture(responseData: unknown | unknown[]) {
  const agents = {
    list: vi.fn(() => [{ runtimeId: 'runtime-one' }]),
    command: vi.fn(async () => ({ data: Array.isArray(responseData) ? responseData.shift() : responseData })),
    getForSession: vi.fn(),
  }
  return { service: new HeartbeatService(agents as never, null), agents }
}

describe('HeartbeatService', () => {
  it('discovers RLM heartbeats from a live runtime', async () => {
    const { service } = fixture({ heartbeats: [heartbeat] })
    await expect(service.list()).resolves.toEqual([expect.objectContaining({ id: 'heartbeat-one', source: 'rlm_heartbeat' })])
  })

  it('treats stop as deletion and verifies the job is gone', async () => {
    const { service, agents } = fixture([{ heartbeats: [heartbeat] }, { heartbeat: { ...heartbeat, status: 'cancelled' } }, { heartbeats: [] }])
    await expect(service.manage('heartbeat-one', 'stop')).resolves.toBeNull()
    expect(agents.command).toHaveBeenCalledWith('runtime-one', expect.objectContaining({ type: 'manage_heartbeat', action: 'stop' }))
  })

  it.each(['paused', 'active'] as const)('rejects resuming an MCP authentication heartbeat observed as %s before sending a command', async (status) => {
    const { service, agents } = fixture({ heartbeat })
    vi.spyOn(service, 'list').mockResolvedValue([{ ...heartbeat, schedule: 'every 10s', runtimeId: 'runtime-one', status, prompt: '/mcp login notion' }])

    await expect(service.manage('heartbeat-one', 'resume')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(agents.command).not.toHaveBeenCalled()
  })

  it('allows pausing an MCP authentication heartbeat for cleanup', async () => {
    const { service, agents } = fixture({ heartbeat: { ...heartbeat, status: 'paused' } })
    vi.spyOn(service, 'list').mockResolvedValue([{ ...heartbeat, schedule: 'every 10s', runtimeId: 'runtime-one', prompt: '/mcp login notion' }])

    await expect(service.manage('heartbeat-one', 'pause')).resolves.toMatchObject({ status: 'paused' })
    expect(agents.command).toHaveBeenCalledWith('runtime-one', expect.objectContaining({ type: 'manage_heartbeat', action: 'pause' }))
  })

  it('allows stopping an MCP authentication heartbeat for cleanup', async () => {
    const { service, agents } = fixture({ heartbeat: { ...heartbeat, status: 'cancelled' } })
    vi.spyOn(service, 'list')
      .mockResolvedValueOnce([{ ...heartbeat, schedule: 'every 10s', runtimeId: 'runtime-one', status: 'paused', prompt: '/mcp login notion' }])
      .mockResolvedValueOnce([])

    await expect(service.manage('heartbeat-one', 'stop')).resolves.toBeNull()
    expect(agents.command).toHaveBeenCalledWith('runtime-one', expect.objectContaining({ type: 'manage_heartbeat', action: 'stop' }))
  })

  it('rejects a stop that leaves the heartbeat visible', async () => {
    const { service } = fixture([{ heartbeats: [heartbeat] }, { heartbeat }, { heartbeats: [heartbeat] }])
    await expect(service.manage('heartbeat-one', 'stop')).rejects.toThrow('did not remove')
  })
})

/**
 * A prime-agent CLI whose `schedule list` serves the heartbeat until
 * `schedule cancel` removes it. Every argv is recorded.
 */
function fakePrimeCli(cancelError = ''): { executable: string; argv: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'prime-work-heartbeat-cli-'))
  dirs.push(dir)
  const executable = join(dir, 'prime-agent.cjs')
  const log = join(dir, 'argv.jsonl')
  const cancelled = join(dir, 'cancelled')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'schedule' && args[1] === 'list') {
  const jobs = fs.existsSync(${JSON.stringify(cancelled)}) ? [] : [${JSON.stringify({ ...heartbeat, source: 'heartbeat' })}]
  process.stdout.write(JSON.stringify({ jobs }))
} else if (args[0] === 'schedule' && args[1] === 'cancel') {
  if (${JSON.stringify(cancelError)}) { process.stderr.write(${JSON.stringify(cancelError)}); process.exit(7) }
  fs.writeFileSync(${JSON.stringify(cancelled)}, args[2])
} else {
  process.exit(2)
}
`)
  chmodSync(executable, 0o755)
  return { executable, argv: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]) : [] }
}

describe('HeartbeatService on Rust Prime', () => {
  /** A runtime open on the heartbeat's session whose harness has no heartbeat commands, as Rust Prime's adapter refuses them. */
  function rustRuntime(executable: string, error: Error = new UnsupportedRpcCommandError('manage_heartbeat', 'Rust Prime Agent')) {
    const runtime = { runtimeId: 'rust-runtime', sessionFile: heartbeat.sessionFile }
    const agents = {
      list: vi.fn(() => [runtime]),
      getForSession: vi.fn((file: string) => file === heartbeat.sessionFile ? runtime : undefined),
      command: vi.fn(async (_runtimeId: string, command: { type: string }) => {
        if (command.type === 'list_heartbeats') return { data: { heartbeats: [] } }
        throw error
      }),
    }
    return { agents, service: new HeartbeatService(agents as never, executable, () => 'rust') }
  }

  it('stops a heartbeat through the CLI when the runtime has no heartbeat commands', async () => {
    const cli = fakePrimeCli()
    const { service, agents } = rustRuntime(cli.executable)

    await expect(service.manage('heartbeat-one', 'stop')).resolves.toBeNull()
    expect(agents.command).toHaveBeenCalledWith('rust-runtime', expect.objectContaining({ type: 'manage_heartbeat', action: 'stop' }))
    expect(cli.argv()).toContainEqual(['schedule', 'cancel', 'heartbeat-one'])
  })

  it('reports the CLI stop failure without exposing credentials or unbounded stderr', async () => {
    const cli = fakePrimeCli(`ignored diagnostic\nPermission denied Bearer abcdefghijklmnop ${'detail '.repeat(80)}`)
    const { service } = rustRuntime(cli.executable)
    await expect(service.manage('heartbeat-one', 'stop')).rejects.toThrow('Could not stop this native heartbeat: Permission denied [redacted]')
    try { await service.manage('heartbeat-one', 'stop') } catch (error) {
      expect(String(error)).not.toContain('abcdefghijklmnop')
      expect(String(error).length).toBeLessThan(260)
    }
  })

  it.each(['pause', 'resume'] as const)('explains that %s needs the Rust Prime background service', async (action) => {
    const cli = fakePrimeCli()
    const { service } = rustRuntime(cli.executable)

    await expect(service.manage('heartbeat-one', action)).rejects.toThrow('Rust Prime Agent pauses and resumes native heartbeats only through its background service')
    expect(cli.argv().map((args) => args[1])).not.toContain('cancel')
  })

  it('gives the same explanation when no runtime owns the job', async () => {
    const cli = fakePrimeCli()
    const agents = { list: vi.fn(() => []), getForSession: vi.fn(), command: vi.fn() }
    const service = new HeartbeatService(agents as never, cli.executable, () => 'rust')

    await expect(service.manage('heartbeat-one', 'pause')).rejects.toThrow('only through its background service')
    expect(agents.command).not.toHaveBeenCalled()
  })

  it('keeps the TypeScript advice when no runtime owns the job', async () => {
    const cli = fakePrimeCli()
    const agents = { list: vi.fn(() => []), getForSession: vi.fn(), command: vi.fn() }
    const service = new HeartbeatService(agents as never, cli.executable, () => 'typescript')

    await expect(service.manage('heartbeat-one', 'pause')).rejects.toThrow('Open the owning Prime session before pausing or resuming this native heartbeat')
  })

  it('propagates any other runtime failure without falling back to the CLI', async () => {
    const cli = fakePrimeCli()
    const { service } = rustRuntime(cli.executable, new Error('manage rejected by the harness'))

    await expect(service.manage('heartbeat-one', 'stop')).rejects.toThrow('manage rejected by the harness')
    expect(cli.argv().map((args) => args[1])).not.toContain('cancel')
  })
})
