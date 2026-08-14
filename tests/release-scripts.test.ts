import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  artifactArchitectures,
  assertArchitectureCoverage,
  assertAsarLayout,
  assertExactArchitectures,
  assertSupportedNode,
  assertUnpackedNativeLayout,
  expectedUnpackedNativeLayout,
  parseArchitectures,
  parseTeamIdentifier,
  requireReleaseArtifacts,
  resolveCommandInvocation,
  validateReleaseCredentials,
  validateWindowsReleaseCredentials,
  withoutReleaseCredentials,
} from '../scripts/release/lib.mjs'
import { producedReleaseArtifactNames, readElectronBuilderConfig, RELEASE_BUILD_MATRIX } from '../scripts/release/artifact-names.mjs'
import {
  expectedDownloadedReleaseAssets,
  expectedGitHubReleaseAssets,
  mergeUpdateMetadata,
  parseReleasePlatforms,
  prepareGitHubRelease,
  releaseAssetNames,
} from '../scripts/release/prepare-github-release.mjs'
import { parseDraftAssetNames, staleDraftReleaseAssets } from '../scripts/release/prune-draft-release-assets.mjs'
import { assertBundleSizeBudgets, assertPackageSizeBudgets, BUNDLE_SIZE_BUDGETS, collectBundleSizeMetrics, collectPackageSizeMetrics, PACKAGE_SIZE_BUDGETS } from '../scripts/release/size-budgets.mjs'
import { assertReleaseTag } from '../scripts/release/validate-release-tag.mjs'
// after-pack.cjs is CommonJS; the interop layer exposes module.exports properties as named exports.
import { executablePath } from '../scripts/release/after-pack.cjs'
import {
  assertValidAuthenticode,
  assertUnpackedNativeLayout as assertCrossPlatformUnpackedNativeLayout,
  expectedArtifactExtensions,
  expectedAuthenticodeSigner,
  expectedNativeFiles,
  nativeRuntimeDirectory,
  zeroMqAddonPattern,
} from '../scripts/release/verify-cross-platform-package.mjs'

// js-yaml ships no type declarations, so it is required rather than imported.
const load = createRequire(import.meta.url)('js-yaml').load as (source: string) => unknown

const baseEnvironment = {
  RELEASE_SIGNING_TEAM_ID: 'TEAM123',
  CSC_LINK: 'base64-certificate',
  CSC_KEY_PASSWORD: 'certificate-password',
  APPLE_ID: 'release@example.com',
  APPLE_APP_SPECIFIC_PASSWORD: 'app-password',
  APPLE_TEAM_ID: 'TEAM123',
}

const FIXTURE_ZEROMQ_DIRECTORIES = new Map([
  ['arm64', 'arm64'],
  ['x86_64', 'x64'],
])

function fixtureAddonPath(architecture: string, runtime = 'libc-115-Release') {
  return `node_modules/zeromq/build/darwin/${FIXTURE_ZEROMQ_DIRECTORIES.get(architecture)}/node/${runtime}/addon.node`
}

function createUnpackedFixture(architectures = new Set(['arm64'])) {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-unpacked-'))
  const relativePaths = [...expectedUnpackedNativeLayout(architectures).files, ...[...architectures].map((architecture) => fixtureAddonPath(architecture))]
  for (const relativePath of relativePaths) {
    const path = join(directory, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'fixture')
  }
  return directory
}

function writeSizedFile(path: string, bytes: number) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  truncateSync(path, bytes)
}

function writeUpdateManifest(directory: string, name: string, url: string, sha512: string, releaseDate: string) {
  const path = join(directory, name, 'latest-mac.yml')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `version: 0.2.0\nreleaseDate: '${releaseDate}'\nfiles:\n  - url: ${url}\n    sha512: ${sha512}\n    size: 42\npath: ${url}\nsha512: ${sha512}\n`)
  return path
}

/** A complete downloaded macOS release artifact tree, optionally missing one produced artifact. */
function writeMacReleaseFixture(directory: string, { omit }: { omit?: string } = {}) {
  const projectDirectory = join(directory, 'project')
  const inputDirectory = join(directory, 'downloaded')
  mkdirSync(projectDirectory, { recursive: true })
  mkdirSync(inputDirectory, { recursive: true })
  writeFileSync(join(projectDirectory, 'package.json'), JSON.stringify({ version: '0.2.0' }))
  writeFileSync(join(projectDirectory, 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }))
  for (const [index, name] of expectedDownloadedReleaseAssets('0.2.0', ['mac']).entries()) {
    if (name === omit) continue
    const artifactDirectory = join(inputDirectory, `artifact-${index}`)
    mkdirSync(artifactDirectory, { recursive: true })
    const content = name.endsWith('.yml')
      ? 'version: 0.2.0\nfiles:\n  - url: GooeyPi-0.2.0-x64.zip\n    sha512: x64-digest\n    size: 42\npath: GooeyPi-0.2.0-x64.zip\nsha512: x64-digest\n'
      : `asset ${index}`
    writeFileSync(join(artifactDirectory, name), content)
  }
  return { projectDirectory, inputDirectory }
}

function createBundleSizeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prime-work-bundle-size-'))
  writeSizedFile(join(directory, 'main/index.js'), 101)
  writeSizedFile(join(directory, 'preload/index.js'), 102)
  writeSizedFile(join(directory, 'renderer/assets/entry.js'), 103)
  writeSizedFile(join(directory, 'renderer/assets/vendor.js'), 104)
  writeSizedFile(join(directory, 'renderer/assets/lazy.js'), 105)
  writeSizedFile(join(directory, 'renderer/assets/app.css'), 106)
  writeFileSync(
    join(directory, 'renderer/index.html'),
    '<script type="module" src="./assets/entry.js"></script><link rel="modulepreload" href="./assets/vendor.js"><link rel="stylesheet" href="./assets/app.css">',
  )
  return directory
}

