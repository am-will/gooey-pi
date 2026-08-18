// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectorTabsFor, resolveInspectorTab } from '../../src/components/Inspector'
import { SubagentsPanel } from '../../src/components/inspector/SubagentsPanel'
import { useSubagents } from '../../src/hooks/useSubagents'
import { SUBAGENT_SUBSCRIPTION_LADDER } from '../../src/hooks/useSubagents'
import type { PrimeWorkApi, RuntimeInfo, SubagentRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const runtime = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  runtimeId: 'r1', harness: 'omp', cwd: '/project', isStreaming: false, subagentInspectionSupported: true, ...overrides,
})

describe('inspector capability gating', () => {
  it('offers the Subagents tab only when the runtime reports the capability', () => {
    expect(inspectorTabsFor(runtime()).map((tab) => tab.id)).toEqual(['summary', 'changes', 'browser', 'files', 'subagents'])
    expect(inspectorTabsFor(runtime({ harness: 'pi', subagentInspectionSupported: false })).map((tab) => tab.id)).toEqual(['summary', 'changes', 'browser', 'files'])
    expect(inspectorTabsFor(null).map((tab) => tab.id)).toEqual(['summary', 'changes', 'browser', 'files'])
    expect(inspectorTabsFor(undefined).map((tab) => tab.id)).toEqual(['summary', 'changes', 'browser', 'files'])
  })

  it('falls back to Summary when a persisted default names an unavailable tab', () => {
    // defaultInspectorTab is persisted, so switching OMP to pi can leave a
    // stored 'subagents' pointing at a tab this harness cannot render.
    const gated = inspectorTabsFor(runtime({ subagentInspectionSupported: false }))
    expect(resolveInspectorTab('subagents', gated)).toBe('summary')
    expect(resolveInspectorTab('changes', gated)).toBe('changes')
    expect(resolveInspectorTab('subagents', inspectorTabsFor(runtime()))).toBe('subagents')
  })
})

describe('subagents panel', () => {
  const render = async (node: React.ReactNode) => { await act(async () => root.render(node)) }

  it('shows one row per subagent with its live tool and status', async () => {
    const subagents: SubagentRecord[] = [
      { id: 'AlphaReader', description: 'AlphaReader', agent: 'task', status: 'running', index: 0, durationMs: 3761, toolCount: 3, tokens: 4529, lastIntent: 'Search for "alpha"', recentTools: [{ tool: 'grep' }], resolvedModel: 'anthropic/claude-haiku-4-5', updatedAt: 1 },
      { id: 'BetaReader', description: 'BetaReader', agent: 'task', status: 'completed', index: 1, durationMs: 24174, toolCount: 4, updatedAt: 1 },
    ]
    await render(<SubagentsPanel subagents={subagents} mode="push" />)
    const rows = container.querySelectorAll('.subagent-row')
    expect(rows).toHaveLength(2)
    expect(container.textContent).toContain('AlphaReader')
    expect(container.textContent).toContain('Search for "alpha"')
    expect(container.textContent).toContain('3 tools')
    expect(container.textContent).toContain('Finished')
    expect(container.querySelector('.subagent-row--running')).not.toBeNull()
  })

  it('explains an empty roster and an unsupported harness differently', async () => {
    await render(<SubagentsPanel subagents={[]} mode="push" shortName="OMP" />)
    expect(container.textContent).toContain('No subagents running')

    await render(<SubagentsPanel subagents={[]} mode="unsupported" shortName="OMP" />)
    expect(container.textContent).toContain('Subagents unavailable')
  })

  it('discloses when the roster is polled instead of pushed', async () => {
    await render(<SubagentsPanel subagents={[{ id: 'a', status: 'running', updatedAt: 1 }]} mode="poll" />)
    expect(container.querySelector('.subagent-note')?.textContent).toContain('refreshed on a timer')
  })
})

