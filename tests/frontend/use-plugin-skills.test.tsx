// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { usePluginSkills } from '../../src/hooks/usePluginSkills'
import type { HarnessId, PluginCatalog, PrimeWorkApi, SkillRecord } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const skill: SkillRecord = { id: 'skill', name: 'Skill', kind: 'skill', location: 'project', enabled: true, description: '' }
it('retains the catalog during same-scope session changes and clears it for a new harness or folder', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const requests: Array<(catalog: PluginCatalog) => void> = []
  const list = vi.fn(() => new Promise<PluginCatalog>((resolve) => requests.push(resolve)))
  const bridge = { plugins: { list } } as unknown as PrimeWorkApi
  const reportError = vi.fn()
  let current!: ReturnType<typeof usePluginSkills>
  function Probe({ generation, harness = 'prime', scope = '/project' }: { generation: number; harness?: HarnessId; scope?: string }) {
    current = usePluginSkills({ bridge, harness, scope, generation, initialSkills: [], reportError })
    return null
  }
  try {
    await act(async () => root.render(<Probe generation={1} />))
    await act(async () => requests[0]({ skills: [skill], warnings: [] }))
    expect(current.skills).toEqual([skill])
    await act(async () => root.render(<Probe generation={2} />))
    expect(current.skills).toEqual([skill])
    expect(current.loading).toBe(false)
    await act(async () => root.render(<Probe generation={3} harness="omp" />))
    expect(current.skills).toEqual([])
    await act(async () => requests[1]({ skills: [{ ...skill, name: 'stale' }], warnings: [] }))
    expect(current.skills).toEqual([])
    await act(async () => requests[2]({ skills: [skill], warnings: [] }))
    expect(current.skills).toEqual([skill])
    await act(async () => root.render(<Probe generation={4} harness="omp" scope="/other" />))
    expect(current.skills).toEqual([])
  } finally { act(() => root.unmount()); host.remove() }
})
