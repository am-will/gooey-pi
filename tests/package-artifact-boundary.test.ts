import { createPackage, listPackage } from '@electron/asar'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertAsarLayout } from '../scripts/release/package-layout.mjs'

const fixtures: string[] = []
const runtimeFiles = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'node_modules/node-pty/lib/index.js',
  'node_modules/zeromq/lib/index.js',
  'node_modules/zeromq/build/manifest.json',
]

async function archiveEntries(extraFiles: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'gooeypi-asar-boundary-'))
  fixtures.push(directory)
  const source = join(directory, 'app')
  for (const file of [...runtimeFiles, ...extraFiles]) {
    const path = join(source, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file === 'package.json' ? '{"name":"fixture","version":"1.0.0"}' : 'fixture')
  }
  const archive = join(directory, 'app.asar')
  await createPackage(source, archive)
  return { entries: listPackage(archive), bytes: (await stat(archive)).size }
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('packaged ASAR runtime boundary', () => {
  test('accepts actual runtime archives and dependency assets with either path separator', async () => {
    const { entries } = await archiveEntries(['out/renderer/assets/page.js', 'node_modules/provider-sdk/data/models.json'])
    expect(() => assertAsarLayout(entries)).not.toThrow()
    expect(() => assertAsarLayout(entries.map((entry) => entry.replaceAll('/', '\\')))).not.toThrow()
  })

  test.each([
    '.audit/proofs/private.txt',
    '.agents/skills/example/SKILL.md',
    '.cursor/environment.json',
    '.git/config',
    'src/App.tsx',
    'electron/main/index.ts',
    'tests/fixture.txt',
    'coverage/index.html',
    'vendor/bootstrap.tgz',
    'assets/pets/spritesheet.webp',
    'docs/internal.md',
    'scripts/release/package.mjs',
    'README.md',
    'unexpected/data.txt',
    'package.json.backup',
  ])('rejects checkout or unknown content %s even below the size budget', async (file) => {
    const { entries, bytes } = await archiveEntries([file])
    expect(bytes).toBeLessThan(125 * 1024 * 1024)
    expect(() => assertAsarLayout(entries)).toThrow(/Unexpected top-level ASAR path/)
    expect(() => assertAsarLayout(entries.map((entry) => entry.replaceAll('/', '\\')))).toThrow(/Unexpected top-level ASAR path/)
  })
})
