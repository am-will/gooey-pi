#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '../..')
const VENDOR = join(ROOT, 'vendor')
const PACKAGES = [
  {
    base: 'prime-agent-0.7.0.tgz',
    output: 'prime-agent-0.7.0-gooeypi.1.tgz',
    patch: 'patches/prime-agent-0.7.0-gooeypi.1.patch',
    baseSha256: '88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b',
  },
  {
    base: 'prime-agent-ai-0.7.0.tgz',
    output: 'prime-agent-ai-0.7.0-gooeypi.1.tgz',
    patch: 'patches/prime-agent-ai-0.7.0-gooeypi.1.patch',
    baseSha256: '7cdbb3e835f48dd103325f7a351ce540b27af4d161aeb9c7b9bdcc12fe7909af',
  },
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  return result.stdout.trim()
}

function treeFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
}

function assertTreeMatches(actualRoot, expectedRoot) {
  const actual = treeFiles(actualRoot)
  const expected = treeFiles(expectedRoot)
  const actualNames = actual.map((path) => relative(actualRoot, path))
  const expectedNames = expected.map((path) => relative(expectedRoot, path))
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error('Patched package file inventory differs from the reviewed archive')
  for (let index = 0; index < actual.length; index += 1) {
    if (!readFileSync(actual[index]).equals(readFileSync(expected[index]))) {
      throw new Error(`Patched package differs from the reviewed archive: ${actualNames[index]}`)
    }
  }
}

for (const spec of PACKAGES) {
  const basePath = join(VENDOR, spec.base)
  const outputPath = join(VENDOR, spec.output)
  const patchPath = join(VENDOR, spec.patch)
  if (sha256(basePath) !== spec.baseSha256) throw new Error(`Base archive checksum mismatch: ${spec.base}`)

  const work = mkdtempSync(join(tmpdir(), 'gooeypi-vendor-patch-'))
  try {
    const rebuilt = join(work, 'rebuilt')
    const reviewed = join(work, 'reviewed')
    mkdirSync(rebuilt)
    mkdirSync(reviewed)
    run('tar', ['-xzf', basePath, '-C', work], ROOT)
    run('git', ['apply', patchPath], work)
    run('tar', ['-xzf', outputPath, '-C', reviewed], ROOT)
    assertTreeMatches(join(work, 'package'), join(reviewed, 'package'))

    run('npm', ['pack', join(work, 'package'), '--pack-destination', rebuilt, '--ignore-scripts'], ROOT)
    const generated = join(rebuilt, basename(outputPath))
    console.log(`${spec.output}: content verified; reproducible archive ${sha256(generated)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
