import { describe, expect, it } from 'vitest'
import {
  createSingleFlightAdmission,
  EMPTY_GIT_STATUS,
  findRuntimeForWorkspace,
  gitStatusForWorkspace,
  newSessionProject,
  selectStartupWorkspace,
} from '../../src/lib/workspace'
import type { ProjectRecord, RuntimeInfo, SessionRecord } from '../../src/types/api'

const project = (id: string, folders: string[], pinned = false): ProjectRecord => ({
  id,
  harness: 'prime',
  name: id,
  path: folders[0],
  folders,
  primaryFolder: folders[0],
  pinned,
  createdAt: '2025-01-01T00:00:00.000Z',
  lastOpenedAt: '2025-01-01T00:00:00.000Z',
  sessionCount: 1,
})

const session = (id: string, projectPath: string, filePath: string): SessionRecord => ({
  id,
  harness: 'prime',
  projectPath,
  filePath,
  title: id,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  status: 'idle',
  depth: 0,
})

const runtime = (runtimeId: string, cwd: string, sessionFile: string, isStreaming = false): RuntimeInfo => ({
  runtimeId,
  harness: 'prime',
  cwd,
  sessionFile,
  isStreaming,
})

describe('workspace and runtime ownership', () => {
  it('atomically selects the newest session, its multi-folder project, and its exact idle runtime', () => {
    const pinnedProject = project('pinned', ['/pinned'], true)
    const multiFolderProject = project('multi', ['/workspace/root', '/workspace/package'])
    const newestSession = session('newest', '/workspace/package', '/sessions/newest.jsonl')
    const pinnedSession = session('older', '/pinned', '/sessions/older.jsonl')
    const wrongCwd = runtime('wrong-cwd', '/pinned', newestSession.filePath, true)
    const matchingIdle = runtime('matching-idle', '/workspace/package', newestSession.filePath)

    const selected = selectStartupWorkspace(
      [pinnedProject, multiFolderProject],
      [newestSession, pinnedSession],
      [wrongCwd, matchingIdle],
    )

    expect(selected.project?.id).toBe('multi')
    expect(selected.session?.id).toBe('newest')
    expect(selected.cwd).toBe('/workspace/package')
    expect(selected.runtime?.runtimeId).toBe('matching-idle')
  })

  it('invalidates Git data synchronously when the workspace cwd changes', () => {
    const projectAStatus = { isRepo: true, branch: 'project-a', files: [{ path: 'a-only.txt', status: 'M', staged: false, additions: 1, deletions: 0 }] }
    const snapshot = { cwd: '/project-a', status: projectAStatus }

    expect(gitStatusForWorkspace(snapshot, '/project-a')).toBe(projectAStatus)
    // Identity, not just shape: memoized consumers (Inspector) re-render whenever this fallback changes identity.
    expect(gitStatusForWorkspace(snapshot, '/project-b')).toBe(EMPTY_GIT_STATUS)
    expect(gitStatusForWorkspace(snapshot, undefined)).toBe(EMPTY_GIT_STATUS)
    expect(EMPTY_GIT_STATUS).toEqual({ isRepo: false, files: [] })
  })

  it('uses the displayed bootstrap project for New Session without clearing workspace ownership', () => {
    const displayedProject = project('loaded-during-bootstrap', ['/project'])

    expect(newSessionProject(undefined, undefined, displayedProject)).toBe(displayedProject)
    expect(newSessionProject(undefined, undefined, undefined)).toBeUndefined()
  })

  it('does not attach a runtime from another cwd or session', () => {
    const runtimes = [
      runtime('old-project', '/project-a', '/sessions/b.jsonl'),
      runtime('old-session', '/project-b', '/sessions/a.jsonl'),
      runtime('owned', '/project-b', '/sessions/b.jsonl'),
    ]

    expect(findRuntimeForWorkspace(runtimes, '/project-b', '/sessions/b.jsonl')?.runtimeId).toBe('owned')
    expect(findRuntimeForWorkspace(runtimes, '/project-b', '/sessions/missing.jsonl')).toBeUndefined()
  })
})

describe('single-flight prompt admission', () => {
  it('synchronously rejects a second submission while runtime startup is pending', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
    const admission = createSingleFlightAdmission()
    let userMessages = 0
    let runtimeStarts = 0

    const submit = () => admission.run(async () => {
      userMessages += 1
      runtimeStarts += 1
      await startGate
    })

    const first = submit()
    const second = submit()
    expect(admission.active).toBe(true)
    await expect(second).resolves.toBe(false)
    expect(userMessages).toBe(1)
    expect(runtimeStarts).toBe(1)

    releaseStart()
    await expect(first).resolves.toBe(true)
    expect(admission.active).toBe(false)
  })
})
