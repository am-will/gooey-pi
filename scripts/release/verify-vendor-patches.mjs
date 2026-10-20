#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveCommandInvocation } from './lib.mjs'

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
  const invocation = resolveCommandInvocation(command, args)
  const result = spawnSync(invocation.file, invocation.args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: invocation.shell })
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
  // Checkouts made before .gitattributes marked the patches -text can still hold CRLF copies.
  if (readFileSync(patchPath).includes(0x0d)) {
    throw new Error(`Vendor patch has CRLF line endings from a converted checkout: vendor/${spec.patch}. Delete vendor/patches/*.patch and run git checkout -- vendor/patches`)
  }

  const work = mkdtempSync(join(tmpdir(), 'gooeypi-vendor-patch-'))
  try {
    const rebuilt = join(work, 'rebuilt')
    const reviewed = join(work, 'reviewed')
    mkdirSync(rebuilt)
    mkdirSync(reviewed)
    run('tar', ['-xzf', basePath, '-C', work], ROOT)
    // A user or system core.autocrlf would otherwise rewrite the patched files' line endings.
    run('git', ['-c', 'core.autocrlf=false', 'apply', patchPath], work)
    run('tar', ['-xzf', outputPath, '-C', reviewed], ROOT)
    assertTreeMatches(join(work, 'package'), join(reviewed, 'package'))

    run('npm', ['pack', join(work, 'package'), '--pack-destination', rebuilt, '--ignore-scripts'], ROOT)
    const generated = join(rebuilt, basename(outputPath))
    console.log(`${spec.output}: content verified; reproducible archive ${sha256(generated)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
