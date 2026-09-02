import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createGitWorktree: vi.fn(),
  listGitWorktrees: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  validateGitBranch: vi.fn(),
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog },
}))

vi.mock('../../electron/main/git', () => ({
  createGitWorktree: mocks.createGitWorktree,
  isNotARepositoryFailure: () => false,
  listGitWorktrees: mocks.listGitWorktrees,
  validateGitBranch: mocks.validateGitBranch,
}))

import { ProjectService } from '../../electron/main/projects'
import { JsonStateStore } from '../../electron/main/store'

const dirs: string[] = []

function folderIdentity(path: string) {
  const info = lstatSync(path, { bigint: true })
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
  }
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'gooeypi-broad-flows-'))
  const root = join(dataDir, 'project')
  dirs.push(dataDir)
  const store = new JsonStateStore(join(dataDir, 'state.json'))
  const service = new ProjectService(store, () => null)
  return { dataDir, root, service, store }
}

async function authorizeNarrowProject(root: string, service: ProjectService, store: JsonStateStore): Promise<void> {
  mkdirSync(root)
  const canonical = realpathSync(root)
  const now = new Date().toISOString()
  await store.update((state) => { state.projects.push({
    id: 'narrow-project', harness: 'prime', name: 'Narrow project', path: canonical, folders: [canonical], primaryFolder: canonical,
    pinned: false, createdAt: now, lastOpenedAt: now, folderIdentities: { [canonical]: folderIdentity(canonical) },
  }) })
  await service.list()
}

beforeEach(() => {
  mocks.createGitWorktree.mockReset().mockResolvedValue(undefined)
  mocks.listGitWorktrees.mockReset().mockResolvedValue([])
  mocks.showOpenDialog.mockReset()
  mocks.showSaveDialog.mockReset()
  mocks.validateGitBranch.mockReset().mockResolvedValue('feature')
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('broad-root flow boundaries', () => {
  it('rejects an inferred filesystem-root grant before session discovery or persistence', async () => {
    const { service, store } = setup()
    const filesystemRoot = realpathSync(resolve('/'))

    await expect(service.grantInferred(filesystemRoot)).rejects.toThrow(/Broad filesystem roots cannot be inferred as projects/)
    expect(store.snapshot().projects).toEqual([])
  })

  it('rejects a broad linked worktree at the central grant boundary', async () => {
    const { root, service, store } = setup()
    await authorizeNarrowProject(root, service, store)
    const filesystemRoot = realpathSync(resolve('/'))
    mocks.listGitWorktrees.mockResolvedValue([
      { path: realpathSync(root), name: 'project', branch: 'main', head: 'a'.repeat(40), current: true, detached: false },
      { path: filesystemRoot, name: 'root', branch: 'unsafe', head: 'b'.repeat(40), current: false, detached: false },
    ])

    await expect(service.adoptCheckoutWorktree('narrow-project', root, filesystemRoot)).rejects.toThrow(/Broad filesystem roots cannot be added as projects/)
    expect(store.snapshot().projects).toHaveLength(1)
  })

  it('rejects a broad create-worktree destination before invoking Git', async () => {
    const { root, service, store } = setup()
    await authorizeNarrowProject(root, service, store)
    mocks.listGitWorktrees.mockResolvedValue([
      { path: realpathSync(root), name: 'project', branch: 'main', head: 'a'.repeat(40), current: true, detached: false },
    ])
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: realpathSync(homedir()) })

    await expect(service.chooseCheckoutWorktreePath(root, 'feature', await mocks.listGitWorktrees())).rejects.toThrow(/Broad filesystem roots cannot be added as worktrees/)
    expect(mocks.createGitWorktree).not.toHaveBeenCalled()
    expect(store.snapshot().projects).toHaveLength(1)
  })
})
