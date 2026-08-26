import { describe, expect, it } from 'vitest'
import { activeProjectScriptKind, ProjectScriptBusyError, setupNeedsRun } from '../../src/lib/project-scripts'

describe('project script helpers', () => {
  it('only exposes the active run kind for the selected project', () => {
    const run = { projectId: 'project-a', kind: 'run' as const }
    expect(activeProjectScriptKind(run, 'project-a')).toBe('run')
    expect(activeProjectScriptKind(run, 'project-b')).toBeUndefined()
    expect(activeProjectScriptKind(run)).toBeUndefined()
  })

  it.each([
    [undefined, false],
    [{ setup: '', run: '' }, false],
    [{ setup: 'npm install', run: 'npm run dev' }, true],
    [{ setup: 'npm install', run: 'npm run dev', setupLastRun: 'npm ci', setupLastExitCode: 0 }, true],
    [{ setup: 'npm install', run: 'npm run dev', setupLastRun: 'npm install' }, true],
    [{ setup: 'npm install', run: 'npm run dev', setupLastRun: 'npm install', setupLastExitCode: 0 }, false],
  ])('reports whether setup needs to run for %j', (scripts, expected) => {
    expect(setupNeedsRun(scripts)).toBe(expected)
  })

  it('exposes a typed busy error', () => {
    const error = new ProjectScriptBusyError()
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('already starting or running')
  })
})