describe('release preflight', () => {
  test('package.mjs --dry-run says nothing executed instead of claiming success', () => {
    const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
    const result = spawnSync(process.execPath, ['scripts/release/package.mjs', '--qa', '--platform', platform, '--dry-run'], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('DRY RUN — nothing executed.')
    expect(result.stdout).not.toContain('pipeline passed')
  })

  test('verify-package runs when invoked as a script and fails closed on a missing entrypoint', async () => {
    const { invokedAsScript } = await import('../scripts/release/verify-package.mjs')
    const original = process.argv[1]
    try {
      process.argv[1] = fileURLToPath(new URL('../scripts/release/verify-package.mjs', import.meta.url))
      expect(invokedAsScript()).toBe(true)
      process.argv[1] = join(tmpdir(), 'another-entrypoint.mjs')
      expect(invokedAsScript()).toBe(false)
      process.argv[1] = undefined as unknown as string
      expect(invokedAsScript()).toBe(true)
    } finally {
      process.argv[1] = original
    }
  })

  test('binds the requested target architecture to the produced mac artifacts', async () => {
    const { assertBooleanEntitlement, assertRequestedArchitecture } = await import('../scripts/release/verify-package.mjs')
    const artifacts = { dmg: 'release/mac/arm64/Prime Work-1.0.0-arm64.dmg', zip: 'release/mac/arm64/Prime Work-1.0.0-arm64.zip' }
    expect(() => assertRequestedArchitecture(artifacts, 'arm64')).not.toThrow()
    expect(() => assertRequestedArchitecture(artifacts, undefined)).not.toThrow()
    expect(() => assertRequestedArchitecture(artifacts, 'x64')).toThrow(/declares architecture arm64, but --arch x64 was requested/)
    expect(() => assertRequestedArchitecture({ ...artifacts, zip: 'release/mac/x64/Prime Work-1.0.0-x64.zip' }, 'arm64')).toThrow(/declares architecture x64/)
    expect(() => assertRequestedArchitecture(artifacts, 'universal')).toThrow(/must be arm64 or x64/)
    expect(() => assertRequestedArchitecture(artifacts, '')).toThrow(/must be arm64 or x64/)
    // package.mjs forwards the authoritative arch into mac post-package verification.
    expect(readFileSync('scripts/release/package.mjs', 'utf8')).toContain("'--arch', arch, '--release-directory'")

    const entitlement = 'com.apple.security.device.audio-input'
    expect(() => assertBooleanEntitlement(`<key>${entitlement}</key><true/>`, entitlement, 'fixture')).not.toThrow()
    expect(() => assertBooleanEntitlement(`[Key] ${entitlement}\n[Value]\n[Bool] true`, entitlement, 'fixture')).not.toThrow()
    expect(() => assertBooleanEntitlement(`<key>${entitlement}</key><false/>`, entitlement, 'fixture')).toThrow(/missing required true entitlement/)
  })

  test('requires the Electron 43 Node.js baseline', () => {
    expect(() => assertSupportedNode('v22.11.0')).toThrow(/>=22\.12\.0/)
    expect(() => assertSupportedNode('v22.12.0')).not.toThrow()
    expect(() => assertSupportedNode('v24.0.0')).not.toThrow()
  })

  test('keeps contributor instructions aligned with the enforced engines', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.engines).toEqual({ node: '>=22.12.0', npm: '>=10.9.0' })
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22.12.0')
    expect(readFileSync('README.md', 'utf8')).toContain('Node.js 22.12.0 or newer and npm 10.9.0 or newer')
  })

  test('fails closed without Developer ID credentials', () => {
    expect(() => validateReleaseCredentials({}, { checkApiKeyFile: false })).toThrow(/RELEASE_SIGNING_TEAM_ID/)
    expect(() => validateReleaseCredentials({ ...baseEnvironment, CSC_LINK: '' }, { checkApiKeyFile: false })).toThrow(/CSC_LINK/)
  })

  test('accepts exactly one complete notarization credential set', () => {
    expect(() => validateReleaseCredentials(baseEnvironment, { checkApiKeyFile: false })).not.toThrow()
    const apiEnvironment = {
      RELEASE_SIGNING_TEAM_ID: 'TEAM123',
      CSC_LINK: 'certificate',
      CSC_KEY_PASSWORD: 'password',
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEY123',
      APPLE_API_ISSUER: 'issuer-id',
    }
    expect(() => validateReleaseCredentials(apiEnvironment, { checkApiKeyFile: false })).not.toThrow()
    expect(() => validateReleaseCredentials({ ...baseEnvironment, ...apiEnvironment }, { checkApiKeyFile: false })).toThrow(/exactly one/)
  })

  test('binds Apple ID notarization to the signing Team ID', () => {
    expect(() => validateReleaseCredentials({ ...baseEnvironment, APPLE_TEAM_ID: 'OTHER' }, { checkApiKeyFile: false })).toThrow(/must match/)
  })

  test('fails closed without Windows Authenticode credentials', () => {
    expect(() => validateWindowsReleaseCredentials({})).toThrow(/WIN_CSC_LINK, WIN_CSC_KEY_PASSWORD/)
    expect(() => validateWindowsReleaseCredentials({ WIN_CSC_LINK: 'certificate', WIN_CSC_KEY_PASSWORD: 'password' })).not.toThrow()
    const packaging = readFileSync('scripts/release/package.mjs', 'utf8')
    expect(packaging).toContain("builderArgs.push('--config.forceCodeSigning=true')")
    expect(packaging).toContain("'--mode', isPublic ? 'public' : 'qa'")
  })

  test('removes release credentials from untrusted verification commands', () => {
    const environment = { PATH: '/usr/bin', ...baseEnvironment, APPLE_API_KEY: '/tmp/private-key' }
    expect(withoutReleaseCredentials(environment)).toEqual({ PATH: '/usr/bin' })
    expect(withoutReleaseCredentials(environment, ['RELEASE_SIGNING_TEAM_ID'])).toEqual({
      PATH: '/usr/bin',
      RELEASE_SIGNING_TEAM_ID: 'TEAM123',
    })
    expect(withoutReleaseCredentials({ PATH: '/usr/bin', WIN_CSC_LINK: 'certificate', WIN_CSC_KEY_PASSWORD: 'password' })).toEqual({ PATH: '/usr/bin' })
  })

  interface WorkflowStep {
    job: string
    name: string | undefined
    uses: string | undefined
    secretLines: string[]
    lines: string[]
  }

  /** Minimal structural read of a GitHub workflow: jobs and their step blocks. */
  function parseWorkflowSteps(source: string): WorkflowStep[] {
    const steps: WorkflowStep[] = []
    let job = ''
    let inJobs = false
    let current: WorkflowStep | undefined
    for (const line of source.split('\n')) {
      if (/^jobs:\s*$/.test(line)) {
        inJobs = true
        continue
      }
      if (!inJobs) continue
      const jobMatch = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/)
      if (jobMatch) {
        job = jobMatch[1]
        current = undefined
        continue
      }
      if (/^ {6}- /.test(line)) {
        current = { job, name: undefined, uses: undefined, secretLines: [], lines: [] }
        steps.push(current)
      }
      if (!current) continue
      current.lines.push(line)
      const name = line.match(/^\s*(?:- )?name:\s*(.+?)\s*$/)
      if (name && current.name === undefined) current.name = name[1]
      const uses = line.match(/^\s*(?:- )?uses:\s*(\S+)/)
      if (uses && current.uses === undefined) current.uses = uses[1]
      if (line.includes('secrets.')) current.secretLines.push(line)
    }
    return steps
  }

  test('pins every workflow action, including third-party owners, to a full commit SHA', () => {
    for (const path of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const steps = parseWorkflowSteps(readFileSync(path, 'utf8'))
      expect(steps.length).toBeGreaterThan(0)
      for (const step of steps) {
        if (step.uses === undefined) continue
        // Every `uses:` reference must be `owner/repo[/path]@<40-hex sha>`,
        // regardless of owner - tags and branches are movable for actions/*
        // and third-party owners alike.
        expect(step.uses, `${path} ${step.job}: ${step.uses}`).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/)
      }
    }
  })

  test('confines workflow secrets to the signing and notarization release steps', () => {
    const releaseSteps = parseWorkflowSteps(readFileSync('.github/workflows/release.yml', 'utf8'))
    const secretSteps = releaseSteps.filter((step) => step.secretLines.length > 0)
    expect(secretSteps.map((step) => `${step.job}: ${step.name}`).sort()).toEqual([
      'package-windows: Build, Authenticode-sign, and verify Windows packages',
      'package: Build, sign, notarize, and verify release packages',
      'package: Fail closed unless every release credential is configured',
    ])
    for (const step of secretSteps) {
      // Secrets may only be consumed as env-var assignments inside the step's
      // env block - never interpolated into run commands or action inputs.
      expect(step.lines.some((line) => /^\s*env:\s*$/.test(line))).toBe(true)
      for (const line of step.secretLines) {
        expect(line).toMatch(/^\s+[A-Z][A-Z0-9_]*: \$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/)
      }
      expect(step.lines.join('\n')).not.toMatch(/run:.*secrets\./)
    }

    const ciSteps = parseWorkflowSteps(readFileSync('.github/workflows/ci.yml', 'utf8'))
    expect(ciSteps.filter((step) => step.secretLines.length > 0)).toEqual([])
  })

  test('gates packaging regressions on every pull request', () => {
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    expect(ciWorkflow).toMatch(/on:\n {2}push:\n {4}branches:\n {6}- main/)
    expect(ciWorkflow).toContain('cancel-in-progress: true')
    expect(ciWorkflow).toMatch(/packaging-smoke:\n {4}if: github\.event_name == 'pull_request'/)
    for (const runner of ['macos-14', 'ubuntu-22.04', 'windows-2022']) expect(ciWorkflow).toContain(`runner: ${runner}`)
    expect(ciWorkflow).toContain('node node_modules/electron-builder/cli.js --dir')
    expect(ciWorkflow).toContain('--publish=never')
    expect(ciWorkflow).not.toContain('--publish never')
    expect(ciWorkflow).toContain('verify-cross-platform-package.mjs --platform ${{ matrix.target }} --arch ${{ matrix.arch }} --unpacked-only')
  })

  test('reads the Node version from .nvmrc and hard-fails empty artifact uploads', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    for (const workflow of [releaseWorkflow, ciWorkflow]) {
      expect(workflow).not.toMatch(/node-version:/)
      expect(workflow.match(/node-version-file: \.nvmrc/g)?.length).toBeGreaterThan(0)
      const uploads = workflow.match(/uses: actions\/upload-artifact@/g) ?? []
      expect(workflow.match(/if-no-files-found: error/g)).toHaveLength(uploads.length)
      expect(workflow).toContain('actions/cache@')
    }
    // Release jobs skip the CI-duplicated verification suite and never upload
    // an unpacked application directory; every platform publishes its update feed.
    expect(releaseWorkflow.match(/-- --skip-verify/g)).toHaveLength(3)
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/latest*.yml')
    expect(releaseWorkflow).toContain('release/linux/${{ matrix.arch }}/latest*.yml')
    expect(releaseWorkflow).toContain('release/win/**/latest*.yml')
    expect(releaseWorkflow).toMatch(/needs: \[validate, package, package-linux, package-windows\]/)
    expect(releaseWorkflow).toContain("needs.package-windows.result == 'skipped'")
    expect(releaseWorkflow).toContain('--platforms "$platforms"')
    expect(releaseWorkflow).toContain('release/linux/${{ matrix.arch }}/*.pacman')
    expect(releaseWorkflow).toContain('sudo apt-get install --yes libarchive-tools')
    expect(ciWorkflow).not.toMatch(/path: release\/(mac|linux|win)\/\s*$/m)
  })

  test('publishes one verified GitHub Release from an existing version tag', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(workflow).toMatch(/push:\n {4}tags:\n {6}- 'v\*\.\*\.\*'/)
    expect(workflow).toContain('node scripts/release/validate-release-tag.mjs --tag "$RELEASE_TAG"')
    expect(workflow).toContain('git merge-base --is-ancestor HEAD refs/remotes/origin/main')
    expect(workflow).toContain('node scripts/release/prepare-github-release.mjs')
    // The privileged publishing job installs only the runtime dependency tree
    // the release script needs, never the full dev toolchain.
    expect(workflow).toMatch(/release-packages:[\s\S]*?npm ci --omit=dev --ignore-scripts[\s\S]*?node scripts\/release\/prepare-github-release\.mjs/)
    expect(workflow).not.toContain('npm ci --ignore-scripts\n')
    expect(workflow).toContain('actions/download-artifact@')
    expect(workflow).toContain('actions/attest-build-provenance@')
    expect(workflow).toContain('gh release create "$RELEASE_TAG" release-assets/*')
    expect(workflow).toContain('gh release upload "$RELEASE_TAG" release-assets/* --clobber')
    expect(workflow).toContain('gh release edit "$RELEASE_TAG" --verify-tag --draft=false --latest')
    expect(workflow).toContain('is already published and will not be replaced')
    expect(workflow).toContain('--verify-tag')
    expect(workflow).toContain('--fail-on-no-commits')
    expect(workflow).toContain('--generate-notes')
    // always() keeps the aggregate gate from being skipped - and so from
    // silently satisfying a required status check - when a packaging job fails.
    expect(workflow).toMatch(
      /release-packages:\n {4}needs: \[validate, package, package-linux, package-windows\]\n(?: {4}#.*\n)* {4}if: >-\n {6}always\(\) && needs\.validate\.result == 'success' && needs\.package\.result == 'success' && needs\.package-linux\.result == 'success' &&\n {6}\(needs\.package-windows\.result == 'success' \|\| needs\.package-windows\.result == 'skipped'\)\n {4}runs-on: ubuntu-22\.04\n {4}permissions:\n {6}contents: write/,
    )
  })

  test('pins every release job to one commit SHA resolved by validate', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    const parsed = load(workflow) as { jobs: Record<string, { outputs?: Record<string, string>; steps?: Array<{ id?: string; run?: string; with?: Record<string, unknown> }> }> }
    expect(parsed.jobs.validate.outputs).toEqual({ sha: '${{ steps.resolve.outputs.sha }}' })
    expect(parsed.jobs.validate.steps?.find((step) => step.id === 'resolve')?.run).toContain('git rev-parse HEAD^{commit}')
    // validate resolves the movable tag once; every other job checks out that
    // SHA so a tag moved mid-run cannot make two jobs build different commits.
    for (const [name, job] of Object.entries(parsed.jobs)) {
      const checkouts = (job.steps ?? []).filter((step) => step.with && 'ref' in step.with)
      expect(checkouts.length, name).toBeGreaterThan(0)
      for (const step of checkouts) expect(step.with?.ref, name).toBe(name === 'validate' ? '${{ env.RELEASE_REF }}' : '${{ needs.validate.outputs.sha }}')
    }
    // The ancestry check depends on the full history fetched above.
    expect(workflow).toContain('# fetch-depth: 0 above is what populates refs/remotes/origin/*')
    expect(workflow).toMatch(/fetch-depth: 0\n[\s\S]*?git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/)
  })

  test('deletes stale draft assets before publishing a resumed release', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(workflow).toContain('gh release view "$RELEASE_TAG" --json assets > draft-release.json')
    expect(workflow).toContain('node scripts/release/prune-draft-release-assets.mjs --assets draft-release.json --expected release-assets')
    expect(workflow).toContain('gh release delete-asset "$RELEASE_TAG" "$stale" --yes')
    expect(workflow).toMatch(/delete-asset[\s\S]*?gh release upload "\$RELEASE_TAG" release-assets\/\* --clobber[\s\S]*?--draft=false/)
  })

  test('passes the expected Authenticode signer to Windows packaging', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(workflow).toContain('GOOEYPI_WINDOWS_CERT_SUBJECT: ${{ vars.GOOEYPI_WINDOWS_CERT_SUBJECT }}')
    expect(workflow).toContain('GOOEYPI_WINDOWS_CERT_THUMBPRINT: ${{ vars.GOOEYPI_WINDOWS_CERT_THUMBPRINT }}')
    const security = readFileSync('docs/security.md', 'utf8')
    expect(security).toContain('`GOOEYPI_WINDOWS_CERT_SUBJECT`')
    expect(security).toContain('`GOOEYPI_WINDOWS_CERT_THUMBPRINT`')
    expect(security).toContain('when neither is configured, public Windows packaging fails closed')
  })

  test('ships both mac architectures as separate builds from native-arch runners', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    // Two matrix legs, each on a runner whose native architecture matches the
    // target (arm64 on macos-15, x64 on macos-15-intel) so node-pty/zeromq never
    // cross-compile, and one leg's failure never cancels the other's build.
    expect(releaseWorkflow).toContain('fail-fast: false')
    expect(releaseWorkflow).toMatch(/- arch: arm64\n {12}runner: macos-15/)
    expect(releaseWorkflow).toMatch(/- arch: x64\n {12}runner: macos-15-intel/)
    expect(releaseWorkflow).toContain('runs-on: ${{ matrix.runner }}')
    // The explicit target arch drives packaging, and each leg uploads only its
    // own arch directory under a per-arch artifact name and cache key.
    expect(releaseWorkflow).toContain('npm run package:mac -- --skip-verify --arch ${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('name: gooeypi-public-macos-${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/*.dmg')
    expect(releaseWorkflow).toContain('release/mac/${{ matrix.arch }}/*.zip')
    expect(releaseWorkflow).toContain('electron-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles(')
    // Universal binaries are excluded by design: the release ships two builds.
    expect(releaseWorkflow).not.toContain('--universal')
  })

  test('ships both Linux architectures as separately labeled native builds', () => {
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(releaseWorkflow).toMatch(/package-linux:\n {4}needs: \[validate, quality, hermetic-e2e\]\n {4}strategy:/)
    expect(releaseWorkflow).toMatch(/- arch: arm64\n {12}runner: ubuntu-24\.04-arm/)
    expect(releaseWorkflow).toMatch(/- arch: x64\n {12}runner: ubuntu-22\.04/)
    expect(releaseWorkflow).toContain('runs-on: ${{ matrix.runner }}')
    expect(releaseWorkflow).toContain('npm run package:linux -- --skip-verify --arch ${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('name: gooeypi-public-linux-${{ matrix.arch }}')
    expect(releaseWorkflow).toContain('release/linux/${{ matrix.arch }}/*.AppImage')
    expect(releaseWorkflow).toContain('release/linux/${{ matrix.arch }}/latest*.yml')
    expect(releaseWorkflow).toContain('electron-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles(')
  })
})

describe('GitHub Release publication', () => {
  test('selects an exact enabled platform set', () => {
    expect(parseReleasePlatforms('mac,linux')).toEqual(['mac', 'linux'])
    expect(expectedGitHubReleaseAssets('0.2.0', ['mac', 'linux'])).not.toContain('GooeyPi-0.2.0-win-x64.exe')
    expect(expectedGitHubReleaseAssets('0.2.0', ['mac'])).toEqual(['GooeyPi-0.2.0-arm64.zip', 'GooeyPi-0.2.0-intel-chip.dmg', 'GooeyPi-0.2.0-m-chip.dmg', 'GooeyPi-0.2.0-x64.zip', 'latest-mac.yml'])
    expect(expectedDownloadedReleaseAssets('0.2.0', ['mac'])).toEqual(['GooeyPi-0.2.0-arm64.zip', 'GooeyPi-0.2.0-x64.dmg', 'GooeyPi-0.2.0-arm64.dmg', 'GooeyPi-0.2.0-x64.zip', 'latest-mac.yml'])
    expect(expectedGitHubReleaseAssets('0.2.0', ['linux'])).toEqual([
      'GooeyPi-0.2.0-linux-aarch64.pacman',
      'GooeyPi-0.2.0-linux-aarch64.rpm',
      'GooeyPi-0.2.0-linux-amd64.deb',
      'GooeyPi-0.2.0-linux-arm64.AppImage',
      'GooeyPi-0.2.0-linux-arm64.deb',
      'GooeyPi-0.2.0-linux-x64.pacman',
      'GooeyPi-0.2.0-linux-x86_64.AppImage',
      'GooeyPi-0.2.0-linux-x86_64.rpm',
      'latest-linux-arm64.yml',
      'latest-linux.yml',
    ])
    expect(() => parseReleasePlatforms('mac,mac')).toThrow(/duplicates/)
    expect(() => parseReleasePlatforms('mac,android')).toThrow(/Unsupported/)
  })

  test('keeps every release asset name in exact correspondence with electron-builder artifacts', () => {
    // Derived from the same package.json build config and builder-util `${arch}`
    // rules the packaging step uses, so renaming a target or adding an
    // architecture fails here instead of during a real tag push.
    const config = readElectronBuilderConfig()
    const produced = producedReleaseArtifactNames(config, '0.2.0')
    const names = releaseAssetNames('0.2.0')
    const feeds = [...names.keys()].filter((name) => name.endsWith('.yml'))
    expect(feeds).toEqual(['latest-linux-arm64.yml', 'latest-linux.yml', 'latest-mac.yml', 'latest.yml'])
    // Every produced artifact is published and every published asset (other than
    // the updater feeds) is produced - both directions, no index coupling.
    expect([...names.values()].filter((name) => !name.endsWith('.yml')).sort()).toEqual(produced)
    const targetCount = Object.entries(RELEASE_BUILD_MATRIX).reduce((total, [platform, architectures]) => total + architectures.length * config[platform].target.length, 0)
    expect(produced).toHaveLength(targetCount)
    // Only the two macOS DMGs are renamed for the public download page.
    expect([...names].filter(([published, downloaded]) => published !== downloaded)).toEqual([
      ['GooeyPi-0.2.0-intel-chip.dmg', 'GooeyPi-0.2.0-x64.dmg'],
      ['GooeyPi-0.2.0-m-chip.dmg', 'GooeyPi-0.2.0-arm64.dmg'],
    ])
  })

  test('covers exactly the platform and architecture legs the release workflow builds', () => {
    const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as {
      jobs: Record<string, { strategy?: { matrix?: { include?: Array<{ arch: string }> } }; steps?: Array<{ run?: string }> }>
    }
    const architectures = (job: string) => (workflow.jobs[job].strategy?.matrix?.include ?? []).map((leg) => leg.arch).sort()
    expect(architectures('package')).toEqual([...RELEASE_BUILD_MATRIX.mac].sort())
    expect(architectures('package-linux')).toEqual([...RELEASE_BUILD_MATRIX.linux].sort())
    // The Windows leg is a single non-matrix job.
    expect(workflow.jobs['package-windows'].strategy).toBeUndefined()
    expect(RELEASE_BUILD_MATRIX.win).toEqual(['x64'])
  })

  test('reports the published name of a missing artifact through the rename map', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-github-release-missing-'))
    try {
      const { projectDirectory, inputDirectory } = writeMacReleaseFixture(directory, { omit: 'GooeyPi-0.2.0-arm64.dmg' })
      // The arm64 DMG publishes as m-chip.dmg: the report must name the missing
      // published asset, not whichever entry happens to share its sort index.
      await expect(prepareGitHubRelease({ inputDirectory, outputDirectory: join(directory, 'out'), projectDirectory, platforms: ['mac'], tag: 'v0.2.0' })).rejects.toThrow(
        /incomplete; missing GooeyPi-0\.2\.0-m-chip\.dmg$/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('takes legacy updater fields from the primary architecture manifest, not the first sorted path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-update-metadata-'))
    try {
      const arm64 = writeUpdateManifest(directory, 'a-arm64', 'GooeyPi-0.2.0-arm64.zip', 'arm64-digest', '2026-01-01T00:00:00.000Z')
      const x64 = writeUpdateManifest(directory, 'z-x64', 'GooeyPi-0.2.0-x64.zip', 'x64-digest', '2026-02-02T00:00:00.000Z')
      const merged = mergeUpdateMetadata([arm64, x64], '0.2.0')
      expect(merged.path).toBe('GooeyPi-0.2.0-x64.zip')
      expect(merged.sha512).toBe('x64-digest')
      expect(merged.releaseDate).toBe('2026-02-02T00:00:00.000Z')
      expect(merged.files.map((file: { url: string }) => file.url)).toEqual(['GooeyPi-0.2.0-arm64.zip', 'GooeyPi-0.2.0-x64.zip'])
      // Renaming the artifact directories reverses the path sort order without
      // changing which manifest supplies the legacy fields.
      const swappedArm64 = writeUpdateManifest(directory, 'z-arm', 'GooeyPi-0.2.0-arm64.zip', 'arm64-digest', '2026-01-01T00:00:00.000Z')
      const swappedX64 = writeUpdateManifest(directory, 'a-intel', 'GooeyPi-0.2.0-x64.zip', 'x64-digest', '2026-02-02T00:00:00.000Z')
      expect(mergeUpdateMetadata([swappedArm64, swappedX64], '0.2.0')).toEqual(merged)
      expect(mergeUpdateMetadata([swappedX64, swappedArm64], '0.2.0')).toEqual(merged)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects updater metadata without a usable size or digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-update-metadata-invalid-'))
    try {
      const write = (name: string, file: string) => {
        const path = join(directory, name)
        writeFileSync(path, `version: 0.2.0\nfiles:\n${file}`)
        return path
      }
      const sized = (size: string) => `  - url: GooeyPi-0.2.0-x64.zip\n    sha512: digest\n    size: ${size}\n`
      expect(() => mergeUpdateMetadata([write('missing-size.yml', '  - url: GooeyPi-0.2.0-x64.zip\n    sha512: digest\n')], '0.2.0')).toThrow(/invalid size/)
      expect(() => mergeUpdateMetadata([write('zero-size.yml', sized('0'))], '0.2.0')).toThrow(/invalid size/)
      expect(() => mergeUpdateMetadata([write('negative-size.yml', sized('-1'))], '0.2.0')).toThrow(/invalid size/)
      expect(() => mergeUpdateMetadata([write('text-size.yml', sized("'42'"))], '0.2.0')).toThrow(/invalid size/)
      expect(() => mergeUpdateMetadata([write('empty-digest.yml', "  - url: GooeyPi-0.2.0-x64.zip\n    sha512: ''\n    size: 42\n")], '0.2.0')).toThrow(/no sha512/)
      expect(() => mergeUpdateMetadata([write('valid.yml', sized('42'))], '0.2.0')).not.toThrow()
      expect(() => mergeUpdateMetadata([write('a.yml', sized('42')), write('b.yml', sized('43'))], '0.2.0')).toThrow(/disagrees/)
      expect(() => mergeUpdateMetadata([], '0.2.0')).toThrow(/missing/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('deletes only unexpected assets from a resumed draft release', () => {
    const assets = ['GooeyPi-0.2.0-m-chip.dmg', 'GooeyPi-0.1.9-arm64.dmg', 'latest-mac.yml', 'SHA256SUMS.txt']
    const expected = ['GooeyPi-0.2.0-m-chip.dmg', 'latest-mac.yml', 'SHA256SUMS.txt']
    expect(staleDraftReleaseAssets(assets, expected)).toEqual(['GooeyPi-0.1.9-arm64.dmg'])
    expect(staleDraftReleaseAssets(expected, expected)).toEqual([])
    // An empty expected set would delete the whole draft, so it fails instead.
    expect(() => staleDraftReleaseAssets(assets, [])).toThrow(/expected release asset set is empty/)
    expect(parseDraftAssetNames(JSON.stringify({ assets: [{ name: 'a.dmg' }, { name: 'b.zip' }] }))).toEqual(['a.dmg', 'b.zip'])
    expect(() => parseDraftAssetNames(JSON.stringify({ assets: [{ label: 'a.dmg' }] }))).toThrow(/without a name/)
    expect(() => parseDraftAssetNames(JSON.stringify({}))).toThrow(/not an array/)
  })

  test('prints the stale draft assets when run as a script', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-draft-prune-'))
    try {
      mkdirSync(join(directory, 'release-assets'))
      for (const name of ['GooeyPi-0.2.0-m-chip.dmg', 'SHA256SUMS.txt']) writeFileSync(join(directory, 'release-assets', name), 'asset')
      writeFileSync(join(directory, 'draft.json'), JSON.stringify({ assets: [{ name: 'GooeyPi-0.2.0-m-chip.dmg' }, { name: 'GooeyPi-0.1.9-arm64.dmg' }] }))
      const args = ['scripts/release/prune-draft-release-assets.mjs', '--assets', join(directory, 'draft.json'), '--expected', join(directory, 'release-assets')]
      const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
      expect(result.status).toBe(0)
      expect(result.stdout.trim().split('\n')).toEqual(['GooeyPi-0.1.9-arm64.dmg'])
      const failed = spawnSync(process.execPath, args.slice(0, 3), { encoding: 'utf8' })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toMatch(/Draft release asset pruning failed/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('requires the tag and both package manifests to agree exactly', () => {
    expect(assertReleaseTag('v0.2.0', '0.2.0', '0.2.0')).toEqual({ tag: 'v0.2.0', version: '0.2.0' })
    expect(() => assertReleaseTag('0.2.0', '0.2.0', '0.2.0')).toThrow(/must exactly match/)
    expect(() => assertReleaseTag('v0.2.1', '0.2.0', '0.2.0')).toThrow(/v0\.2\.0/)
    expect(() => assertReleaseTag('v0.2.0', '0.2.0', '0.1.9')).toThrow(/does not match/)
    expect(() => assertReleaseTag('v0.2.0', '0.2.0', '0.2.0', '0.1.9')).toThrow(/root package version/)
    expect(() => assertReleaseTag('v01.2.3', '01.2.3', '01.2.3')).toThrow(/not a supported semantic version/)
  })

  test('selects the exact cross-platform asset set and writes reproducible checksums', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-github-release-'))
    const projectDirectory = join(directory, 'project')
    const inputDirectory = join(directory, 'downloaded')
    const outputDirectory = join(directory, 'release-assets')
    mkdirSync(projectDirectory, { recursive: true })
    mkdirSync(inputDirectory, { recursive: true })
    writeFileSync(join(projectDirectory, 'package.json'), JSON.stringify({ version: '0.2.0' }))
    writeFileSync(join(projectDirectory, 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }))
    const expected = expectedGitHubReleaseAssets('0.2.0')
    const downloaded = expectedDownloadedReleaseAssets('0.2.0')
    for (const [index, name] of downloaded.entries()) {
      const artifactDirectory = join(inputDirectory, `artifact-${index}`)
      mkdirSync(artifactDirectory)
      const updateTarget =
        name === 'latest-mac.yml'
          ? 'GooeyPi-0.2.0-arm64.zip'
          : name === 'latest-linux.yml'
            ? 'GooeyPi-0.2.0-linux-x86_64.AppImage'
            : name === 'latest-linux-arm64.yml'
              ? 'GooeyPi-0.2.0-linux-arm64.AppImage'
              : 'GooeyPi-0.2.0-win-x64.exe'
      const content = name.startsWith('latest')
        ? `version: 0.2.0\nfiles:\n  - url: ${updateTarget}\n    sha512: checksum-${index}\n    size: ${index + 1}\n${name === 'latest-mac.yml' ? '  - url: GooeyPi-0.2.0-arm64.dmg\n    sha512: checksum-arm64-dmg\n    size: 44\n' : ''}path: ${updateTarget}\nsha512: checksum-${index}\n`
        : `asset ${index}`
      writeFileSync(join(artifactDirectory, name), content)
    }
    const secondMacManifest = join(inputDirectory, 'macos-x64')
    mkdirSync(secondMacManifest)
    writeFileSync(join(secondMacManifest, 'latest-mac.yml'), 'version: 0.2.0\nfiles:\n  - url: GooeyPi-0.2.0-x64.zip\n    sha512: checksum-x64\n    size: 42\n')
    try {
      const result = await prepareGitHubRelease({ inputDirectory, outputDirectory, projectDirectory, tag: 'v0.2.0' })
      expect(result.assets).toEqual(expected)
      expect(readdirSync(outputDirectory).sort()).toEqual([...expected, 'SHA256SUMS.txt'].sort())
      const checksums = readFileSync(join(outputDirectory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n')
      expect(checksums).toHaveLength(expected.length)
      for (const name of expected) {
        const digest = createHash('sha256')
          .update(readFileSync(join(outputDirectory, name)))
          .digest('hex')
        expect(checksums).toContain(`${digest}  ${name}`)
      }
      const macFeed = readFileSync(join(outputDirectory, 'latest-mac.yml'), 'utf8')
      expect(macFeed).toContain('GooeyPi-0.2.0-arm64.zip')
      expect(macFeed).toContain('GooeyPi-0.2.0-x64.zip')
      expect(macFeed).toContain('GooeyPi-0.2.0-m-chip.dmg')
      expect(macFeed).not.toContain('GooeyPi-0.2.0-arm64.dmg')
      const linuxFeed = readFileSync(join(outputDirectory, 'latest-linux.yml'), 'utf8')
      expect(linuxFeed).toContain('GooeyPi-0.2.0-linux-x86_64.AppImage')
      expect(linuxFeed).not.toContain('GooeyPi-0.2.0-linux-arm64.AppImage')
      const linuxArmFeed = readFileSync(join(outputDirectory, 'latest-linux-arm64.yml'), 'utf8')
      expect(linuxArmFeed).toContain('GooeyPi-0.2.0-linux-arm64.AppImage')
      expect(linuxArmFeed).not.toContain('GooeyPi-0.2.0-linux-x86_64.AppImage')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects incomplete and duplicate downloaded release assets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gooeypi-github-release-invalid-'))
    const projectDirectory = join(directory, 'project')
    const inputDirectory = join(directory, 'downloaded')
    mkdirSync(projectDirectory, { recursive: true })
    mkdirSync(inputDirectory, { recursive: true })
    writeFileSync(join(projectDirectory, 'package.json'), JSON.stringify({ version: '0.2.0' }))
    writeFileSync(join(projectDirectory, 'package-lock.json'), JSON.stringify({ version: '0.2.0', packages: { '': { version: '0.2.0' } } }))

    try {
      await expect(prepareGitHubRelease({ inputDirectory, outputDirectory: join(directory, 'missing-output'), projectDirectory, tag: 'v0.2.0' })).rejects.toThrow(/incomplete/)
      const expected = expectedDownloadedReleaseAssets('0.2.0')
      for (const [index, name] of expected.entries()) {
        const artifactDirectory = join(inputDirectory, `artifact-${index}`)
        mkdirSync(artifactDirectory)
        const updateTarget =
          name === 'latest-mac.yml'
            ? 'GooeyPi-0.2.0-arm64.zip'
            : name === 'latest-linux.yml'
              ? 'GooeyPi-0.2.0-linux-x86_64.AppImage'
              : name === 'latest-linux-arm64.yml'
                ? 'GooeyPi-0.2.0-linux-arm64.AppImage'
                : 'GooeyPi-0.2.0-win-x64.exe'
        writeFileSync(join(artifactDirectory, name), name.startsWith('latest') ? `version: 0.2.0\nfiles:\n  - url: ${updateTarget}\n    sha512: checksum-${index}\n` : `asset ${index}`)
      }
      const duplicateDirectory = join(inputDirectory, 'duplicate')
      mkdirSync(duplicateDirectory)
      writeFileSync(join(duplicateDirectory, expected[0]), 'duplicate')
      await expect(prepareGitHubRelease({ inputDirectory, outputDirectory: join(directory, 'duplicate-output'), projectDirectory, tag: 'v0.2.0' })).rejects.toThrow(/duplicate/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('fuse hardening configuration', () => {
  test('uses only the configured canonical afterPack hook', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(packageJson.build.afterPack).toBe('scripts/release/after-pack.cjs')
    expect(() => readFileSync('scripts/afterPack.cjs', 'utf8')).toThrow()
    expect(readFileSync(packageJson.build.afterPack, 'utf8')).toContain('FuseV1Options.OnlyLoadAppFromAsar')
  })
})

describe('coverage configuration', () => {
  test('includes every extracted plugin module without weakening thresholds', () => {
    const config = readFileSync('vitest.config.ts', 'utf8')
    expect(config).toContain("'electron/main/plugins/**/*.ts'")
    expect(config).toContain('statements: 65')
    expect(config).toContain('branches: 50')
    expect(config).toContain('functions: 70')
    expect(config).toContain('lines: 75')
  })
})

