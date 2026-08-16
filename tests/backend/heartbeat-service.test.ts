import { describe, expect, it, vi } from 'vitest'
import { HeartbeatService } from '../../electron/main/schedules/heartbeats'

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
