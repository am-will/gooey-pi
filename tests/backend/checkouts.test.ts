import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckoutService } from '../../electron/main/checkouts'
import { GitService } from '../../electron/main/git'
import { ProjectService } from '../../electron/main/projects'
import { RepositoryUseGate } from '../../electron/main/repository-use-gate'
import { JsonStateStore } from '../../electron/main/store'
import type { CheckoutStrategy } from '../../src/types/api'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() } }))

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function runGit(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-checkouts-'))
  dirs.push(dir)
  const root = join(dir, 'project')
  mkdirSync(root)
  runGit(root, 'init', '-q')
  runGit(root, 'config', 'user.name', 'GooeyPi Test')
  runGit(root, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(root, 'file.txt'), 'base\n')
  runGit(root, 'add', 'file.txt')
  runGit(root, 'commit', '-qm', 'base')
  runGit(root, 'branch', 'feature/local')
  const canonical = realpathSync(root)
  const info = lstatSync(canonical, { bigint: true })
  const store = new JsonStateStore(join(dir, 'state.json'))
  const now = new Date().toISOString()
  await store.update((state) => { state.projects.push({
    id: 'project', harness: 'prime', name: 'Project', path: canonical, folders: [canonical], primaryFolder: canonical,
    pinned: false, createdAt: now, lastOpenedAt: now,
    folderIdentities: { [canonical]: { dev: info.dev.toString(), ino: info.ino.toString(), birthtimeNs: info.birthtimeNs.toString() } },
  }) })
  const projects = new ProjectService(store, () => null)
  const git = new GitService(async (cwd) => cwd)
  projects.bindProviders({ sessions: async () => [], branch: (cwd) => git.branch(cwd) })
  await projects.list()
  let strategy: CheckoutStrategy = 'branch'
  const gate = new RepositoryUseGate()
  const service = new CheckoutService(() => strategy, projects, gate)
  return { root: canonical, store, projects, service, gate, setStrategy: (value: CheckoutStrategy) => { strategy = value } }
}

describe('CheckoutService', () => {
  it('switches a clean local branch without changing project identity or folders', async () => {
    const { root, service } = await setup()
    const before = await service.list('project')
    expect(before).toMatchObject({ strategy: 'branch', activeName: runGit(root, 'branch', '--show-current') })

    const result = await service.execute('project', { strategy: 'branch', operation: 'switch', branch: 'feature/local' })

    expect(result).toMatchObject({ kind: 'applied', project: { id: 'project', path: root, primaryFolder: root, folders: [root], gitBranch: 'feature/local' } })
    expect(runGit(root, 'branch', '--show-current')).toBe('feature/local')
  })

  it('refuses dirty files and active workspace use without changing branches', async () => {
    const { root, service, gate } = await setup()
    const initial = runGit(root, 'branch', '--show-current')
    writeFileSync(join(root, 'untracked.txt'), 'keep\n')
    await expect(service.execute('project', { strategy: 'branch', operation: 'switch', branch: 'feature/local' })).resolves.toMatchObject({ kind: 'refused', code: 'dirty-worktree' })
    expect(runGit(root, 'branch', '--show-current')).toBe(initial)
    rmSync(join(root, 'untracked.txt'))

    const lease = await gate.beginWorkspaceUse(root, { kind: 'agent', harness: 'prime', runtimeId: 'runtime' })
    await expect(service.execute('project', { strategy: 'branch', operation: 'switch', branch: 'feature/local' })).resolves.toMatchObject({ kind: 'refused', code: 'active-work' })
    expect(runGit(root, 'branch', '--show-current')).toBe(initial)
    lease.release()
  })

  it('keeps worktrees as the default strategy and rejects stale strategy actions', async () => {
    const { root, service, setStrategy } = await setup()
    setStrategy('worktree')
    await expect(service.list('project')).resolves.toMatchObject({ strategy: 'worktree', activePath: root })
    await expect(service.execute('project', { strategy: 'branch', operation: 'switch', branch: 'feature/local' })).resolves.toMatchObject({ kind: 'refused', code: 'strategy-changed' })
    expect(runGit(root, 'branch', '--show-current')).not.toBe('feature/local')
  })
})
