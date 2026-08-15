#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listPackage } from '@electron/asar'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { assertPackagedExtensionSet } from './extension-inventory.mjs'
import { artifactArchitectures, assertAsarLayout, assertExactArchitectures, assertUnpackedNativeLayout, parseArchitectures, parseTeamIdentifier, requireReleaseArtifacts } from './lib.mjs'
import { assertPackageSizeBudgets, collectPackageSizeMetrics, describeSizeMetrics } from './size-budgets.mjs'

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} failed with exit code ${result.status}${details ? `: ${details}` : ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function findFiles(directory, predicate, found = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isDirectory()) {
      if (predicate(path, stat)) found.push(path)
      else findFiles(path, predicate, found)
    } else if (predicate(path, stat)) found.push(path)
  }
  return found
}

function findSingleApp(directory, label) {
  const apps = findFiles(directory, (path, stat) => stat.isDirectory() && path.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`Expected exactly one packaged .app in ${label}, found ${apps.length}`)
  return apps[0]
}

function assertFuses(wire) {
  const expected = new Map([
    [FuseV1Options.RunAsNode, FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot, FuseState.DISABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
    [FuseV1Options.WasmTrapHandlers, FuseState.ENABLE],
  ])
  for (const [name, state] of expected) {
    if (wire[name] !== state) throw new Error(`Electron fuse ${name} is ${wire[name]}, expected ${state}`)
  }
}

export function assertBooleanEntitlement(output, key, label) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const xml = new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<true\\s*/>`, 'i')
  const dictionary = new RegExp(`\\[Key\\]\\s*${escapedKey}\\s*\\[Value\\]\\s*\\[Bool\\]\\s*true`, 'i')
  if (!xml.test(output) && !dictionary.test(output)) {
    throw new Error(`${label} is missing required true entitlement ${key}`)
  }
}

function assertPackagedMicrophoneEntitlements(app, productName) {
  const frameworks = join(app, 'Contents', 'Frameworks')
  const helpers = findFiles(frameworks, (path, stat) => stat.isDirectory() && basename(path).startsWith(`${productName} Helper`) && path.endsWith('.app'))
  if (!helpers.length) throw new Error(`${productName} package contains no Electron helper applications`)
  for (const target of [app, ...helpers]) {
    const label = target === app ? `${productName} app` : basename(target)
    assertBooleanEntitlement(run('codesign', ['-d', '--entitlements', '-', target]), 'com.apple.security.device.audio-input', label)
  }
}

async function verifyApp({ app, artifact, mode, expectedTeam }) {
  const productName = basename(app, '.app')
  const resources = join(app, 'Contents', 'Resources')
  const executable = join(app, 'Contents', 'MacOS', productName)
  const asar = join(resources, 'app.asar')
  const looseApp = join(resources, 'app')
  if (!existsSync(asar)) throw new Error(`${basename(artifact)} application must contain Resources/app.asar`)
  if (existsSync(looseApp)) throw new Error(`${basename(artifact)} contains forbidden loose Resources/app`)
  assertAsarLayout(listPackage(asar, { isPack: false }))
  assertPackagedExtensionSet(resources)

  const appArchitectures = parseArchitectures(run('lipo', ['-archs', executable]))
  assertExactArchitectures(appArchitectures, artifactArchitectures(artifact), basename(artifact))
  const unpacked = join(resources, 'app.asar.unpacked')
  if (!existsSync(unpacked)) throw new Error(`${basename(artifact)} application must contain Resources/app.asar.unpacked`)
  assertUnpackedNativeLayout(unpacked, appArchitectures, (path) => parseArchitectures(run('lipo', ['-archs', path])))
  assertFuses(await getCurrentFuseWire(executable))

  if (mode === 'public') {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', app])
    const signature = run('codesign', ['-dv', '--verbose=4', app])
    const actualTeam = parseTeamIdentifier(signature)
    if (actualTeam !== expectedTeam) throw new Error(`Signature Team ID ${actualTeam ?? '<missing>'} does not match ${expectedTeam}`)
    assertPackagedMicrophoneEntitlements(app, productName)
    run('xcrun', ['stapler', 'validate', app])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
  }

  return { app, asar }
}

function assertArtifactSizeBudgets(payload, artifacts) {
  const metrics = collectPackageSizeMetrics({ ...payload, ...artifacts })
  assertPackageSizeBudgets(metrics)
  return metrics
}

async function verifyZip(zip, options, artifacts) {
  run('unzip', ['-t', zip])
  const extractionDirectory = mkdtempSync(join(tmpdir(), 'prime-work-zip-'))
  try {
    run('ditto', ['-x', '-k', zip, extractionDirectory])
    const payload = await verifyApp({ ...options, app: findSingleApp(extractionDirectory, basename(zip)), artifact: zip })
    return assertArtifactSizeBudgets(payload, artifacts)
  } finally {
    rmSync(extractionDirectory, { recursive: true, force: true })
  }
}

async function verifyDmg(dmg, options, artifacts) {
  run('hdiutil', ['verify', dmg])
  const mountPoint = mkdtempSync(join(tmpdir(), 'prime-work-dmg-'))
  let mounted = false
  try {
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmg])
    mounted = true
    const payload = await verifyApp({ ...options, app: findSingleApp(mountPoint, basename(dmg)), artifact: dmg })
    return assertArtifactSizeBudgets(payload, artifacts)
  } finally {
    // A detach failure is logged rather than thrown so it can never mask the
    // original verification error, and the mount-point cleanup always runs.
    if (mounted) {
      try {
        run('hdiutil', ['detach', mountPoint])
      } catch (detachError) {
        console.error(`hdiutil detach failed for ${mountPoint}: ${detachError instanceof Error ? detachError.message : String(detachError)}`)
      }
    }
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

// Binds the packaging pipeline's requested target architecture to the
// artifacts that were actually produced. The per-artifact deep checks then
// verify the binaries against each artifact's declared name, so a requested
// arch that reaches this gate is enforced end-to-end. Universal is rejected by
// design: the release ships separate arm64 and x64 builds.
export function assertRequestedArchitecture(artifacts, arch) {
  if (arch === undefined) return
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Requested architecture must be arm64 or x64')
  for (const artifact of [artifacts.dmg, artifacts.zip]) {
    const declared = /-(arm64|x64|universal)\.(?:dmg|zip)$/.exec(artifact)?.[1]
    if (declared !== arch) {
      throw new Error(`${basename(artifact)} declares architecture ${declared ?? '<none>'}, but --arch ${arch} was requested`)
    }
  }
}

export async function verifyPackage({ mode, releaseDirectory = resolve('release'), env = process.env, arch = undefined }) {
  if (mode !== 'public' && mode !== 'qa') throw new Error('Verification mode must be public or qa')
  if (!existsSync(releaseDirectory)) throw new Error(`Release directory does not exist: ${releaseDirectory}`)
  const expectedTeam = env.RELEASE_SIGNING_TEAM_ID?.trim()
  if (mode === 'public' && !expectedTeam) throw new Error('RELEASE_SIGNING_TEAM_ID is required for public verification')

  const artifactFiles = findFiles(releaseDirectory, (path, stat) => stat.isFile() && (path.endsWith('.dmg') || path.endsWith('.zip')))
  const artifacts = requireReleaseArtifacts(artifactFiles)
  assertRequestedArchitecture(artifacts, arch)
  const dmgMetrics = await verifyDmg(artifacts.dmg, { mode, expectedTeam }, artifacts)
  const zipMetrics = await verifyZip(artifacts.zip, { mode, expectedTeam }, artifacts)

  const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  console.log(
    `Verified ${mode} DMG and ZIP for GooeyPi ${packageJson.version}: archive integrity, contained application, exact native unpack allowlist and architectures, Electron fuses, and package size budgets (DMG payload: ${describeSizeMetrics(dmgMetrics)}; ZIP payload: ${describeSizeMetrics(zipMetrics)})${mode === 'public' ? ', signatures, microphone entitlements, notarization staples, and Gatekeeper' : ''}.`,
  )
}

// Fail closed: run verification unless this module was provably imported by
// another entrypoint. A malformed or missing argv[1] must not skip the checks.
export function invokedAsScript() {
  if (!process.argv[1]) return true
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  } catch {
    return true
  }
}

if (invokedAsScript()) {
  const modeIndex = process.argv.indexOf('--mode')
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined
  const releaseDirectoryIndex = process.argv.indexOf('--release-directory')
  const releaseDirectory = releaseDirectoryIndex >= 0 ? process.argv[releaseDirectoryIndex + 1] : undefined
  const archIndex = process.argv.indexOf('--arch')
  // A --arch flag with a missing value must fail closed, not skip the check.
  const arch = archIndex >= 0 ? (process.argv[archIndex + 1] ?? '') : undefined
  verifyPackage({ mode, ...(releaseDirectory ? { releaseDirectory } : {}), ...(arch !== undefined ? { arch } : {}) }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
