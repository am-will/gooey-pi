import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { createAndSwitchGitBranch, createGitWorktree, GIT_DIFF_LINE_LIMIT, GIT_STATUS_ENTRY_LIMIT, GitService, inspectGitWorktreeClean, listGitWorktrees, listLocalGitBranches, switchGitBranch } from '../../electron/main/git'
import { restrictedGitEnvironment } from '../../electron/main/process-utils'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}
const repository = (prefix = 'prime-work-git-') => {
  const cwd = mkdtempSync(join(tmpdir(), prefix)); dirs.push(cwd)
  git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Prime Work Test'); git(cwd, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(cwd, 'file.txt'), 'base\n'); git(cwd, 'add', 'file.txt'); git(cwd, 'commit', '-qm', 'base')
  return cwd
}

describe('GitService', () => {
  it('lists local branches and switches without consulting remotes', async () => {
    const cwd = repository('prime-work-git-branches-')
    git(cwd, 'branch', 'feature/local')
    git(cwd, 'remote', 'add', 'origin', cwd)
    git(cwd, 'fetch', '-q', 'origin', 'feature/local:refs/remotes/origin/remote-only')
    const initialBranch = spawnSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).stdout.trim()

    expect(await listLocalGitBranches(cwd)).toEqual([
      { name: 'feature/local', current: false },
      { name: initialBranch, current: true },
    ])
    await expect(switchGitBranch(cwd, 'feature/local')).resolves.toEqual({ kind: 'applied' })
    await expect(switchGitBranch(cwd, 'feature/local')).resolves.toEqual({ kind: 'unchanged' })
    await expect(switchGitBranch(cwd, 'remote-only')).resolves.toEqual({ kind: 'not-found' })
    await expect(createAndSwitchGitBranch(cwd, initialBranch)).resolves.toEqual({ kind: 'already-exists' })
    writeFileSync(join(cwd, 'untracked.txt'), 'keep me\n')
    await expect(switchGitBranch(cwd, initialBranch)).resolves.toMatchObject({ kind: 'dirty', changedPaths: ['untracked.txt'] })
    expect((await listLocalGitBranches(cwd)).find((branch) => branch.current)?.name).toBe('feature/local')
  })

  it('creates a local branch from HEAD and refuses dirty work', async () => {
    const cwd = repository('prime-work-git-create-branch-')
    expect(await inspectGitWorktreeClean(cwd)).toEqual({ kind: 'clean' })
    await expect(createAndSwitchGitBranch(cwd, 'feature/new')).resolves.toEqual({ kind: 'applied' })
    expect((await listLocalGitBranches(cwd)).find((branch) => branch.current)?.name).toBe('feature/new')

    writeFileSync(join(cwd, 'untracked.txt'), 'keep me\n')
    await expect(inspectGitWorktreeClean(cwd)).resolves.toMatchObject({ kind: 'dirty', changedPaths: ['untracked.txt'] })
    await expect(createAndSwitchGitBranch(cwd, 'feature/refused')).resolves.toMatchObject({ kind: 'dirty', changedPaths: ['untracked.txt'] })
    expect((await listLocalGitBranches(cwd)).some((branch) => branch.name === 'feature/refused')).toBe(false)
  })

  it('does not execute repository clean filters while inspecting or switching branches', async () => {
    const cwd = repository('prime-work-git-branch-filter-')
    const marker = join(cwd, 'filter-ran')
    const filter = join(cwd, 'filter.sh')
    writeFileSync(filter, `#!/bin/sh\nprintf ran >> ${JSON.stringify(marker)}\ncat\n`)
    chmodSync(filter, 0o755)
    git(cwd, 'add', 'filter.sh')
    git(cwd, 'commit', '-qm', 'add inert filter fixture')
    git(cwd, 'branch', 'feature/filtered')
    git(cwd, 'config', 'filter.hostile.clean', filter)
    git(cwd, 'config', 'filter.hostile.smudge', filter)

    await expect(inspectGitWorktreeClean(cwd)).resolves.toEqual({ kind: 'clean' })
    await expect(switchGitBranch(cwd, 'feature/filtered')).rejects.toThrow(/clean\/smudge filters/i)
    expect(existsSync(marker)).toBe(false)
  })

  it('reports, diffs, stages, unstages, restores, and commits through argv-only commands', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd)

    writeFileSync(join(cwd, 'file.txt'), 'base\nchanged\n')
    let status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(status.files.find((file) => file.path === 'file.txt')?.staged).toBe(false)
    expect((await service.diff(cwd, 'file.txt', false)).text).toContain('+changed')

    expect(await service.stage(cwd, ['file.txt'])).toBe(true)
    status = await service.status(cwd)
    expect(status.files.find((file) => file.path === 'file.txt')?.staged).toBe(true)
    expect(await service.unstage(cwd, ['file.txt'])).toBe(true)
    expect(await service.restore(cwd, ['file.txt'])).toBe(true)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('base\n')

    writeFileSync(join(cwd, 'file.txt'), 'base\ncommitted\n')
    await service.stage(cwd, ['file.txt'])
    const committed = await service.commit(cwd, 'test commit')
    expect(committed.ok).toBe(true)
    expect(committed.output).toContain('test commit')
  }, 15_000)

  it('uses repository-relative status paths for every action from a nested cwd', async () => {
    const cwd = repository('prime-work-git-nested-')
    const nested = join(cwd, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'nested.txt'), 'base\n')
    git(cwd, 'add', 'packages/app/nested.txt')
    git(cwd, 'commit', '-qm', 'add nested file')
    const service = new GitService(async (candidate) => candidate)

    writeFileSync(join(nested, 'nested.txt'), 'base\nchanged\n')
    let status = await service.status(nested)
    expect(status.files.find((file) => file.path === 'packages/app/nested.txt')?.staged).toBe(false)
    expect((await service.diff(nested, 'packages/app/nested.txt', false)).text).toContain('+changed')

    expect(await service.stage(nested, ['packages/app/nested.txt'])).toBe(true)
    status = await service.status(nested)
    expect(status.files.find((file) => file.path === 'packages/app/nested.txt')?.staged).toBe(true)
    expect(await service.unstage(nested, ['packages/app/nested.txt'])).toBe(true)
    expect(await service.restore(nested, ['packages/app/nested.txt'])).toBe(true)
    expect(readFileSync(join(nested, 'nested.txt'), 'utf8')).toBe('base\n')
  })

  it('unstages files on an unborn HEAD without changing working content', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-git-unborn-'))
    dirs.push(cwd)
    git(cwd, 'init', '-q')
    writeFileSync(join(cwd, 'first.txt'), 'staged version\n')
    git(cwd, 'add', 'first.txt')
    writeFileSync(join(cwd, 'first.txt'), 'working version\n')
    const service = new GitService(async () => cwd)

    expect(await service.unstage(cwd, ['first.txt'])).toBe(true)
    expect(spawnSync('git', ['ls-files', '--', 'first.txt'], { cwd, encoding: 'utf8' }).stdout).toBe('')
    expect(readFileSync(join(cwd, 'first.txt'), 'utf8')).toBe('working version\n')
    const status = await service.status(cwd)
    expect(status.files.find((file) => file.path === 'first.txt')).toMatchObject({ staged: false, status: '??' })
  })

  it('reads a safe user identity and supplies it explicitly when committing', async () => {
    const cwd = repository('prime-work-git-identity-')
    const home = mkdtempSync(join(tmpdir(), 'prime-work-git-home-'))
    dirs.push(home)
    git(cwd, 'config', '--unset', 'user.name')
    git(cwd, 'config', '--unset', 'user.email')
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Desktop User\n  email = desktop@example.com\n[include]\n  path = /definitely/not/read\n')
    writeFileSync(join(cwd, 'file.txt'), 'identity\n')
    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const service = new GitService(async () => cwd)
      await service.stage(cwd, ['file.txt'])
      const committed = await service.commit(cwd, 'safe identity')
      expect(committed.ok).toBe(true)
      const author = spawnSync('git', ['show', '-s', '--format=%an <%ae>', 'HEAD'], { cwd, encoding: 'utf8' })
      expect(author.stdout.trim()).toBe('Desktop User <desktop@example.com>')
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
    }
  })

  it('identifies a detached HEAD as a repository branch label', async () => {
    const cwd = repository('prime-work-git-detached-')
    git(cwd, 'checkout', '-q', '--detach')
    const service = new GitService(async () => cwd)

    expect(await service.branch(cwd)).toMatch(/^HEAD \([0-9a-f]+\)$/)
    expect((await service.status(cwd)).isRepo).toBe(true)
  })

  it('represents a file with staged and unstaged edits in both scopes', async () => {
    const cwd = repository('prime-work-git-scopes-')
    const service = new GitService(async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'base\nstaged\n')
    await service.stage(cwd, ['file.txt'])
    writeFileSync(join(cwd, 'file.txt'), 'base\nstaged\nunstaged\n')

    const changes = (await service.status(cwd)).files.filter((file) => file.path === 'file.txt')
    expect(changes).toHaveLength(2)
    expect(changes.find((file) => file.staged)?.additions).toBe(1)
    expect(changes.find((file) => !file.staged)?.additions).toBe(1)
  })
  it('respects the user global excludes file (~/.config/git/ignore) for untracked files', async () => {
    const cwd = repository('prime-work-git-global-excludes-')
    const home = mkdtempSync(join(tmpdir(), 'prime-work-git-home-'))
    dirs.push(home)
    mkdirSync(join(home, '.config', 'git'), { recursive: true })
    writeFileSync(join(home, '.config', 'git', 'ignore'), '.idea/\n')
    mkdirSync(join(cwd, '.idea'))
    writeFileSync(join(cwd, '.idea', 'misc.xml'), '<misc/>\n')
    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const service = new GitService(async () => cwd)
      const status = await service.status(cwd)
      expect(status.files.find((file) => file.path === '.idea/misc.xml')).toBeUndefined()
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
    }
  })

  it('restores staged, unstaged, and untracked changes to a clean worktree', async () => {
    const cwd = repository('prime-work-git-restore-all-')
    const service = new GitService(async () => cwd)

    writeFileSync(join(cwd, 'file.txt'), 'base\nstaged\n')
    await service.stage(cwd, ['file.txt'])
    writeFileSync(join(cwd, 'file.txt'), 'base\nstaged\nunstaged\n')
    writeFileSync(join(cwd, 'new.txt'), 'new\n')

    expect(await service.restore(cwd, ['file.txt', 'new.txt'])).toBe(true)
    expect(readFileSync(join(cwd, 'file.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    expect((await service.status(cwd)).files).toEqual([])
  })

  it('does not execute repository fsmonitor, external diff, hook, or filter programs and strips process secrets/config injection', async () => {
    const cwd = repository('prime-work-git-hostile-')
    const marker = join(cwd, 'helper-ran')
    const helper = join(cwd, 'hostile-helper.sh')
    const filter = join(cwd, 'hostile-filter.sh')
    writeFileSync(helper, `#!/bin/sh
printf '%s:%s\n' "$1" "$PRIME_WORK_TEST_TOKEN" >> ${JSON.stringify(marker)}
exit 1
`)
    writeFileSync(filter, `#!/bin/sh
printf 'filter:%s\n' "$PRIME_WORK_TEST_TOKEN" >> ${JSON.stringify(marker)}
cat
`)
    chmodSync(helper, 0o755); chmodSync(filter, 0o755)
    git(cwd, 'config', 'core.fsmonitor', helper)
    git(cwd, 'config', 'diff.external', helper)
    git(cwd, 'config', 'filter.hostile.clean', filter)
    git(cwd, 'config', 'filter.hostile.smudge', filter)
    git(cwd, 'config', 'filter.hostile.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), '*.txt filter=hostile\n')
    mkdirSync(join(cwd, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), `#!/bin/sh
printf 'hook:%s\n' "$PRIME_WORK_TEST_TOKEN" >> ${JSON.stringify(marker)}
exit 1
`)
    chmodSync(join(cwd, '.git', 'hooks', 'pre-commit'), 0o755)
    writeFileSync(join(cwd, 'file.txt'), 'base\nchanged\n')

    const oldValues = {
      token: process.env.PRIME_WORK_TEST_TOKEN,
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    }
    process.env.PRIME_WORK_TEST_TOKEN = 'top-secret-token'
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'core.fsmonitor'
    process.env.GIT_CONFIG_VALUE_0 = helper
    try {
      const env = restrictedGitEnvironment()
      expect(env.PRIME_WORK_TEST_TOKEN).toBeUndefined()
      expect(env.GIT_CONFIG_COUNT).toBeUndefined()
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined()
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined()

      const service = new GitService(async () => cwd)
      const status = await service.status(cwd)
      expect(status.isRepo).toBe(true)
      expect(status.error).toMatch(/clean\/smudge filters cannot run safely.*file\.txt/i)
      await expect(service.diff(cwd, 'file.txt', false)).rejects.toThrow(/clean\/smudge filters cannot run safely.*file\.txt/i)
      await expect(service.stage(cwd, ['file.txt'])).rejects.toThrow(/clean\/smudge filters cannot run safely.*file\.txt/i)
      await expect(service.restore(cwd, ['file.txt'])).rejects.toThrow(/clean\/smudge filters cannot run safely.*file\.txt/i)

      writeFileSync(join(cwd, 'file.txt'), 'base\n')
      writeFileSync(join(cwd, 'README.md'), 'safe change\n')
      expect(await service.stage(cwd, ['README.md'])).toBe(true)
      expect((await service.commit(cwd, 'hostile helpers disabled')).ok).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      const restore = (key: string, value: string | undefined) => { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      restore('PRIME_WORK_TEST_TOKEN', oldValues.token)
      restore('GIT_CONFIG_COUNT', oldValues.count)
      restore('GIT_CONFIG_KEY_0', oldValues.key)
      restore('GIT_CONFIG_VALUE_0', oldValues.value)
    }
  }, 20_000)

  it('inspects filtered changes beyond the status display cap', async () => {
    const cwd = repository('prime-work-git-filter-cap-')
    for (let index = 0; index < GIT_STATUS_ENTRY_LIMIT; index += 1) {
      writeFileSync(join(cwd, `bulk-${String(index).padStart(4, '0')}.txt`), 'base\n')
    }
    writeFileSync(join(cwd, 'zz-filtered.bin'), 'base\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-qm', 'many paths')

    git(cwd, 'config', 'filter.late.clean', 'cat')
    git(cwd, 'config', 'filter.late.smudge', 'cat')
    git(cwd, 'config', 'filter.late.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), 'zz-filtered.bin filter=late\n')
    for (let index = 0; index < GIT_STATUS_ENTRY_LIMIT; index += 1) {
      writeFileSync(join(cwd, `bulk-${String(index).padStart(4, '0')}.txt`), 'changed\n')
    }
    writeFileSync(join(cwd, 'zz-filtered.bin'), 'changed\n')

    const rawStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { cwd, encoding: 'utf8' }).stdout
    const filteredIndex = rawStatus.split('\0').filter(Boolean).findIndex((record) => record.endsWith('zz-filtered.bin'))
    expect(filteredIndex).toBeGreaterThanOrEqual(GIT_STATUS_ENTRY_LIMIT)

    const service = new GitService(async () => cwd)
    const status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(status.error).toMatch(/clean\/smudge filters cannot run safely.*zz-filtered\.bin/i)
    await expect(service.diff(cwd, undefined, false)).rejects.toThrow(/clean\/smudge filters cannot run safely.*zz-filtered\.bin/i)
    await expect(service.stage(cwd, ['zz-filtered.bin'])).rejects.toThrow(/clean\/smudge filters cannot run safely.*zz-filtered\.bin/i)
    await expect(service.restore(cwd, ['zz-filtered.bin'])).rejects.toThrow(/clean\/smudge filters cannot run safely.*zz-filtered\.bin/i)
  }, 30_000)

  it('fails closed for LFS-style filtered content without changing the index or worktree', async () => {
    const cwd = repository('prime-work-git-lfs-')
    const marker = join(cwd, 'lfs-filter-ran')
    const filter = join(cwd, 'lfs-filter.sh')
    writeFileSync(filter, `#!/bin/sh
printf 'ran\n' >> ${JSON.stringify(marker)}
printf 'mutated by filter\n'
`)
    chmodSync(filter, 0o755)
    git(cwd, 'config', 'filter.lfs.clean', filter)
    git(cwd, 'config', 'filter.lfs.smudge', filter)
    git(cwd, 'config', 'filter.lfs.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    writeFileSync(join(cwd, 'asset.bin'), 'original bytes\n')
    const beforeIndex = spawnSync('git', ['ls-files', '--stage', '--', 'asset.bin'], { cwd, encoding: 'utf8' }).stdout
    const service = new GitService(async () => cwd)

    await expect(service.stage(cwd, ['asset.bin'])).rejects.toThrow(/required filter.*Git LFS/i)
    await expect(service.restore(cwd, ['asset.bin'])).rejects.toThrow(/required filter.*Git LFS/i)
    const afterIndex = spawnSync('git', ['ls-files', '--stage', '--', 'asset.bin'], { cwd, encoding: 'utf8' }).stdout
    expect(afterIndex).toBe(beforeIndex)
    expect(readFileSync(join(cwd, 'asset.bin'), 'utf8')).toBe('original bytes\n')
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects a repository root outside the authorized project folder', async () => {
    const outer = repository('prime-work-git-outer-')
    const inner = join(outer, 'authorized-folder')
    mkdirSync(inner)
    writeFileSync(join(inner, 'nested.txt'), 'nested change\n')
    const service = new GitService(async (candidate) => {
      if (candidate !== inner) throw new TypeError('repository root is outside the authorized folder')
      return candidate
    })

    const status = await service.status(inner)
    expect(status.isRepo).toBe(true)
    expect(status.error).toMatch(/repository root is outside the authorized folder/i)
    await expect(service.diff(inner, 'nested.txt', false)).rejects.toThrow(/repository root is outside the authorized folder/i)
    await expect(service.stage(inner, ['nested.txt'])).rejects.toThrow(/repository root is outside the authorized folder/i)
    expect(spawnSync('git', ['ls-files', '--', 'authorized-folder/nested.txt'], { cwd: outer, encoding: 'utf8' }).stdout).toBe('')
  })

  it('surfaces mutation and commit failures instead of returning apparent success', async () => {
    const cwd = repository('prime-work-git-failure-')
    const service = new GitService(async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'changed\n')
    writeFileSync(join(cwd, '.git', 'index.lock'), 'locked')
    await expect(service.stage(cwd, ['file.txt'])).rejects.toThrow(/Git add failed.*index\.lock/i)
    rmSync(join(cwd, '.git', 'index.lock'))
    git(cwd, 'restore', '--', 'file.txt')

    const commit = await service.commit(cwd, 'nothing to commit')
    expect(commit.ok).toBe(false)
    expect(commit.reason).toBe('exit')
    expect(commit.output).toMatch(/nothing to commit|no changes added/i)
  })

  it('caps status entries and diff lines with explicit truncation', async () => {
    const cwd = repository('prime-work-git-caps-')
    const service = new GitService(async () => cwd)
    for (let index = 0; index < GIT_STATUS_ENTRY_LIMIT + 5; index += 1) writeFileSync(join(cwd, `untracked-${String(index).padStart(4, '0')}`), 'x')
    const status = await service.status(cwd)
    expect(status.files).toHaveLength(GIT_STATUS_ENTRY_LIMIT)
    expect(status.truncated).toBe(true)

    const large = `${Array.from({ length: GIT_DIFF_LINE_LIMIT + 20 }, (_, index) => `line-${index}`).join('\n')}\n`
    writeFileSync(join(cwd, 'file.txt'), large)
    const diff = await service.diff(cwd, 'file.txt', false)
    expect(diff.truncated).toBe(true)
    expect(diff.error).toMatch(/lines.*truncated/i)
    expect(diff.text).toContain('[GooeyPi: diff truncated')
    const outputLines = diff.text.split('\n')
    expect(outputLines).toHaveLength(GIT_DIFF_LINE_LIMIT + 1)
    expect(outputLines[outputLines.length - 1]).toContain('[GooeyPi: diff truncated')
  }, 30_000)

  it('lists and creates linked worktrees with bounded porcelain parsing', async () => {
    const cwd = repository('prime-work-git-worktrees-')
    const target = `${cwd}-feature`; dirs.push(target)

    await createGitWorktree(cwd, target, 'feature/test')
    const worktrees = await listGitWorktrees(cwd)

    expect(worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: realpathSync(cwd), current: true, detached: false }),
      expect.objectContaining({ path: realpathSync(target), name: target.split('/').at(-1), branch: 'feature/test', current: false, detached: false }),
    ]))
    await expect(createGitWorktree(cwd, `${cwd}-invalid`, '../unsafe')).rejects.toThrow(/branch validation/i)
  })

  it('reports isRepo false only for a genuine not-a-repository failure', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-git-norepo-')); dirs.push(cwd)
    const service = new GitService(async () => cwd)
    const status = await service.status(cwd)
    expect(status.isRepo).toBe(false)
    expect(status.error).toMatch(/not a git repository/i)
  })

  it('keeps isRepo true when status fails for a reason other than a missing repository', async () => {
    const cwd = repository('prime-work-git-authz-')
    const service = new GitService(async () => { throw new TypeError('path is not inside an added Prime Work project') })
    const status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    expect(status.files).toEqual([])
    expect(status.error).toContain('not inside an added Prime Work project')
  })
})
