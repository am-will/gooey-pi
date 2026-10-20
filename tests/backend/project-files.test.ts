import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  })
})
