import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mirrorBundledSkill } from '../../electron/main/lib/bundled-skill-mirror'

const cpOverride = vi.hoisted(() => ({ current: null as null | ((copy: () => Promise<void>) => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: (...args: Parameters<typeof actual.cp>) => {
      const copy = () => actual.cp(...args)
      return cpOverride.current ? cpOverride.current(copy) : copy()
    },
  }
})

const dirs: string[] = []
afterEach(() => {
  cpOverride.current = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'gooeypi-skill-mirror-')); dirs.push(dir); return dir }
const write = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content) }

function bundledSkill(): string {
  const source = join(temp(), 'Resources', 'skills', 'prime-work-schedules')
  write(join(source, 'SKILL.md'), '# Scheduled tasks\n')
  write(join(source, 'pyproject.toml'), '[project]\nname = "prime-work-schedules"\n')
  write(join(source, 'src', 'prime_work_schedules', '__init__.py'), 'def create():\n    pass\n')
  return source
}

const mirrorRoot = () => join(temp(), 'userData', 'bundled-skills')
const pycache = (skill: string) => join(skill, 'src', 'prime_work_schedules', '__pycache__', '__init__.cpython-311.pyc')

describe('mirrorBundledSkill', () => {
  it('copies the bundled skill into the writable mirror root on first run', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()

    const mirrored = await mirrorBundledSkill(source, root)

    expect(mirrored).toBe(join(root, 'prime-work-schedules'))
    expect(readFileSync(join(mirrored, 'SKILL.md'), 'utf8')).toBe('# Scheduled tasks\n')
    expect(readFileSync(join(mirrored, 'pyproject.toml'), 'utf8')).toContain('prime-work-schedules')
    expect(readFileSync(join(mirrored, 'src', 'prime_work_schedules', '__init__.py'), 'utf8')).toContain('def create')
    // Only the finished mirror remains: no staging directory is left beside it.
    expect(readdirSync(root)).toEqual(['prime-work-schedules'])
  })

  it('never copies bytecode caches out of the bundled skill', async () => {
    const source = bundledSkill()
    write(pycache(source), 'stale bytecode')
    write(join(source, '__pycache__', 'top.pyc'), 'stale bytecode')

    const mirrored = await mirrorBundledSkill(source, mirrorRoot())

    expect(existsSync(pycache(mirrored))).toBe(false)
    expect(existsSync(join(mirrored, '__pycache__'))).toBe(false)
    expect(existsSync(join(mirrored, 'src', 'prime_work_schedules', '__init__.py'))).toBe(true)
  })

  it('leaves an up-to-date mirror and its bytecode caches untouched', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()
    const mirrored = await mirrorBundledSkill(source, root)
    const before = statSync(join(mirrored, 'SKILL.md')).ino
    // Python writes bytecode into the mirror once Prime imports it, and the bundle may carry
    // bytecode from an older release; neither counts as a content change.
    write(pycache(mirrored), 'kernel bytecode')
    write(pycache(source), 'stale bytecode')

    expect(await mirrorBundledSkill(source, root)).toBe(mirrored)
    expect(statSync(join(mirrored, 'SKILL.md')).ino).toBe(before)
    expect(readFileSync(pycache(mirrored), 'utf8')).toBe('kernel bytecode')
  })

  it('refreshes the mirror when the bundled skill changes', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()
    const mirrored = await mirrorBundledSkill(source, root)
    write(pycache(mirrored), 'kernel bytecode')
    write(join(source, 'src', 'prime_work_schedules', '__init__.py'), 'def create():\n    return 2\n')
    write(join(source, 'src', 'prime_work_schedules', 'client.py'), 'URL = None\n')

    expect(await mirrorBundledSkill(source, root)).toBe(mirrored)
    expect(readFileSync(join(mirrored, 'src', 'prime_work_schedules', '__init__.py'), 'utf8')).toContain('return 2')
    expect(readFileSync(join(mirrored, 'src', 'prime_work_schedules', 'client.py'), 'utf8')).toBe('URL = None\n')
    expect(existsSync(pycache(mirrored))).toBe(false)
    expect(readdirSync(root)).toEqual(['prime-work-schedules'])
  })

  it('repairs a mirror whose files were edited, removed, or added outside GooeyPi', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()
    const mirrored = await mirrorBundledSkill(source, root)
    rmSync(join(mirrored, 'SKILL.md'))
    write(join(mirrored, 'pyproject.toml'), 'edited')
    write(join(mirrored, 'extra.txt'), 'extra')

    await mirrorBundledSkill(source, root)

    expect(readFileSync(join(mirrored, 'SKILL.md'), 'utf8')).toBe('# Scheduled tasks\n')
    expect(readFileSync(join(mirrored, 'pyproject.toml'), 'utf8')).toContain('prime-work-schedules')
    expect(existsSync(join(mirrored, 'extra.txt'))).toBe(false)
  })

  it('keeps the previous mirror and falls back to the bundled skill when a refresh fails', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()
    const mirrored = await mirrorBundledSkill(source, root)
    write(join(source, 'SKILL.md'), '# Scheduled tasks v2\n')
    cpOverride.current = async (copy) => {
      await copy()
      throw new Error('disk full')
    }
    const log = vi.fn()

    expect(await mirrorBundledSkill(source, root, log)).toBe(source)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'))
    expect(readFileSync(join(mirrored, 'SKILL.md'), 'utf8')).toBe('# Scheduled tasks\n')
    expect(readdirSync(root)).toEqual(['prime-work-schedules'])
  })

  it('removes staging copies a launch killed mid-copy left behind, and only its own', async () => {
    const source = bundledSkill()
    const root = mirrorRoot()
    write(join(root, 'prime-work-schedules.4242.interrupted.tmp', 'SKILL.md'), 'partial copy')
    write(join(root, 'other-skill.4242.interrupted.tmp', 'SKILL.md'), 'partial copy')

    const mirrored = await mirrorBundledSkill(source, root)

    expect(readFileSync(join(mirrored, 'SKILL.md'), 'utf8')).toBe('# Scheduled tasks\n')
    expect(readdirSync(root).sort()).toEqual(['other-skill.4242.interrupted.tmp', 'prime-work-schedules'])
  })

  it('falls back to the bundled skill when the mirror root cannot be created', async () => {
    const source = bundledSkill()
    const blocked = join(temp(), 'userData')
    writeFileSync(blocked, 'not a directory')
    const log = vi.fn()

    expect(await mirrorBundledSkill(source, join(blocked, 'bundled-skills'), log)).toBe(source)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('prime-work-schedules'))
  })
})
