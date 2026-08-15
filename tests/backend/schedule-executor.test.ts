import { describe, expect, it, vi } from 'vitest'
import { ScheduledRunExecutor } from '../../electron/main/schedules/executor'
import type { AutomationScheduleRecord, HarnessId } from '../../src/types/api'

function task(harness: HarnessId, prompt: string): AutomationScheduleRecord {
  return {
    schemaVersion: 1,
    id: `task-${harness}`,
    harness,
    revision: 1,
    title: 'MCP policy probe',
    prompt,
    target: { kind: 'project', projectId: `project-${harness}` },
    timing: { kind: 'once', at: '2026-08-15T22:00:00.000Z' },
    execution: { model: 'auto', thinking: 'auto', speed: 'normal' },
    status: 'active',
    createdBy: 'user',
    createdAt: '2026-08-15T21:00:00.000Z',
    updatedAt: '2026-08-15T21:00:00.000Z',
    runs: [],
  }
}

describe('ScheduledRunExecutor MCP auth policy', () => {
  it.each([
    ['prime', '/mcp login notion'],
    ['omp', '/mcp reauth docs'],
    ['pi', '/mcp-auth files'],
  ] as const)('rejects a persisted %s auth task before project lookup or runtime start', async (harness, prompt) => {
    const projects = { list: vi.fn(), authorizeCwd: vi.fn() }
    const sessions = { harness, list: vi.fn(), requireSessionPath: vi.fn() }
    const agents = { startUnattended: vi.fn() }
    const providers = { requireAvailableModel: vi.fn() }
    const executor = new ScheduledRunExecutor(projects as never, sessions as never, agents as never, providers as never, () => new Set())

    await expect(executor.run(task(harness, prompt))).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(projects.list).not.toHaveBeenCalled()
    expect(agents.startUnattended).not.toHaveBeenCalled()
  })
})