describe('post-package verification helpers', () => {
  test('parses Team IDs and architecture lists', () => {
    expect(parseTeamIdentifier('Authority=Developer ID\nTeamIdentifier=TEAM123\n')).toBe('TEAM123')
    expect(parseArchitectures('arm64 x86_64\n')).toEqual(new Set(['arm64', 'x86_64']))
  })

  test('requires exactly one DMG and ZIP and binds their declared architecture', () => {
    expect(requireReleaseArtifacts(['/release/Prime Work-0.1.0-arm64.dmg', '/release/Prime Work-0.1.0-arm64.zip'])).toEqual({
      dmg: '/release/Prime Work-0.1.0-arm64.dmg',
      zip: '/release/Prime Work-0.1.0-arm64.zip',
    })
    expect(() => requireReleaseArtifacts(['/release/Prime Work-0.1.0-arm64.dmg'])).toThrow(/ZIP/)
    expect(artifactArchitectures('Prime Work-0.1.0-universal.zip')).toEqual(new Set(['arm64', 'x86_64']))
    expect(() => assertExactArchitectures(new Set(['arm64']), artifactArchitectures('Prime Work-0.1.0-arm64.dmg'), 'DMG')).not.toThrow()
    expect(() => assertExactArchitectures(new Set(['x86_64']), artifactArchitectures('Prime Work-0.1.0-arm64.dmg'), 'DMG')).toThrow(/do not match/)
  })

  test('requires native modules to cover every application architecture', () => {
    expect(() => assertArchitectureCoverage(new Set(['arm64']), new Set(['arm64']), 'pty.node')).not.toThrow()
    expect(() => assertArchitectureCoverage(new Set(['arm64', 'x86_64']), new Set(['arm64']), 'pty.node')).toThrow(/x86_64/)
  })

  test('requires the ASAR and rejects duplicated renderer dependencies', () => {
    const entries = [
      '/out/main/index.js',
      '/out/preload/index.js',
      '/out/renderer/index.html',
      '/node_modules/node-pty/lib/index.js',
      '/node_modules/zeromq/lib/index.js',
      '/node_modules/zeromq/build/manifest.json',
    ]
    expect(() => assertAsarLayout(entries)).not.toThrow()
    expect(() => assertAsarLayout([...entries, '/node_modules/react/index.js'])).toThrow(/duplicated/)
    expect(() => assertAsarLayout(entries.filter((entry) => !entry.includes('node-pty')))).toThrow(/missing required/)
    expect(() => assertAsarLayout(entries.map((entry) => entry.replaceAll('/', '\\')))).not.toThrow()
  })

  test('keeps every platform native unpack allowlist exact and architecture-specific', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.author).toEqual({ name: 'GooeyPi contributors', email: '42459108+am-will@users.noreply.github.com' })
    expect(packageJson.description).toBe('A desktop workspace for Pi, OMP, and Prime Agent')
    expect(packageJson.homepage).toBe('https://github.com/am-will/gooey-pi')
    expect(packageJson.build.productName).toBe('GooeyPi')
    expect(packageJson.build.appId).toBe('app.gooeypi.desktop')
    expect(packageJson.desktopName).toBe('gooeypi.desktop')
    expect(packageJson.build.linux.synopsis).toBe(packageJson.description)
    expect(packageJson.build.linux.syncDesktopName).toBe(true)
    expect(packageJson.build.asarUnpack).toBeUndefined()
    expect(packageJson.build.mac.asarUnpack).toEqual([
      '**/node_modules/node-pty/build/Release/pty.node',
      '**/node_modules/node-pty/build/Release/spawn-helper',
      '**/node_modules/zeromq/build/darwin/${arch}/node/*-Release/addon.node',
    ])
    expect(packageJson.build.linux.asarUnpack).toEqual(['**/node_modules/node-pty/build/Release/pty.node', '**/node_modules/zeromq/build/linux/${arch}/node/**/addon.node'])
    expect(packageJson.build.win.asarUnpack).toEqual([
      '**/node_modules/node-pty/prebuilds/win32-${arch}/pty.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty_console_list.node',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/winpty-agent.exe',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/winpty.dll',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe',
      '**/node_modules/node-pty/prebuilds/win32-${arch}/conpty/conpty.dll',
      '**/node_modules/zeromq/build/win32/${arch}/node/**/addon.node',
    ])
    expect(packageJson.build.linux.target).toEqual(['AppImage', 'deb', 'rpm', 'pacman'])
    expect(packageJson.build.win.target).toEqual(['nsis', 'zip'])
    expect(packageJson.build.directories.output).toBe('release')
  })

  test('verifies and uploads every configured Linux installer format', () => {
    expect(expectedArtifactExtensions('linux')).toEqual(['.AppImage', '.deb', '.rpm', '.pacman'])
    const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8')
    expect(ciWorkflow).toContain('release/linux/**/*.pacman')
    expect(releaseWorkflow).toContain('release/linux/${{ matrix.arch }}/*.pacman')
  })

  test('fails closed when Windows Authenticode verification is not valid', () => {
    const signerEnvironment = { GOOEYPI_WINDOWS_CERT_SUBJECT: 'CN=Example Ltd' }
    const calls: Array<{ file: string; args: string[]; path: string | undefined }> = []
    const validSpawn = (file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ file, args, path: options.env?.GOOEYPI_SIGNED_FILE })
      return { status: 0, stdout: '', stderr: '' }
    }
    const spawn = validSpawn as unknown as Parameters<typeof assertValidAuthenticode>[1]
    expect(() => assertValidAuthenticode('C:\\release\\GooeyPi.exe', spawn, signerEnvironment)).not.toThrow()
    expect(calls).toEqual([
      {
        file: 'powershell.exe',
        args: expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
        path: 'C:\\release\\GooeyPi.exe',
      },
    ])
    const invalidSpawn = () => ({ status: 1, stdout: '', stderr: 'NotSigned' })
    expect(() => assertValidAuthenticode('C:\\release\\GooeyPi.exe', invalidSpawn as unknown as Parameters<typeof assertValidAuthenticode>[1], signerEnvironment)).toThrow(/NotSigned/)
  })

  test('asserts the expected Authenticode signer instead of any trusted certificate', () => {
    expect(expectedAuthenticodeSigner({ GOOEYPI_WINDOWS_CERT_SUBJECT: '  CN=Example Ltd, C=GB  ' })).toEqual({ subject: 'CN=Example Ltd, C=GB', thumbprint: '' })
    expect(expectedAuthenticodeSigner({ GOOEYPI_WINDOWS_CERT_THUMBPRINT: 'a1:b2 c3d4e5f60718293a4b5c6d7e8f901a2b3c4d' })).toEqual({
      subject: '',
      thumbprint: 'A1B2C3D4E5F60718293A4B5C6D7E8F901A2B3C4D',
    })
    expect(() => expectedAuthenticodeSigner({ GOOEYPI_WINDOWS_CERT_THUMBPRINT: 'not-a-thumbprint' })).toThrow(/40-character SHA-1 certificate thumbprint/)
    // Unconfigured fails closed rather than accepting whoever the runner trusts.
    expect(() => expectedAuthenticodeSigner({})).toThrow(/GOOEYPI_WINDOWS_CERT_SUBJECT and\/or GOOEYPI_WINDOWS_CERT_THUMBPRINT/)

    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = []
    const spawn = (_file: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env })
      return { status: 0, stdout: '', stderr: '' }
    }
    assertValidAuthenticode('C:\\release\\GooeyPi.exe', spawn as unknown as Parameters<typeof assertValidAuthenticode>[1], {
      GOOEYPI_WINDOWS_CERT_SUBJECT: 'CN=Example Ltd',
      GOOEYPI_WINDOWS_CERT_THUMBPRINT: 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d',
    })
    // The file path and expected signer are passed as environment variables, never
    // interpolated into the script, and a terminating error exits non-zero.
    expect(calls[0].env).toMatchObject({
      GOOEYPI_SIGNED_FILE: 'C:\\release\\GooeyPi.exe',
      GOOEYPI_WINDOWS_CERT_SUBJECT: 'CN=Example Ltd',
      GOOEYPI_WINDOWS_CERT_THUMBPRINT: 'A1B2C3D4E5F60718293A4B5C6D7E8F901A2B3C4D',
    })
    const script = calls[0].args.at(-1) as string
    expect(script).not.toContain('C:\\release\\GooeyPi.exe')
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain('try {')
    expect(script).toContain('} catch {')
    expect(script).toContain('exit 1')
    expect(script).toContain('$certificate.Subject -ne $env:GOOEYPI_WINDOWS_CERT_SUBJECT')
    expect(script).toContain('$certificate.Thumbprint.ToUpperInvariant() -ne $env:GOOEYPI_WINDOWS_CERT_THUMBPRINT')
  })

  test('excludes other platform ZeroMQ build trees and declares zeromq directly', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(packageJson.build.mac.files).toEqual(['out/**/*', 'package.json', '!**/node_modules/zeromq/build/linux/**', '!**/node_modules/zeromq/build/win32/**'])
    expect(packageJson.build.linux.files).toEqual(['out/**/*', 'package.json', '!**/node_modules/zeromq/build/darwin/**', '!**/node_modules/zeromq/build/win32/**'])
    expect(packageJson.build.win.files).toEqual(['out/**/*', 'package.json', '!**/node_modules/zeromq/build/darwin/**', '!**/node_modules/zeromq/build/linux/**'])
    // Pin the app to the zeromq range prime-agent uses so the packaged addon
    // and the agent's runtime expectations cannot drift apart silently.
    const primeAgent = JSON.parse(readFileSync(new URL('../node_modules/prime-agent/package.json', import.meta.url), 'utf8'))
    expect(packageJson.dependencies.zeromq).toBe(primeAgent.dependencies.zeromq)
  })

  test('accepts bounded ZeroMQ ABI fallbacks per architecture', () => {
    const architectures = new Set(['arm64'])
    const fallbackDirectory = createUnpackedFixture(architectures)
    const fallback = join(fallbackDirectory, fixtureAddonPath('arm64', 'libc-999-Release'))
    mkdirSync(dirname(fallback), { recursive: true })
    writeFileSync(fallback, 'fixture')
    try {
      expect(() => assertUnpackedNativeLayout(fallbackDirectory, architectures, () => architectures)).not.toThrow()
    } finally {
      rmSync(fallbackDirectory, { recursive: true, force: true })
    }

    const futureDirectory = mkdtempSync(join(tmpdir(), 'prime-work-unpacked-'))
    for (const relativePath of [...expectedUnpackedNativeLayout(architectures).files, fixtureAddonPath('arm64', 'libc-999-Release')]) {
      const path = join(futureDirectory, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fixture')
    }
    try {
      // A future runtime-library name still matches the bounded wildcard.
      expect(() => assertUnpackedNativeLayout(futureDirectory, architectures, () => architectures)).not.toThrow()
    } finally {
      rmSync(futureDirectory, { recursive: true, force: true })
    }
  })

  test('accepts the exact unpacked native fixture with complete architecture coverage', () => {
    const architectures = new Set(['arm64'])
    const directory = createUnpackedFixture(architectures)
    try {
      expect(() => assertUnpackedNativeLayout(directory, architectures, () => new Set(['arm64']))).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects missing and extra unpacked fixture files', () => {
    const architectures = new Set(['arm64'])
    const missingDirectory = createUnpackedFixture(architectures)
    rmSync(join(missingDirectory, expectedUnpackedNativeLayout(architectures).files.at(-1)!))
    try {
      expect(() => assertUnpackedNativeLayout(missingDirectory, architectures, () => architectures)).toThrow(/Missing unpacked/)
    } finally {
      rmSync(missingDirectory, { recursive: true, force: true })
    }

    const extraDirectory = createUnpackedFixture(architectures)
    const extraPath = join(extraDirectory, 'node_modules/extra/native.node')
    mkdirSync(dirname(extraPath), { recursive: true })
    writeFileSync(extraPath, 'fixture')
    try {
      expect(() => assertUnpackedNativeLayout(extraDirectory, architectures, () => architectures)).toThrow(/Unexpected unpacked.*extra/)
    } finally {
      rmSync(extraDirectory, { recursive: true, force: true })
    }

    const extraPrefixDirectory = createUnpackedFixture(architectures)
    mkdirSync(join(extraPrefixDirectory, 'empty-prefix'))
    try {
      expect(() => assertUnpackedNativeLayout(extraPrefixDirectory, architectures, () => architectures)).toThrow(/Unexpected unpacked.*empty-prefix/)
    } finally {
      rmSync(extraPrefixDirectory, { recursive: true, force: true })
    }
  })

  test('checks every allowed native fixture file against the application architecture', () => {
    const architectures = new Set(['arm64'])
    const directory = createUnpackedFixture(architectures)
    try {
      expect(() => assertUnpackedNativeLayout(directory, architectures, (path: string) => (path.endsWith('addon.node') ? new Set(['x86_64']) : new Set(['arm64'])))).toThrow(
        /addon\.node is missing app architecture.*arm64/,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('cross-platform packaging repair', () => {
  const fixtureContext = {
    appOutDir: join('/tmp', 'app-out'),
    packager: { appInfo: { productFilename: 'Prime Work', sanitizedName: 'Prime-Work' } },
  }

  test('computes the hardened executable path per platform', () => {
    expect(executablePath(fixtureContext, 'darwin')).toBe(join('/tmp', 'app-out', 'Prime Work.app', 'Contents', 'MacOS', 'Prime Work'))
    expect(executablePath(fixtureContext, 'win32')).toBe(join('/tmp', 'app-out', 'Prime Work.exe'))
    expect(executablePath(fixtureContext, 'linux')).toBe(join('/tmp', 'app-out', 'prime-work'))
  })

  function globMatchExists(directory: string, segments: string[]): boolean {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) return false
    const [head, ...rest] = segments
    if (head === undefined) return false
    if (head === '**') {
      if (globMatchExists(directory, rest)) return true
      return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .some((entry) => globMatchExists(join(directory, entry.name), segments))
    }
    if (head.includes('*')) {
      const pattern = new RegExp(
        `^${head
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]*')}$`,
      )
      const entries = readdirSync(directory, { withFileTypes: true })
      if (rest.length === 0) return entries.some((entry) => entry.isFile() && pattern.test(entry.name))
      return entries.filter((entry) => entry.isDirectory() && pattern.test(entry.name)).some((entry) => globMatchExists(join(directory, entry.name), rest))
    }
    const next = join(directory, head)
    if (rest.length === 0) return existsSync(next) && statSync(next).isFile()
    return globMatchExists(next, rest)
  }

  test('every asarUnpack glob matches at least one real file for platforms present in node_modules', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const root = new URL('..', import.meta.url).pathname
    const localArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
    const localTarget = process.platform === 'darwin' ? 'mac' : process.platform
    const architecturesFor = (glob: string) => (glob.includes('node-pty/build/Release') ? [localArchitecture] : ['arm64', 'x64'])
    for (const target of ['mac', 'linux', 'win']) {
      for (const glob of packageJson.build[target].asarUnpack as string[]) {
        if (glob.includes('node-pty/build/Release') && target !== localTarget) continue
        const covered = architecturesFor(glob).some((architecture) => {
          const relativeGlob = glob.replace(/^\*\*\//, '').replaceAll('${arch}', architecture)
          const platformRoot = relativeGlob.split('/').slice(0, 4).join('/')
          if (!existsSync(join(root, platformRoot))) return false
          return globMatchExists(root, relativeGlob.split('/'))
        })
        expect(covered, `asarUnpack glob matches no file in node_modules: ${glob}`).toBe(true)
      }
    }
  })

  test('the verifier and package.json agree on native directory naming', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    for (const [target, architecture] of [
      ['win', 'x64'],
      ['win', 'arm64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
    ] as const) {
      const globs = (packageJson.build[target].asarUnpack as string[]).map((glob) => glob.replace(/^\*\*\//, '').replaceAll('${arch}', architecture))
      for (const file of expectedNativeFiles(target, architecture)) {
        expect(globs, `verifier requires ${file} but no ${target} asarUnpack glob produces it`).toContain(file)
      }
      const zeroMqGlob = globs.find((glob) => glob.includes('zeromq'))
      expect(zeroMqGlob).toBe(`node_modules/zeromq/build/${nativeRuntimeDirectory(target)}/${architecture}/node/**/addon.node`)
      const sampleAddon = `node_modules/zeromq/build/${nativeRuntimeDirectory(target)}/${architecture}/node/glibc-x64-115-Release/addon.node`
      expect(zeroMqAddonPattern(target, architecture).test(sampleAddon)).toBe(true)
    }
    expect(nativeRuntimeDirectory('win')).toBe('win32')
    expect(nativeRuntimeDirectory('linux')).toBe('linux')
  })

  test('accepts ZeroMQ ABI and libc fallbacks only within the target architecture', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prime-work-cross-platform-unpacked-'))
    const nativeFiles = [
      ...expectedNativeFiles('linux', 'x64'),
      'node_modules/zeromq/build/linux/x64/node/glibc-127-Release/addon.node',
      'node_modules/zeromq/build/linux/x64/node/musl-127-Release/addon.node',
    ]
    for (const relativePath of nativeFiles) {
      const path = join(directory, relativePath)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, 'fixture')
    }
    try {
      expect(() => assertCrossPlatformUnpackedNativeLayout(directory, 'linux', 'x64')).not.toThrow()
      rmSync(join(directory, 'node_modules/zeromq'), { recursive: true, force: true })
      expect(() => assertCrossPlatformUnpackedNativeLayout(directory, 'linux', 'x64')).toThrow(/expected at least 1/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('resolves release-script commands to Windows-safe spawns', () => {
    expect(resolveCommandInvocation('node', ['scripts/release/verify.mjs'])).toEqual({ file: process.execPath, args: ['scripts/release/verify.mjs'], shell: false })
    const builder = resolveCommandInvocation('electron-builder', ['install-app-deps'])
    expect(builder.file).toBe(process.execPath)
    expect(builder.shell).toBe(false)
    expect(builder.args[0]).toMatch(/electron-builder[\\/]cli\.js$/)
    expect(builder.args.at(-1)).toBe('install-app-deps')
    const packageScript = readFileSync('scripts/release/package.mjs', 'utf8')
    expect(packageScript).toContain("run('electron-builder', builderArgs, builderEnv)")
    expect(packageScript).not.toContain("['exec', '--', 'electron-builder'")
    const npmViaLifecycle = resolveCommandInvocation('npm', ['run', 'release:verify'], 'win32', { npm_execpath: 'C:/npm/npm-cli.js' })
    expect(npmViaLifecycle).toEqual({ file: process.execPath, args: ['C:/npm/npm-cli.js', 'run', 'release:verify'], shell: false })
    expect(resolveCommandInvocation('npm', ['ci'], 'win32', {})).toEqual({ file: 'npm.cmd', args: ['ci'], shell: true })
    expect(resolveCommandInvocation('npm', ['ci'], 'darwin', {})).toEqual({ file: 'npm', args: ['ci'], shell: false })
  })
})

describe('DMG verification cleanup', () => {
  test('detach failures are logged instead of masking the original error and cleanup always runs', () => {
    const source = readFileSync('scripts/release/verify-package.mjs', 'utf8')
    const verifyDmg = source.slice(source.indexOf('async function verifyDmg'), source.indexOf('export async function verifyPackage'))
    // hdiutil detach runs inside its own try/catch that only logs.
    expect(verifyDmg).toMatch(/try\s*\{\s*run\('hdiutil', \['detach', mountPoint\]\)\s*\}\s*catch \(detachError\)\s*\{\s*console\.error/)
    // The rmSync cleanup is attempted unconditionally after the detach attempt.
    const finallyIndex = verifyDmg.indexOf('} finally {')
    const cleanupIndex = verifyDmg.indexOf('rmSync(mountPoint, { recursive: true, force: true })')
    expect(finallyIndex).toBeGreaterThan(-1)
    expect(cleanupIndex).toBeGreaterThan(finallyIndex)
    expect(verifyDmg.slice(cleanupIndex)).not.toContain('detach')
  })
})

describe('release size budgets', () => {
  test('measures deterministic build-output fixtures', () => {
    const directory = createBundleSizeFixture()
    try {
      const metrics = collectBundleSizeMetrics(directory)
      expect(metrics).toEqual({
        mainBytes: 101,
        preloadBytes: 102,
        initialRendererBytes: 207,
        largestRendererChunkBytes: 106,
        rendererJsCssBytes: 418,
      })
      expect(() => assertBundleSizeBudgets(metrics)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test.each(Object.keys(BUNDLE_SIZE_BUDGETS))('rejects a %s bundle regression above its exact budget', (name) => {
    const metrics = { ...BUNDLE_SIZE_BUDGETS, [name]: BUNDLE_SIZE_BUDGETS[name as keyof typeof BUNDLE_SIZE_BUDGETS] + 1 }
    expect(() => assertBundleSizeBudgets(metrics)).toThrow(/exceeds its size budget/)
    expect(() => assertBundleSizeBudgets(BUNDLE_SIZE_BUDGETS)).not.toThrow()
  })

  test('measures deterministic package fixtures and enforces every artifact budget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prime-work-package-size-'))
    const paths = {
      app: join(directory, 'Prime Work.app'),
      asar: join(directory, 'Prime Work.app/Contents/Resources/app.asar'),
      dmg: join(directory, 'Prime Work.dmg'),
      zip: join(directory, 'Prime Work.zip'),
    }
    writeSizedFile(paths.asar, 201)
    writeSizedFile(join(paths.app, 'Contents/MacOS/Prime Work'), 202)
    writeSizedFile(paths.dmg, 203)
    writeSizedFile(paths.zip, 204)
    try {
      const metrics = collectPackageSizeMetrics(paths)
      expect(metrics).toEqual({ asarBytes: 201, appBytes: 403, dmgBytes: 203, zipBytes: 204 })
      expect(() => assertPackageSizeBudgets(metrics)).not.toThrow()
      for (const name of Object.keys(PACKAGE_SIZE_BUDGETS)) {
        expect(() =>
          assertPackageSizeBudgets({
            ...PACKAGE_SIZE_BUDGETS,
            [name]: PACKAGE_SIZE_BUDGETS[name as keyof typeof PACKAGE_SIZE_BUDGETS] + 1,
          }),
        ).toThrow(/exceeds its size budget/)
      }
      expect(() => assertPackageSizeBudgets(PACKAGE_SIZE_BUDGETS)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('non-registry dependency pins', () => {
  test('every non-registry dependency in the lockfile matches its recorded pin exactly', () => {
    const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8'))
    const pins = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8')).packages
    const nonRegistry = (Object.entries(lockfile.packages ?? {}) as Array<[string, { resolved?: string; integrity?: string }]>).filter(
      ([, entry]) => typeof entry.resolved === 'string' && entry.resolved.length > 0 && !entry.resolved.startsWith('https://registry.npmjs.org'),
    )

    // The lockfile sha512 hashes are the supply-chain integrity boundary for
    // the vendored Prime Agent tarballs. A regenerated lockfile silently
    // re-anchors them to whatever bytes are present; this pin file makes that
    // a deliberate, reviewed change. To upgrade Prime Agent on purpose:
    // verify the new tarballs, replace them in vendor/, update the lockfile,
    // then mirror the new resolved/integrity values here in the same commit.
    expect(nonRegistry.length).toBeGreaterThan(0)
    for (const [name, entry] of nonRegistry) {
      const pin = pins[name]
      expect(pin, `unpinned non-registry dependency: ${name}`).toBeDefined()
      expect(entry.resolved, `resolved location drifted for ${name}`).toBe(pin.resolved)
      expect(entry.integrity, `integrity drifted for ${name}`).toBe(pin.integrity)
      expect(entry.integrity, `weak integrity algorithm for ${name}`).toMatch(/^sha512-/)
    }
    for (const name of Object.keys(pins)) {
      expect(
        nonRegistry.some(([lockName]) => lockName === name),
        `stale pin for removed dependency: ${name}`,
      ).toBe(true)
    }
  })

  test('the vendored tarballs on disk hash to their pinned integrity', () => {
    const pins = JSON.parse(readFileSync('scripts/release/dependency-pins.json', 'utf8')).packages as Record<string, { resolved: string; integrity: string }>
    const vendored = [
      ...new Set(
        Object.values(pins)
          .filter((pin) => pin.resolved.startsWith('file:vendor/'))
          .map((pin) => ({ path: pin.resolved.slice('file:'.length), integrity: pin.integrity }))
          .map((entry) => JSON.stringify(entry)),
      ),
    ].map((entry) => JSON.parse(entry) as { path: string; integrity: string })

    expect(vendored.length).toBeGreaterThan(0)
    for (const { path, integrity } of vendored) {
      const digest = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
      expect(digest, `vendored tarball bytes drifted from pin: ${path}`).toBe(integrity)
    }
  })
})