describe('subagent subscription lifecycle', () => {
  function harness(overrides: { command?: ReturnType<typeof vi.fn> } = {}) {
    const listeners: Array<(envelope: { runtimeId: string; event: Record<string, unknown> }) => void> = []
    const command = overrides.command ?? vi.fn(async () => ({ data: { subagents: [] } }))
    const bridge = { agent: { command, onEvent: (callback: (envelope: { runtimeId: string; event: Record<string, unknown> }) => void) => { listeners.push(callback); return () => { listeners.splice(listeners.indexOf(callback), 1) } } } } as unknown as PrimeWorkApi
    return { bridge, command, emit: (event: Record<string, unknown>) => { for (const listener of [...listeners]) listener({ runtimeId: 'r1', event }) }, listeners }
  }

  function Probe({ bridge, active, runtime: info }: { bridge: PrimeWorkApi; active: boolean; runtime: RuntimeInfo | null }) {
    const api = useSubagents({ bridge, runtime: info, active })
    return <div data-mode={api.mode}>{api.subagents.map((entry) => <span className="row" key={entry.id}>{entry.id}:{entry.status}</span>)}</div>
  }

  it('never requests the events level', () => {
    expect(SUBAGENT_SUBSCRIPTION_LADDER).toEqual(['progress'])
    expect(SUBAGENT_SUBSCRIPTION_LADDER).not.toContain('events')
  })

  it('subscribes at progress when the panel opens and returns to off when it closes', async () => {
    const { bridge, command } = harness()
    await act(async () => root.render(<Probe bridge={bridge} active={true} runtime={runtime()} />))
    expect(command).toHaveBeenCalledWith('r1', { type: 'set_subagent_subscription', level: 'progress' })
    expect(command).toHaveBeenCalledWith('r1', { type: 'get_subagents' })
    expect(container.firstElementChild?.getAttribute('data-mode')).toBe('push')

    command.mockClear()
    await act(async () => root.render(<Probe bridge={bridge} active={false} runtime={runtime()} />))
    expect(command).toHaveBeenCalledWith('r1', { type: 'set_subagent_subscription', level: 'off' })
  })

  it('sends nothing at all for a harness without the capability', async () => {
    const { bridge, command } = harness()
    await act(async () => root.render(<Probe bridge={bridge} active={true} runtime={runtime({ harness: 'pi', subagentInspectionSupported: false })} />))
    expect(command).not.toHaveBeenCalled()
    expect(container.firstElementChild?.getAttribute('data-mode')).toBe('unsupported')
  })

  it('degrades to polling when the harness refuses the subscription', async () => {
    const command = vi.fn(async (_runtimeId: string, payload: Record<string, unknown>) => {
      if (payload.type === 'set_subagent_subscription') throw new Error('Unknown command: set_subagent_subscription')
      return { data: { subagents: [{ id: 'Alpha', status: 'running', progress: { id: 'Alpha', status: 'running' } }] } }
    })
    const { bridge } = harness({ command })
    await act(async () => root.render(<Probe bridge={bridge} active={true} runtime={runtime()} />))
    expect(container.firstElementChild?.getAttribute('data-mode')).toBe('poll')
    expect(container.querySelector('.row')?.textContent).toBe('Alpha:running')
  })

  it('reports unsupported when neither the subscription nor the roster query answers', async () => {
    const command = vi.fn(async () => { throw new Error('Unknown command') })
    const { bridge } = harness({ command })
    await act(async () => root.render(<Probe bridge={bridge} active={true} runtime={runtime()} />))
    expect(container.firstElementChild?.getAttribute('data-mode')).toBe('unsupported')
  })

  it('applies push frames for its own runtime and retires finished rows on the next turn', async () => {
    const { bridge, emit } = harness()
    await act(async () => root.render(<Probe bridge={bridge} active={true} runtime={runtime()} />))

    await act(async () => emit({ type: 'subagent_lifecycle', payload: { id: 'Alpha', status: 'started', agent: 'task' } }))
    expect(container.querySelector('.row')?.textContent).toBe('Alpha:started')

    await act(async () => emit({ type: 'subagent_progress', payload: { progress: { id: 'Alpha', status: 'completed', toolCount: 2 } } }))
    expect(container.querySelector('.row')?.textContent).toBe('Alpha:completed')

    await act(async () => emit({ type: 'agent_start' }))
    expect(container.querySelectorAll('.row')).toHaveLength(0)
  })
})
