#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveCommandInvocation } from './lib.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const VENDOR = join(ROOT, 'vendor')
const EMPTY_CONFIG_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null'
export const PACKAGES = [
  {
    base: 'prime-agent-0.7.0.tgz',
    output: 'prime-agent-0.7.0-gooeypi.1.tgz',
    patch: 'patches/prime-agent-0.7.0-gooeypi.1.patch',
  },
  {
    base: 'prime-agent-ai-0.7.0.tgz',
    output: 'prime-agent-ai-0.7.0-gooeypi.1.tgz',
    patch: 'patches/prime-agent-ai-0.7.0-gooeypi.1.patch',
  },
]
// Base archive digests live only in the dependency pin store, so an upgrade updates one place.
const REFERENCE = JSON.parse(readFileSync(join(ROOT, 'scripts/release/dependency-pins.json'), 'utf8'))['reference-artifacts'] ?? {}

function sha512Sri(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

export function basePinIntegrity(base, reference = REFERENCE) {
  const pin = Object.values(reference).find((entry) => entry.path === `vendor/${base}`)
  if (!pin || typeof pin.integrity !== 'string' || !pin.integrity.startsWith('sha512-')) {
    throw new Error(`Base archive is not pinned in dependency-pins.json reference-artifacts: ${base}`)
  }
  return pin.integrity
}

/** Commands go through the shared resolver so Windows .cmd shims such as npm spawn without a shell. */
export function run(command, args, cwd, { platform = process.platform, env = process.env, spawn = spawnSync } = {}) {
  const invocation = resolveCommandInvocation(command, args, platform, env)
  const result = spawn(invocation.file, invocation.args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: invocation.shell })
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

function verifyVendorPatches() {
  for (const spec of PACKAGES) {
    const basePath = join(VENDOR, spec.base)
    const outputPath = join(VENDOR, spec.output)
    const patchPath = join(VENDOR, spec.patch)
    if (sha512Sri(basePath) !== basePinIntegrity(spec.base)) throw new Error(`Base archive checksum mismatch: ${spec.base}`)

    // Older checkouts may retain converted patches despite the current -text attributes.
    if (readFileSync(patchPath).includes(0x0d)) {
      throw new Error(`Vendor patch has CRLF line endings from a converted checkout: vendor/${spec.patch}. Delete vendor/patches/*.patch and run git checkout -- vendor/patches`)
    }
    const work = mkdtempSync(join(tmpdir(), 'gooeypi-vendor-patch-'))
    try {
      const reviewed = join(work, 'reviewed')
      mkdirSync(reviewed)
      run('tar', ['-xzf', basePath, '-C', work], ROOT)
      run('git', ['-c', 'core.autocrlf=false', '-c', `core.attributesFile=${EMPTY_CONFIG_PATH}`, 'apply', patchPath], work)
      run('tar', ['-xzf', outputPath, '-C', reviewed], ROOT)
      assertTreeMatches(join(work, 'package'), join(reviewed, 'package'))
      console.log(`${spec.output}: content verified against ${spec.patch}`)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

if (import.meta.main) verifyVendorPatches()
