#!/usr/bin/env node
import { copyFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { assertSupportedToolchain, packagingPlan, runCommand, validateReleaseCredentials, validateWindowsReleaseCredentials, withoutReleaseCredentials } from './lib.mjs'

// Strict parsing rejects typos such as --dryrun, which would otherwise start a
// real build that first deletes the previous release output.
function parseOptions() {
  try {
    return parseArgs({
      strict: true,
      allowPositionals: false,
      options: {
        public: { type: 'boolean' },
        qa: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'skip-verify': { type: 'boolean' },
        platform: { type: 'string' },
        arch: { type: 'string' },
      },
    }).values
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}
const values = parseOptions()
const isPublic = values.public === true
const isQa = values.qa === true
const dryRun = values['dry-run'] === true
// CI release jobs pass --skip-verify because the CI workflow has already run
// the identical typecheck/lint/test suite on the same commit; the release job
// then only builds the bundle, packages, and runs post-package verification.
const skipVerify = values['skip-verify'] === true
const platform = values.platform
const platformHosts = { mac: 'darwin', linux: 'linux', win: 'win32' }
const nativeArchitectures = { arm64: 'arm64', x64: 'x64' }
if (isPublic === isQa) {
  console.error('Choose exactly one release mode: --public or --qa')
  process.exit(2)
}
if (!platform || !(platform in platformHosts)) {
  console.error('Choose a supported platform: --platform mac, linux, or win')
  process.exit(2)
}
// An explicit --arch is authoritative; only its absence falls back to the
// build machine's architecture, so a malformed flag fails instead of silently
// packaging the host arch.
const defaultArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const arch = values.arch ?? defaultArch
if (!arch || !(arch in nativeArchitectures)) {
  console.error('Choose a supported architecture: --arch arm64 or x64')
  process.exit(2)
}

function run(command, commandArgs, env = process.env) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  if (dryRun) return
  runCommand(command, commandArgs, { env })
}

try {
  assertSupportedToolchain()
  if (process.platform !== platformHosts[platform]) throw new Error(`${platform} packaging must run natively on ${platformHosts[platform]}`)
  if (isPublic && platform === 'mac') validateReleaseCredentials(process.env)
  if (isPublic && platform === 'win') validateWindowsReleaseCredentials(process.env)
  const outputDirectory = resolve('release', platform, arch)
  const plan = packagingPlan({ mode: isPublic ? 'public' : 'qa', platform, arch, skipVerify, outputDirectory })
  run(plan.preVerify.command, plan.preVerify.args, withoutReleaseCredentials(process.env))
  if (!dryRun) rmSync(outputDirectory, { recursive: true, force: true })
  run(plan.builder.command, plan.builder.args, { ...process.env, ...plan.builder.env })
  if (isPublic && platform === 'win' && !dryRun) {
    const appx = readdirSync(outputDirectory).find((name) => name.endsWith('.appx'))
    if (!appx) throw new Error('Windows AppX/MSIX package was not produced')
    copyFileSync(resolve(outputDirectory, appx), resolve(outputDirectory, appx.replace(/\.appx$/, '.msix')))
  }
  run(plan.verify.command, plan.verify.args, withoutReleaseCredentials(process.env, plan.verify.keepCredentials))
  if (dryRun) console.log('\nDRY RUN — nothing executed.')
  else console.log(`\n${isPublic ? 'Distribution' : 'Local QA'} ${platform}/${arch} package pipeline passed.`)
} catch (error) {
  console.error(`\nPackaging failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
