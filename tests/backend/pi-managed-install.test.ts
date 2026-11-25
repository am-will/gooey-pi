import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HARNESSES } from '../../electron/main/harness'
import { HarnessDiscoveryService, probeHarnessExecutable, spawnFailure } from '../../electron/main/harness-discovery'
import {
  ExecutableValidationError,
  isDriveOrUncWin32Path,
  isExecutableValidationError,
  readBoundedRegularFileSync,
  resolvePiManagedInstall,
  type ManagedStatEntry,
  type PiManagedInstallFs,
} from '../../electron/main/pi-managed-install'
import {
  findHarnessExecutable,
  harnessExecutableCandidates,
  prepareExecutableSpawn,
  runProcess,
  safeChildEnvironment,
} from '../../electron/main/process-utils'

const tempDirs: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-pi-managed-'))
  tempDirs.push(dir)
  return dir
}

interface VirtualNode {
  kind: 'file' | 'dir' | 'symlink'
  content?: string
  truncated?: boolean
  readThrows?: boolean
  realpath?: string
}

function createVirtualWin32Fs(initialEntries: Record<string, VirtualNode> = {}) {
  const entries = new Map<string, VirtualNode>()
  const canonicalDisplay = (path: string): string => {
    const stripped = path.startsWith('\\\\?\\UNC\\')
      ? `\\\\${path.slice(8)}`
      : /^\\\\\?\\[A-Za-z]:[\\/]/.test(path)
        ? path.slice(4)
        : path
    return win32.normalize(stripped)
  }
  const keyOf = (path: string): string => canonicalDisplay(path).toLowerCase()
  const canonicalByKey = new Map<string, string>()

  const setNode = (path: string, node: VirtualNode): void => {
    const key = keyOf(path)
    entries.set(key, node)
    canonicalByKey.set(key, node.realpath ?? canonicalDisplay(path))
  }

  const ensureDirChain = (dirPath: string): void => {
    const normalized = canonicalDisplay(dirPath)
    const parsed = win32.parse(normalized)
    const rest = normalized.slice(parsed.root.length).split('\\').filter(Boolean)
    let current = parsed.root.replace(/\\$/, '')
    if (current && !entries.has(keyOf(parsed.root))) {
      setNode(parsed.root, { kind: 'dir' })
    }
    for (const part of rest) {
      current = current ? `${current}\\${part}` : part
      if (!entries.has(keyOf(current))) setNode(current, { kind: 'dir' })
    }
  }

  const addFile = (path: string, content: string, extra: Partial<VirtualNode> = {}): void => {
    ensureDirChain(win32.dirname(path))
    setNode(path, { kind: 'file', content, ...extra })
  }

  const addDir = (path: string, extra: Partial<VirtualNode> = {}): void => {
    ensureDirChain(win32.dirname(path))
    setNode(path, { kind: 'dir', ...extra })
  }

  for (const [path, node] of Object.entries(initialEntries)) {
    if (node.kind === 'dir') addDir(path, node)
    else {
      ensureDirChain(win32.dirname(path))
      setNode(path, node)
    }
  }

  const fs: PiManagedInstallFs = {
    lstatSync(path: string): ManagedStatEntry {
      const node = entries.get(keyOf(path))
      if (!node) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return {
        isFile: () => node.kind === 'file',
        isDirectory: () => node.kind === 'dir',
        isSymbolicLink: () => node.kind === 'symlink',
        size: Buffer.byteLength(node.content ?? '', 'utf8'),
      }
    },
    realpathSync(path: string): string {
      const key = keyOf(path)
      if (!entries.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return canonicalByKey.get(key) ?? canonicalDisplay(path)
    },
    readBoundedFileSync(path: string, maxBytes: number): { content: string; truncated: boolean } {
      const node = entries.get(keyOf(path))
      if (node?.kind !== 'file' || node.readThrows) throw new Error('EIO')
      const raw = Buffer.from(node.content ?? '', 'utf8')
      const truncated = node.truncated === true || raw.length > maxBytes
      return {
        content: raw.subarray(0, Math.min(raw.length, maxBytes)).toString('utf8'),
        truncated,
      }
    },
  }

  return { fs, setNode, addFile, addDir }
}

function buildVirtualManagedFixture(options: {
  agentRoot?: string
  version?: string
  manifest?: unknown
  rawManifest?: string
  rawVersion?: string
  includePackageJson?: boolean
  packageManifest?: unknown
  rawPackageManifest?: string
} = {}) {
  const agentDir = options.agentRoot ?? 'C:\\Profiles\\Ada\\.pi\\agent'
  const shimPath = win32.join(agentDir, 'bin', 'pi.cmd')
  const installRoot = win32.join(agentDir, 'install')
  const version = options.version ?? '1.5.0'
  const releaseDir = win32.join(installRoot, 'releases', version)
  const packageRoot = win32.join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const bundlePath = win32.join(packageRoot, 'dist', 'bundle', 'cli.js')
  const vfs = createVirtualWin32Fs()

  vfs.addFile(shimPath, '@ECHO off\r\n')
  vfs.addFile(
    win32.join(installRoot, 'managed-install.json'),
    options.rawManifest ?? JSON.stringify(options.manifest ?? {
      kind: 'pi-managed-install',
      schemaVersion: 1,
      layout: 'releases-v1',
      entrypoint: {
        path: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      },
    }),
  )
  vfs.addFile(win32.join(installRoot, 'current-version'), options.rawVersion ?? `${version}\n`)
  if (options.includePackageJson !== false) {
    vfs.addFile(
      win32.join(packageRoot, 'package.json'),
      options.rawPackageManifest ?? JSON.stringify(options.packageManifest ?? {
        name: '@earendil-works/pi-coding-agent',
        version,
      }),
    )
  }
  vfs.addFile(bundlePath, 'process.stdout.write("1.5.0\\n")\n')

  return { vfs, agentDir, shimPath, installRoot, version, releaseDir, packageRoot, bundlePath }
}

interface RealManagedFixtureOptions {
  version?: string
  manifest?: unknown
  rawManifest?: string
  rawVersion?: string
  omitManifest?: boolean
  omitVersion?: boolean
  omitBundle?: boolean
  packageManifest?: Record<string, unknown> | null
  bundleBody?: string
}

function createRealManagedPiFixture(options: RealManagedFixtureOptions = {}) {
  const root = makeTempDir()
  const home = join(root, 'home')
  const agentDir = join(home, '.pi', 'agent')
  const binDir = join(agentDir, 'bin')
  const installRoot = join(agentDir, 'install')
  const version = options.version ?? '1.5.0'
  const releaseDir = join(installRoot, 'releases', version)
  const packageRoot = join(releaseDir, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const bundlePath = join(packageRoot, 'dist', 'bundle', 'cli.js')
  const shimPath = join(binDir, 'pi.cmd')
  const cmdExecutedMarker = join(root, 'cmd-was-executed')
  const envObservationPath = join(root, 'observed-env.json')

  mkdirSync(binDir, { recursive: true })
  mkdirSync(installRoot, { recursive: true })

  writeFileSync(
    shimPath,
    `@ECHO off\r\necho unexpected > "${cmdExecutedMarker}"\r\nexit /b 99\r\n`,
    'utf8',
  )

  if (!options.omitManifest) {
    const manifestContent = options.rawManifest ?? JSON.stringify(options.manifest ?? {
      kind: 'pi-managed-install',
      schemaVersion: 1,
      layout: 'releases-v1',
      entrypoint: {
        path: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      },
    })
    writeFileSync(join(installRoot, 'managed-install.json'), manifestContent, 'utf8')
  }

  if (!options.omitVersion) {
    writeFileSync(join(installRoot, 'current-version'), options.rawVersion ?? `${version}\n`, 'utf8')
  }

  if (!options.omitBundle) {
    mkdirSync(dirname(bundlePath), { recursive: true })
    if (options.packageManifest !== null) {
      writeFileSync(
        join(packageRoot, 'package.json'),
        JSON.stringify({
          name: '@earendil-works/pi-coding-agent',
          version,
          ...options.packageManifest,
        }),
        'utf8',
      )
    }
    writeFileSync(
      bundlePath,
      options.bundleBody ?? [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(envObservationPath)}, JSON.stringify({`,
        '  managedRoot: process.env.PI_MANAGED_INSTALL_ROOT ?? null,',
        '  nodeOptions: process.env.NODE_OPTIONS ?? null,',
        '  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,',
        '  argv: process.argv.slice(2),',
        '}));',
        `process.stdout.write(${JSON.stringify(`${version}\n`)});`,
      ].join('\n'),
      'utf8',
    )
  }

  return {
    root,
    home,
    agentDir,
    binDir,
    installRoot,
    releaseDir,
    packageRoot,
    bundlePath,
    shimPath,
    cmdExecutedMarker,
    envObservationPath,
  }
}

describe('Windows Pi managed-install candidate discovery', () => {
  it('accepts drive-absolute and UNC Windows home paths unless E2E isolation is active', () => {
    const driveHome = 'C:\\Profiles\\Ada'
    const driveCandidates = harnessExecutableCandidates(HARNESSES.pi, { Path: 'C:\\Windows' }, 'win32', undefined, driveHome)
    expect(driveCandidates).toContain('C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd')
    expect(driveCandidates).toContain('C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.exe')

    const forwardDriveCandidates = harnessExecutableCandidates(HARNESSES.pi, { Path: 'C:\\Windows' }, 'win32', undefined, 'D:/Profiles/Ada')
    expect(forwardDriveCandidates).toContain('D:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd')

    const uncHome = '\\\\fileserver\\profiles\\Ada'
    expect(HARNESSES.pi.candidateDirs('win32', uncHome, {})).toEqual(['\\\\fileserver\\profiles\\Ada\\.pi\\agent\\bin'])
    expect(HARNESSES.pi.candidateDirs('win32', '//fileserver/profiles/Ada', {})).toEqual([
      '\\\\fileserver\\profiles\\Ada\\.pi\\agent\\bin',
    ])
    const uncCandidates = harnessExecutableCandidates(HARNESSES.pi, { Path: 'C:\\Windows' }, 'win32', undefined, uncHome)
    expect(uncCandidates).toContain('\\\\fileserver\\profiles\\Ada\\.pi\\agent\\bin\\pi.cmd')
    expect(uncCandidates).toContain('\\\\fileserver\\profiles\\Ada\\.pi\\agent\\bin\\pi.exe')

    const isolated = harnessExecutableCandidates(
      HARNESSES.pi,
      { PRIME_WORK_E2E_HIDE_WINDOWS: '1', Path: 'C:\\Windows' },
      'win32',
      undefined,
      driveHome,
    )
    expect(isolated).toEqual(['C:\\Windows\\pi.exe', 'C:\\Windows\\pi.cmd'])
  })

  it.each([
    ['drive-rooted backslash path', '\\Profiles\\Ada'],
    ['drive-rooted forward-slash path', '/Profiles/Ada'],
    ['bare backslash root', '\\'],
    ['bare forward-slash root', '/'],
    ['drive-relative without separator', 'C:Profiles\\Ada'],
    ['bare drive specifier', 'C:'],
    ['incomplete UNC without share', '\\\\fileserver\\'],
    ['device namespace path', '\\\\.\\NUL'],
    ['relative directory', 'relative\\home'],
    ['empty string', ''],
  ])('rejects drive-dependent or relative Windows home input (%s)', (_label, invalidHome) => {
    expect(isDriveOrUncWin32Path(invalidHome)).toBe(false)
    expect(HARNESSES.pi.candidateDirs('win32', invalidHome, {})).toEqual([])
    const candidates = harnessExecutableCandidates(HARNESSES.pi, { Path: 'C:\\Windows' }, 'win32', undefined, invalidHome)
    expect(candidates.some((candidate) => candidate.toLowerCase().includes('.pi\\agent\\bin'))).toBe(false)
  })

  it('preserves POSIX Pi and unrelated harness candidate discovery', () => {
    expect(HARNESSES.pi.candidateDirs('linux', '/profiles/ada', { XDG_DATA_HOME: '/data' })).toEqual(['/data/pi-node/current/bin'])
    expect(HARNESSES.pi.candidateDirs('linux', '/profiles/ada', {})).toEqual(['/profiles/ada/.local/share/pi-node/current/bin'])
    expect(HARNESSES.pi.candidateDirs('darwin', '/profiles/ada', {})).toEqual(['/profiles/ada/.local/share/pi-node/current/bin'])
    expect(HARNESSES.omp.candidateDirs('win32', 'C:\\Profiles\\Ada', { LOCALAPPDATA: 'C:\\Profiles\\Ada\\AppData\\Local' })).toEqual([
      'C:\\Profiles\\Ada\\AppData\\Local\\omp',
    ])
  })
})

describe('resolvePiManagedInstall and prepareExecutableSpawn validation (cross-platform win32)', () => {
  it.each([
    ['forward-slash bundle entrypoint', { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js' } }],
    ['backslash bundle entrypoint', { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js' } }],
    ['package-scoped bundle entrypoint', { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { package: '@earendil-works/pi-coding-agent', path: 'dist/bundle/cli.js' } }],
    ['shim-path entrypoint', { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd' } }],
    ['omitted entrypoint with extra metadata', { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', channel: 'stable' }],
  ])('accepts valid releases-v1 metadata (%s) and resolves the official bundle', (_label, manifest) => {
    const fixture = buildVirtualManagedFixture({ manifest })
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe'

    const invocation = prepareExecutableSpawn(
      fixture.shimPath,
      ['--mode', 'rpc'],
      safeChildEnvironment({
        Path: '"C:\\Program Files\\nodejs";\\drive-relative;/slash-relative',
        USERPROFILE: 'C:\\Profiles\\Ada',
        NODE_OPTIONS: '--inspect',
        PI_MANAGED_INSTALL_ROOT: 'C:\\stale\\root',
        pi_managed_install_root: 'C:\\stale\\mixed-case',
      }),
      {
        platform: 'win32',
        home: 'C:\\Profiles\\Ada',
        managedInstallFs: fixture.vfs.fs,
        canAccess: (candidate) =>
          candidate.toLowerCase() === nodePath.toLowerCase()
          || candidate.toLowerCase() === fixture.installRoot.toLowerCase(),
      },
    )

    expect(invocation.file).toBe(nodePath)
    expect(invocation.args).toEqual([fixture.bundlePath, '--mode', 'rpc'])
    expect(invocation.env.PI_MANAGED_INSTALL_ROOT).toBe(fixture.installRoot)
    expect(Object.keys(invocation.env).filter((key) => key.toLowerCase() === 'pi_managed_install_root')).toEqual([
      'PI_MANAGED_INSTALL_ROOT',
    ])
    expect(invocation.env.NODE_OPTIONS).toBeUndefined()
    expect(invocation.env.Path?.split(';')[0]).toBe('C:\\Profiles\\Ada\\.pi\\agent\\bin')
  })

  it.each([
    '1.5.0',
    '1.5.0-rc.1',
    '1.5.0-alpha-1.2',
    '1.5.0+20261125.1',
    '1.5.0-rc.1+20261125.7',
  ])('accepts valid SemVer release, prerelease, and build version %s with BOM and UNC/extended-length paths', (version) => {
    const uncFixture = buildVirtualManagedFixture({
      agentRoot: '\\\\fileserver\\profiles\\Ada\\.pi\\agent',
      version,
      rawManifest: `\uFEFF${JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })}`,
      rawVersion: `\uFEFF${version}\r\n`,
      includePackageJson: false,
    })

    const resolved = resolvePiManagedInstall('\\\\?\\UNC\\fileserver\\profiles\\Ada\\.pi\\agent\\bin\\pi.cmd', {
      fs: uncFixture.vfs.fs,
    })
    expect(resolved).toEqual({
      entrypoint: uncFixture.bundlePath,
      installRoot: uncFixture.installRoot,
      version,
    })

    const driveFixture = buildVirtualManagedFixture({
      version,
      rawPackageManifest: `\uFEFF${JSON.stringify({ name: '@earendil-works/pi-coding-agent', version })}`,
    })
    expect(resolvePiManagedInstall(`\\\\?\\${driveFixture.shimPath}`, { fs: driveFixture.vfs.fs })).toEqual({
      entrypoint: driveFixture.bundlePath,
      installRoot: driveFixture.installRoot,
      version,
    })
  })

  it('clears inherited PI_MANAGED_INSTALL_ROOT for ordinary official Pi npm-shim launches while leaving Prime untouched', () => {
    const npmShim = 'C:\\Profiles\\Ada\\AppData\\Roaming\\npm\\pi.cmd'
    const npmEntrypoint = 'C:\\Profiles\\Ada\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js'
    const primeShim = 'C:\\Profiles\\Ada\\AppData\\Roaming\\npm\\prime-agent.cmd'
    const primeEntrypoint = 'C:\\Profiles\\Ada\\AppData\\Roaming\\npm\\node_modules\\prime-agent\\dist\\bundle\\cli.js'
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe'

    const piInvocation = prepareExecutableSpawn(
      npmShim,
      ['--version'],
      {
        Path: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        USERPROFILE: 'C:\\Profiles\\Ada',
        PI_MANAGED_INSTALL_ROOT: 'C:\\Profiles\\Ada\\.pi\\agent\\install',
        pi_managed_install_root: 'C:\\Profiles\\Ada\\.pi\\agent\\install',
      },
      {
        platform: 'win32',
        home: 'C:\\Profiles\\Ada',
        canAccess: (candidate) =>
          candidate.toLowerCase() === npmEntrypoint.toLowerCase()
          || candidate.toLowerCase() === nodePath.toLowerCase(),
      },
    )
    expect(piInvocation.file).toBe(nodePath)
    expect(piInvocation.args).toEqual([npmEntrypoint, '--version'])
    expect(piInvocation.env.PI_MANAGED_INSTALL_ROOT).toBeUndefined()
    expect(Object.keys(piInvocation.env).some((key) => key.toLowerCase() === 'pi_managed_install_root')).toBe(false)

    // Also prefers sibling npm entrypoint over managed-install fallback when both exist.
    const dualFixture = buildVirtualManagedFixture()
    const siblingNpmEntry = win32.join(win32.dirname(dualFixture.shimPath), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    const dualInvocation = prepareExecutableSpawn(
      dualFixture.shimPath,
      ['--version'],
      {
        Path: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        USERPROFILE: 'C:\\Profiles\\Ada',
        PI_MANAGED_INSTALL_ROOT: dualFixture.installRoot,
      },
      {
        platform: 'win32',
        home: 'C:\\Profiles\\Ada',
        managedInstallFs: dualFixture.vfs.fs,
        canAccess: (candidate) =>
          candidate.toLowerCase() === siblingNpmEntry.toLowerCase()
          || candidate.toLowerCase() === nodePath.toLowerCase(),
      },
    )
    expect(dualInvocation.args).toEqual([siblingNpmEntry, '--version'])
    expect(dualInvocation.env.PI_MANAGED_INSTALL_ROOT).toBeUndefined()

    const primeInvocation = prepareExecutableSpawn(
      primeShim,
      ['--version'],
      {
        Path: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        USERPROFILE: 'C:\\Profiles\\Ada',
        CUSTOM_VAR: 'kept',
      },
      {
        platform: 'win32',
        home: 'C:\\Profiles\\Ada',
        canAccess: (candidate) =>
          candidate.toLowerCase() === primeEntrypoint.toLowerCase()
          || candidate.toLowerCase() === nodePath.toLowerCase(),
      },
    )
    expect(primeInvocation.args).toEqual([primeEntrypoint, '--version'])
    expect(primeInvocation.env.CUSTOM_VAR).toBe('kept')
  })

  it.each([
    ['empty path', ''],
    ['relative path', 'bin\\pi.cmd'],
    ['drive-relative backslash', '\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd'],
    ['drive-relative slash', '/Profiles/Ada/.pi/agent/bin/pi.cmd'],
    ['NUL-bearing path', 'C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd\0extra'],
    ['overlong path', `C:\\${'a'.repeat(4100)}\\bin\\pi.cmd`],
    ['non-pi shim basename', 'C:\\Profiles\\Ada\\.pi\\agent\\bin\\prime-agent.cmd'],
    ['non-bin parent directory', 'C:\\Profiles\\Ada\\AppData\\Roaming\\npm\\pi.cmd'],
    ['drive root parent', 'C:\\pi.cmd'],
  ])('returns null for non-managed path shape: %s', (_label, candidate) => {
    const fixture = buildVirtualManagedFixture()
    expect(resolvePiManagedInstall(candidate, { fs: fixture.vfs.fs })).toBeNull()
  })

  it('returns null when <agentDir>\\install is absent so standard npm-shim mismatch is preserved', () => {
    const vfs = createVirtualWin32Fs({
      'C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd': { kind: 'file', content: '@ECHO off\r\n' },
    })
    expect(resolvePiManagedInstall('C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd', { fs: vfs.fs })).toBeNull()
    expect(() =>
      prepareExecutableSpawn(
        'C:\\Profiles\\Ada\\.pi\\agent\\bin\\pi.cmd',
        ['--version'],
        {},
        { platform: 'win32', home: 'C:\\Profiles\\Ada', managedInstallFs: vfs.fs, canAccess: () => false },
      ),
    ).toThrow(/official Pi installation/)
  })

  it.each([
    ['malformed JSON content', { rawManifest: '{"broken": "unterminated-manifest-content' }],
    ['non-object JSON', { rawManifest: '["pi-managed-install"]' }],
    ['wrong kind', { manifest: { kind: 'other', schemaVersion: 1, layout: 'releases-v1' } }],
    ['wrong schemaVersion', { manifest: { kind: 'pi-managed-install', schemaVersion: 2, layout: 'releases-v1' } }],
    ['wrong layout', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v2' } }],
    ['string entrypoint', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: 'cli.js' } }],
    ['wrong entrypoint package', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { package: '@other/pi', path: 'dist/bundle/cli.js' } } }],
    ['arbitrary relative script in entrypoint.path', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'node_modules/other/cli.js' } } }],
    ['traversal in entrypoint.path', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: '../../other.js' } } }],
    ['arbitrary absolute script in entrypoint.path', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'C:\\other\\cli.js' } } }],
    ['unbundled dist/cli.js in entrypoint.path', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js' } } }],
    ['NUL byte in entrypoint.path', { manifest: { kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1', entrypoint: { path: 'dist/bundle/cli.js\0' } } }],
  ])('fails closed with PI_MANAGED_METADATA_INVALID on %s without echoing raw file contents', (_label, overrides) => {
    const fixture = buildVirtualManagedFixture(overrides)
    let caught: unknown
    try {
      resolvePiManagedInstall(fixture.shimPath, { fs: fixture.vfs.fs })
    } catch (error) {
      caught = error
    }
    expect(isExecutableValidationError(caught)).toBe(true)
    expect((caught as ExecutableValidationError).code).toBe('PI_MANAGED_METADATA_INVALID')
    expect((caught as Error).message).not.toContain('unterminated-manifest-content')
  })

  it('rejects oversized or symlinked managed-install.json and install root escapes', () => {
    const truncated = buildVirtualManagedFixture()
    truncated.vfs.addFile(win32.join(truncated.installRoot, 'managed-install.json'), '{}', { truncated: true })
    expect(() => resolvePiManagedInstall(truncated.shimPath, { fs: truncated.vfs.fs })).toThrow(/exceeds the size limit/)

    const symlinkMarker = buildVirtualManagedFixture()
    symlinkMarker.vfs.setNode(win32.join(symlinkMarker.installRoot, 'managed-install.json'), { kind: 'symlink', content: '{}' })
    expect(() => resolvePiManagedInstall(symlinkMarker.shimPath, { fs: symlinkMarker.vfs.fs })).toThrow(/must be a regular file/)

    const escapedInstall = buildVirtualManagedFixture()
    escapedInstall.vfs.addDir(escapedInstall.installRoot, { realpath: 'C:\\Outside\\install' })
    expect(() => resolvePiManagedInstall(escapedInstall.shimPath, { fs: escapedInstall.vfs.fs })).toThrow(/escapes its containment root/)

    const symlinkShim = buildVirtualManagedFixture()
    symlinkShim.vfs.setNode(symlinkShim.shimPath, { kind: 'symlink', content: '@ECHO off' })
    expect(() => resolvePiManagedInstall(symlinkShim.shimPath, { fs: symlinkShim.vfs.fs })).toThrow(/must be a regular file/)
  })

  it.each([
    ['empty version', '   \r\n'],
    ['v-prefixed version', 'v1.5.0'],
    ['trailing dot after patch', '1.5.0.'],
    ['trailing dot in prerelease', '1.5.0-rc.'],
    ['trailing dot in build', '1.5.0+build.'],
    ['trailing dot after prerelease+build', '1.5.0-rc.1+build.'],
    ['empty prerelease', '1.5.0-'],
    ['empty build', '1.5.0+'],
    ['empty prerelease before build', '1.5.0-+build'],
    ['leading dot in prerelease', '1.5.0-.rc'],
    ['leading dot in build', '1.5.0+.build'],
    ['empty segment in prerelease', '1.5.0-a..b'],
    ['empty segment in build', '1.5.0+a..b'],
    ['path traversal', '..\\other'],
    ['slash separator', '1.5.0/cli'],
    ['overlong version', `1.5.0-${'a'.repeat(130)}`],
  ])('fails closed with PI_MANAGED_VERSION_INVALID on %s without echoing untrusted text', (_label, rawVersion) => {
    const fixture = buildVirtualManagedFixture({ rawVersion })
    let caught: unknown
    try {
      resolvePiManagedInstall(fixture.shimPath, { fs: fixture.vfs.fs })
    } catch (error) {
      caught = error
    }
    expect(isExecutableValidationError(caught)).toBe(true)
    expect((caught as ExecutableValidationError).code).toBe('PI_MANAGED_VERSION_INVALID')
    expect((caught as Error).message).toBe('Pi managed install current-version is invalid')
  })

  it('rejects missing, truncated, or symlinked current-version files', () => {
    const symlinkVersion = buildVirtualManagedFixture()
    symlinkVersion.vfs.setNode(win32.join(symlinkVersion.installRoot, 'current-version'), { kind: 'symlink', content: '1.5.0' })
    expect(() => resolvePiManagedInstall(symlinkVersion.shimPath, { fs: symlinkVersion.vfs.fs })).toThrow(/must be a regular file/)

    const truncatedVersion = buildVirtualManagedFixture()
    truncatedVersion.vfs.addFile(win32.join(truncatedVersion.installRoot, 'current-version'), '1.5.0', { truncated: true })
    expect(() => resolvePiManagedInstall(truncatedVersion.shimPath, { fs: truncatedVersion.vfs.fs })).toThrow(/exceeds the size limit/)
  })

  it('fails closed with PI_MANAGED_BUNDLE_MISSING on missing/symlinked release dirs, mismatched package.json, or escaped bundles', () => {
    const missingRelease = buildVirtualManagedFixture({ rawVersion: '9.9.9\n' })
    expect(() => resolvePiManagedInstall(missingRelease.shimPath, { fs: missingRelease.vfs.fs })).toThrow(/release 9\.9\.9 is missing/)

    const escapedRelease = buildVirtualManagedFixture()
    escapedRelease.vfs.addDir(escapedRelease.releaseDir, { realpath: 'C:\\Outside\\1.5.0' })
    expect(() => resolvePiManagedInstall(escapedRelease.shimPath, { fs: escapedRelease.vfs.fs })).toThrow(/escapes its containment root/)

    const symlinkSegment = buildVirtualManagedFixture()
    symlinkSegment.vfs.setNode(win32.join(symlinkSegment.releaseDir, 'node_modules', '@earendil-works'), { kind: 'symlink' })
    expect(() => resolvePiManagedInstall(symlinkSegment.shimPath, { fs: symlinkSegment.vfs.fs })).toThrow(/must be a real directory/)

    const wrongPkgName = buildVirtualManagedFixture({ packageManifest: { name: 'not-pi', version: '1.5.0' } })
    expect(() => resolvePiManagedInstall(wrongPkgName.shimPath, { fs: wrongPkgName.vfs.fs })).toThrow(/does not match the official Pi package/)

    const wrongPkgVersion = buildVirtualManagedFixture({ packageManifest: { name: '@earendil-works/pi-coding-agent', version: '1.4.0' } })
    expect(() => resolvePiManagedInstall(wrongPkgVersion.shimPath, { fs: wrongPkgVersion.vfs.fs })).toThrow(/does not match the official Pi package/)

    const symlinkBundle = buildVirtualManagedFixture()
    symlinkBundle.vfs.setNode(symlinkBundle.bundlePath, { kind: 'symlink', content: '' })
    expect(() => resolvePiManagedInstall(symlinkBundle.shimPath, { fs: symlinkBundle.vfs.fs })).toThrow(/official bundle must be a regular file/)

    const escapedBundle = buildVirtualManagedFixture()
    escapedBundle.vfs.addFile(escapedBundle.bundlePath, 'code', { realpath: win32.join(escapedBundle.releaseDir, 'other.js') })
    expect(() => resolvePiManagedInstall(escapedBundle.shimPath, { fs: escapedBundle.vfs.fs })).toThrow(/escapes the release directory/)
  })

  it('reports NODE_MISSING when Node.js cannot be found for a valid Pi managed installation, ignoring relative and drive-relative roots', () => {
    const fixture = buildVirtualManagedFixture()
    const inspected: string[] = []
    let caught: unknown
    try {
      prepareExecutableSpawn(
        fixture.shimPath,
        ['--version'],
        {
          Path: 'relative;\\drive-relative;/slash-relative',
          ProgramFiles: 'relative-pf',
          LOCALAPPDATA: '\\drive-relative-local',
          USERPROFILE: 'C:\\Profiles\\Ada',
        },
        {
          platform: 'win32',
          home: 'C:\\Profiles\\Ada',
          managedInstallFs: fixture.vfs.fs,
          canAccess: (candidate, mode) => {
            inspected.push(candidate)
            if (mode === 0) return candidate.toLowerCase() === fixture.installRoot.toLowerCase()
            return !/^[A-Za-z]:\\/.test(candidate)
          },
        },
      )
    } catch (error) {
      caught = error
    }
    expect(isExecutableValidationError(caught)).toBe(true)
    expect((caught as ExecutableValidationError).code).toBe('NODE_MISSING')
    expect((caught as Error).message).toBe('Node.js was not found for the Pi managed installation')
    expect(inspected.every((candidate) => /^[A-Za-z]:\\/.test(candidate))).toBe(true)
  })
})

describe('safe exception detail handling and bounded file reads', () => {
  it('surfaces bounded ExecutableValidationError messages while keeping arbitrary exceptions opaque', () => {
    const validationErr = new ExecutableValidationError(
      'PI_MANAGED_METADATA_INVALID',
      `Pi managed install metadata is invalid\u0007\n${'x'.repeat(260)}`,
    )
    expect(Reflect.get(validationErr, Symbol.for('gooeypi.executableValidationError'))).toBe(true)
    expect(isExecutableValidationError(validationErr)).toBe(true)
    expect(isExecutableValidationError(new Error('unexpected internal failure detail C:\\Profiles\\Alice\\file'))).toBe(false)

    const boundaryDir = makeTempDir()
    const exactFile = join(boundaryDir, 'exact.txt')
    const overFile = join(boundaryDir, 'over.txt')
    writeFileSync(exactFile, '12345678', 'utf8')
    writeFileSync(overFile, '123456789', 'utf8')
    expect(readBoundedRegularFileSync(exactFile, 8)).toEqual({ content: '12345678', truncated: false })
    expect(readBoundedRegularFileSync(overFile, 8)).toEqual({ content: '12345678', truncated: true })
    expect(() => readBoundedRegularFileSync(boundaryDir, 8)).toThrow()

    const crossRealmError = {
      [Symbol.for('gooeypi.executableValidationError')]: true,
      code: 'NODE_MISSING',
      message: 'Node.js was not found for the Pi managed installation',
    }
    expect(isExecutableValidationError(crossRealmError)).toBe(true)
    expect(
      isExecutableValidationError({
        [Symbol.for('gooeypi.executableValidationError')]: true,
        code: 'UNKNOWN_CODE',
        message: 'unrecognized',
      }),
    ).toBe(false)

    const formattedValidation = spawnFailure(validationErr)
    expect(formattedValidation.kind).toBe('spawn')
    expect(formattedValidation.detail).toMatch(/^Pi managed install metadata is invalidx+$/)
    expect(formattedValidation.detail.length).toBeLessThanOrEqual(200)
    expect(spawnFailure(new ExecutableValidationError('NODE_MISSING', '\r\n\t'))).toEqual({
      kind: 'spawn',
      detail: 'spawn error NODE_MISSING',
    })

    const unexpected = spawnFailure(new Error('unexpected internal failure detail C:\\Profiles\\Alice\\file'))
    expect(unexpected).toEqual({ kind: 'spawn', detail: 'spawn error UNKNOWN' })

    expect(spawnFailure({ code: 'BAD CODE\nDETAIL', message: 'detail' })).toEqual({
      kind: 'spawn',
      detail: 'spawn error UNKNOWN',
    })
    expect(spawnFailure({ code: 'A'.repeat(80) })).toEqual({
      kind: 'spawn',
      detail: 'spawn error UNKNOWN',
    })
    expect(spawnFailure({ code: 'ENOENT', message: 'spawn C:\\Profiles\\Ada ENOENT' })).toEqual({
      kind: 'spawn',
      detail: 'path does not exist',
    })
    expect(spawnFailure({ code: 'EACCES' })).toEqual({ kind: 'spawn', detail: 'permission denied' })
    expect(spawnFailure({ code: 'EPERM' })).toEqual({ kind: 'spawn', detail: 'permission denied' })
    expect(spawnFailure({ code: 'EFTYPE' })).toEqual({ kind: 'spawn', detail: 'spawn error EFTYPE' })
  })
})

describe.skipIf(process.platform !== 'win32')('Windows native managed-install and npm-shim fixtures', () => {
  it('discovers, executes with shell=false + sanitized env, and follows current-version updates on refresh', async () => {
    const fixture = createRealManagedPiFixture({ version: '1.5.0' })
    const v2Bundle = join(
      fixture.installRoot,
      'releases',
      '1.6.0',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js',
    )
    mkdirSync(dirname(v2Bundle), { recursive: true })
    writeFileSync(
      join(dirname(dirname(dirname(v2Bundle))), 'package.json'),
      JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.6.0' }),
      'utf8',
    )
    writeFileSync(v2Bundle, 'process.stdout.write("1.6.0\\n")\n', 'utf8')

    const staleNpmDir = join(fixture.root, 'stale-npm')
    mkdirSync(staleNpmDir, { recursive: true })
    writeFileSync(join(staleNpmDir, 'pi.cmd'), '@ECHO off\r\nexit /b 1\r\n', 'utf8')

    const nodeDir = dirname(process.execPath)
    vi.stubEnv('Path', `${staleNpmDir};${fixture.binDir};${nodeDir}`)
    vi.stubEnv('PATH', `${staleNpmDir};${fixture.binDir};${nodeDir}`)
    vi.stubEnv('USERPROFILE', fixture.home)
    vi.stubEnv('NODE_OPTIONS', '--title=should-be-stripped')
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')

    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: '' }),
      {
        findExecutable: (descriptor, configured, accept, onFailure) =>
          descriptor.id === 'pi' ? findHarnessExecutable(descriptor, configured, accept, onFailure) : Promise.resolve(null),
        probeExecutable: probeHarnessExecutable,
      },
    )

    const initial = await discovery.refresh()
    expect(initial.pi).toEqual({ path: fixture.shimPath, version: '1.5.0' })
    expect(existsSync(fixture.cmdExecutedMarker)).toBe(false)

    const observed = JSON.parse(readFileSync(fixture.envObservationPath, 'utf8')) as {
      managedRoot: string | null
      nodeOptions: string | null
      electronRunAsNode: string | null
      argv: string[]
    }
    expect(observed).toEqual({
      managedRoot: fixture.installRoot,
      nodeOptions: null,
      electronRunAsNode: null,
      argv: ['--version'],
    })

    writeFileSync(join(fixture.installRoot, 'current-version'), '1.6.0\r\n', 'utf8')
    const refreshed = await discovery.refresh()
    expect(refreshed.pi).toEqual({ path: fixture.shimPath, version: '1.6.0' })

    const directRun = await runProcess(discovery.executable('pi')!, ['--version'])
    expect(directRun.code).toBe(0)
    expect(directRun.stdout.trim()).toBe('1.6.0')
  })

  it('clears inherited PI_MANAGED_INSTALL_ROOT when spawning a real Windows official Pi npm shim', async () => {
    const npmRoot = makeTempDir()
    const npmShim = join(npmRoot, 'pi.cmd')
    const npmEntry = join(npmRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
    const observedPath = join(npmRoot, 'npm-env.json')
    mkdirSync(dirname(npmEntry), { recursive: true })
    writeFileSync(npmShim, '@ECHO off\r\nexit /b 99\r\n', 'utf8')
    writeFileSync(
      npmEntry,
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ managedRoot: process.env.PI_MANAGED_INSTALL_ROOT ?? null }));`,
        'process.stdout.write("1.5.0\\n");',
      ].join('\n'),
      'utf8',
    )

    const nodeDir = dirname(process.execPath)
    vi.stubEnv('Path', `${npmRoot};${nodeDir}`)
    vi.stubEnv('PATH', `${npmRoot};${nodeDir}`)
    vi.stubEnv('PI_MANAGED_INSTALL_ROOT', join(npmRoot, 'inherited-managed-root'))

    const result = await runProcess(npmShim, ['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('1.5.0')
    expect(JSON.parse(readFileSync(observedPath, 'utf8'))).toEqual({ managedRoot: null })
  })

  it('accepts the managed-install pi.cmd in Pi executable override and rejects arbitrary .js/.ps1 scripts', async () => {
    const fixture = createRealManagedPiFixture({ version: '1.5.0' })
    const arbitraryScript = join(fixture.binDir, 'pi-launcher.js')
    const scriptMarker = join(fixture.root, 'arbitrary-js-executed')
    writeFileSync(arbitraryScript, `require("node:fs").writeFileSync(${JSON.stringify(scriptMarker)}, "ran");\n`, 'utf8')

    const nodeDir = dirname(process.execPath)
    vi.stubEnv('Path', nodeDir)
    vi.stubEnv('PATH', nodeDir)
    vi.stubEnv('USERPROFILE', fixture.home)

    const rejectedProbe = await probeHarnessExecutable(arbitraryScript)
    expect(rejectedProbe.runnable).toBe(false)
    expect(existsSync(scriptMarker)).toBe(false)

    let configuredPi = fixture.shimPath
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '', prime: '', pi: configuredPi }),
      {
        findExecutable: (descriptor, configured, accept, onFailure) =>
          descriptor.id === 'pi' ? findHarnessExecutable(descriptor, configured, accept, onFailure) : Promise.resolve(null),
        probeExecutable: probeHarnessExecutable,
      },
    )
    const statuses = await discovery.refresh()
    expect(statuses.pi).toEqual({ path: fixture.shimPath, version: '1.5.0' })

    configuredPi = arbitraryScript
    const withBadOverride = await discovery.refresh()
    expect(existsSync(scriptMarker)).toBe(false)
    expect(withBadOverride.pi.path !== arbitraryScript).toBe(true)
  })

  it('rejects NTFS directory junctions escaping the managed install root without executing outside code', async () => {
    const fixture = createRealManagedPiFixture({ version: '1.5.0', omitBundle: true })
    const outsideRelease = join(fixture.root, 'outside-release')
    const outsideBundle = join(outsideRelease, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')
    const outsideMarker = join(fixture.root, 'outside-bundle-ran')
    mkdirSync(dirname(outsideBundle), { recursive: true })
    writeFileSync(outsideBundle, `require("node:fs").writeFileSync(${JSON.stringify(outsideMarker)}, "ran");\n`, 'utf8')

    mkdirSync(join(fixture.installRoot, 'releases'), { recursive: true })
    symlinkSync(outsideRelease, join(fixture.installRoot, 'releases', '1.5.0'), 'junction')

    const nodeDir = dirname(process.execPath)
    vi.stubEnv('Path', `${fixture.binDir};${nodeDir}`)
    vi.stubEnv('PATH', `${fixture.binDir};${nodeDir}`)

    const probe = await probeHarnessExecutable(fixture.shimPath)
    expect(probe.runnable).toBe(false)
    expect(probe.failure?.detail).toContain('must be a real directory')
    expect(existsSync(outsideMarker)).toBe(false)
  })

  it('surfaces actionable bounded reasons instead of spawn error UNKNOWN for invalid shims and corrupt metadata', async () => {
    const corrupt = createRealManagedPiFixture({ rawManifest: '{"kind":"wrong"}' })
    const corruptProbe = await probeHarnessExecutable(corrupt.shimPath)
    expect(corruptProbe).toEqual({
      runnable: false,
      version: null,
      failure: {
        kind: 'spawn',
        detail: 'Pi managed install metadata is not a supported releases-v1 layout',
      },
    })

    const orphanDir = makeTempDir()
    const orphanShim = join(orphanDir, 'pi.cmd')
    writeFileSync(orphanShim, '@ECHO off\r\n', 'utf8')
    const orphanProbe = await probeHarnessExecutable(orphanShim)
    expect(orphanProbe).toEqual({
      runnable: false,
      version: null,
      failure: {
        kind: 'spawn',
        detail: 'The Pi npm command shim does not point to an official Pi installation',
      },
    })
  })
})
