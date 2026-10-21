import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listProjectFiles } from '../../electron/main/project-files'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const projectRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'prime-work-project-files-')); dirs.push(root)
  return root
}
const paths = (listing: { entries: Array<{ path: string }> }) => listing.entries.map((entry) => entry.path)

describe('listProjectFiles', () => {
  it('keeps root files and later sibling folders when an early folder exceeds the budget', async () => {
    const root = projectRoot()
    mkdirSync(join(root, 'aaa-big'))
    for (let index = 0; index < 10; index += 1) writeFileSync(join(root, 'aaa-big', `file-${index}.txt`), 'x')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'README.md'), 'read me')

    const listing = await listProjectFiles(root, 6)
    expect(paths(listing)).toEqual(['aaa-big', 'src', 'package.json', 'README.md', 'aaa-big/file-0.txt', 'aaa-big/file-1.txt'])
    expect(listing.truncated).toBe(true)
  })

  it('flags truncation once the entry budget is spent instead of silently dropping the tail', async () => {
    const root = projectRoot()
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) writeFileSync(join(root, name), 'x')

    const capped = await listProjectFiles(root, 3)
    expect(paths(capped)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(capped.truncated).toBe(true)
    expect((await listProjectFiles(root, 5)).truncated).toBe(false)
    expect((await listProjectFiles(root, 100)).truncated).toBe(false)
  })

  it('flags truncation when the budget fills before a non-empty folder is read', async () => {
    const root = projectRoot()
    mkdirSync(join(root, 'only'))
    writeFileSync(join(root, 'only', 'hidden.txt'), 'x')

    expect(await listProjectFiles(root, 1)).toEqual({ entries: [{ path: 'only', type: 'directory' }], skipped: 0, truncated: true })
  })

  it('does not flag truncation when only skipped symlinks and ignored folders remain', async () => {
    const root = projectRoot()
    writeFileSync(join(root, 'a.txt'), 'x')
    writeFileSync(join(root, 'b.txt'), 'x')
    symlinkSync('a.txt', join(root, 'z-link'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'generated')
    mkdirSync(join(root, 'empty'))

    expect(await listProjectFiles(root, 3)).toEqual({
      entries: [{ path: 'empty', type: 'directory' }, { path: 'a.txt', type: 'file' }, { path: 'b.txt', type: 'file' }],
      skipped: 0,
      truncated: false,
    })
  })

  it('does not flag truncation when an ignored folder is reached after the budget is spent', async () => {
    const root = projectRoot()
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'generated')

    expect(await listProjectFiles(root, 1)).toEqual({ entries: [{ path: 'a', type: 'directory' }], skipped: 0, truncated: false })
  })
})
