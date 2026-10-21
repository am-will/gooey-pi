import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../../electron/main/process-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/process-utils')>()
  return { ...actual, runProcess: vi.fn(actual.runProcess) }
})

const { runProcess } = await import('../../electron/main/process-utils')
const { GitService } = await import('../../electron/main/git')

const spawnedGitArgs = (): string[][] => (runProcess as unknown as Mock).mock.calls
  .filter(([file]) => file === 'git')
  .map(([, args]) => (args as string[]).filter((arg, index, all) => arg !== '-c' && all[index - 1] !== '-c' && arg !== '--no-pager'))

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { (runProcess as unknown as Mock).mockClear() })

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}
const repository = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'prime-work-git-guards-'))
  dirs.push(cwd)
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.name', 'Prime Work Test')
  git(cwd, 'config', 'user.email', 'test@example.com')
  writeFileSync(join(cwd, 'file.txt'), 'base\n')
  git(cwd, 'add', 'file.txt')
  git(cwd, 'commit', '-qm', 'base')
  return cwd
}

describe('withRepositoryGuards spawn dedupe', () => {
  it('supplies protected safe.directory on the first repository probe and every following Git operation', async () => {
    const cwd = repository()
    const home = mkdtempSync(join(tmpdir(), 'gooeypi-git-safe-home-')); dirs.push(home)
    writeFileSync(join(home, '.gitconfig'), `[safe]\n directory = ${cwd}\n`)
    const previous = process.env.HOME
    process.env.HOME = home
    try {
      expect((await new GitService(async () => cwd).status(cwd)).error).toBeUndefined()
      const operations = (runProcess as unknown as Mock).mock.calls.filter(([, args]) => !(args as string[]).includes('--get-regexp'))
      expect(operations.length).toBeGreaterThan(1)
      for (const [, args] of operations) expect(args).toContain(`safe.directory=${cwd}`)
      expect(operations[0][1]).toContain('--show-toplevel')
    } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous }
  })

  it('resolves the toplevel and configuration exactly once per status call graph', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'base\nchanged\n')

    const status = await service.status(cwd)
    expect(status.isRepo).toBe(true)
    const calls = spawnedGitArgs()
    expect(calls.filter((args) => args[0] === 'rev-parse' && args.includes('--show-toplevel'))).toHaveLength(1)
    expect(calls.filter((args) => args[0] === 'config' && args.includes('--list'))).toHaveLength(1)
    // The repository config is read once via --list; a cold global-excludes
    // cache may add one bounded `config --global --get core.excludesFile`.
    const globalExcludesReads = calls.filter((args) => args[0] === 'config' && !args.includes('--list'))
    for (const call of globalExcludesReads) {
      expect(call).toEqual(expect.arrayContaining(['--show-scope', '--null', '--no-includes', '--get-regexp']))
    }
    expect(globalExcludesReads.length).toBeLessThanOrEqual(1)
  })

  it('derives commit identity from the single config fetch instead of extra spawns', async () => {
    const cwd = repository()
    const service = new GitService(async () => cwd)
    writeFileSync(join(cwd, 'file.txt'), 'base\ncommitted\n')
    await service.stage(cwd, ['file.txt'])
    ;(runProcess as unknown as Mock).mockClear()

    const committed = await service.commit(cwd, 'deduped identity')
    expect(committed.ok).toBe(true)
    // rev-parse --show-toplevel, config --list, commit — and nothing else.
    // (A cold global-excludes cache may interleave one `config --global --get
    // core.excludesFile`; it is unrelated to identity, so it is filtered out.)
    const calls = spawnedGitArgs().filter((args) => !(args[0] === 'config' && args.includes('--get-regexp')))
    expect(calls.map((args) => args[0])).toEqual(['rev-parse', 'config', 'commit'])
    expect(calls.some((args) => args.includes('--global') || args.includes('--get'))).toBe(false)

    const author = spawnSync('git', ['show', '-s', '--format=%an <%ae>', 'HEAD'], { cwd, encoding: 'utf8' })
    expect(author.stdout.trim()).toBe('Prime Work Test <test@example.com>')
  })

  it('falls back to the global scope only for identity values missing locally', async () => {
    const cwd = repository()
    const home = mkdtempSync(join(tmpdir(), 'prime-work-git-guards-home-'))
    dirs.push(home)
    git(cwd, 'config', '--unset', 'user.email')
    writeFileSync(join(home, '.gitconfig'), '[user]\n  email = global@example.com\n')
    writeFileSync(join(cwd, 'file.txt'), 'base\nglobal-email\n')
    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const service = new GitService(async () => cwd)
      await service.stage(cwd, ['file.txt'])
      ;(runProcess as unknown as Mock).mockClear()

      const committed = await service.commit(cwd, 'partial identity')
      expect(committed.ok).toBe(true)
      const globalReads = spawnedGitArgs().filter((args) => args[0] === 'config' && args.includes('--global') && !args.includes('--get-regexp'))
      expect(globalReads).toHaveLength(1)
      expect(globalReads[0]).toContain('user.email')

      const author = spawnSync('git', ['show', '-s', '--format=%an <%ae>', 'HEAD'], { cwd, encoding: 'utf8' })
      expect(author.stdout.trim()).toBe('Prime Work Test <global@example.com>')
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
    }
  })

  it('still fails closed for filtered paths through the shared guard', async () => {
    const cwd = repository()
    git(cwd, 'config', 'filter.lfs.clean', 'cat')
    git(cwd, 'config', 'filter.lfs.required', 'true')
    writeFileSync(join(cwd, '.gitattributes'), '*.bin filter=lfs\n')
    writeFileSync(join(cwd, 'asset.bin'), 'bytes\n')
    const service = new GitService(async () => cwd)

    await expect(service.stage(cwd, ['asset.bin'])).rejects.toThrow(/clean\/smudge filters cannot run safely/i)
  })
})
