import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginService } from '../../electron/main/plugins'
import { validatePackageSource } from '../../electron/main/plugins/package-execution'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('validatePackageSource', () => {
  it.each([
    'npm:example-package',
    'npm:Legacy_Package',
    'npm:@scope/pkg',
    'npm:example-package@latest',
    'npm:example-package@next-1',
    'npm:@scope/pkg@1.2.3',
    'npm:@scope/pkg@1.2.3-beta.1+build.5',
    'npm:example-package@^1.2.3',
    'npm:example-package@~1.2.3',
    'npm:example-package@=1.2.3',
    'npm:example-package@<=1.2.3',
    'npm:example-package@>1.2.3',
    'npm:example-package@>= 1.2.3',
    'npm:example-package@1.2 - 2.3',
    'npm:example-package@>=1.2.3 <2 || >=3.0.0',
    'npm:example-package@1.x || 2.x',
    'npm:example-package@*',
  ])('accepts npm registry selector %s', (source) => {
    expect(validatePackageSource(source)).toBe(source)
  })

  it.each([
    'npm:-rf',
    'npm:--help',
    'npm:_package',
    'npm:@-scope/pkg',
    'npm:@_scope/pkg',
    'npm:@scope/-pkg',
    'npm:@scope/_pkg',
  ])('rejects npm components with an option-like or reserved prefix %s', (source) => {
    expect(() => validatePackageSource(source)).toThrow(/Invalid npm package source/)
  })

  it.each([
    'npm:.',
    'npm:..',
    'npm:.hidden',
    'npm:...',
    'npm:./pkg',
    'npm:../pkg',
    'npm:.hidden/pkg',
    'npm:.../pkg',
    'npm:@scope/.hidden',
    'npm:@.scope/pkg',
    'npm:pkg@.',
    'npm:pkg@..',
    'npm:pkg@.hidden',
    'npm:pkg@...',
    'npm:pkg@./other',
    'npm:pkg@../other',
    'npm:pkg@ .hidden',
  ])('rejects dot-relative npm selector %s', (source) => {
    expect(() => validatePackageSource(source)).toThrow(/Invalid npm package source/)
  })

  it.each([
    'npm:pkg@|',
    'npm:pkg@|||',
    'npm:pkg@>=',
    'npm:pkg@^',
    'npm:pkg@=>1.2.3',
    'npm:pkg@=<1.2.3',
    'npm:pkg@^^1.2.3',
    'npm:pkg@<>1.2.3',
    'npm:pkg@><1.2.3',
    'npm:pkg@>~1.2.3',
    'npm:pkg@^~1.2.3',
    'npm:pkg@latest beta',
    'npm:pkg@1.2.3 latest',
    'npm:pkg@>=1 <2 trailing',
  ])('rejects malformed npm selector %s', (source) => {
    expect(() => validatePackageSource(source)).toThrow(/Invalid npm package source/)
  })

  it.each([
    'npm:pkg@http://',
    'npm:pkg@HTTP://example.test/pkg.tgz',
    'npm:pkg@https://example.test/pkg.tgz',
    'npm:pkg@git://',
    'npm:pkg@GiT://example.test/owner/repo.git',
    'npm:pkg@git+http://',
    'npm:pkg@GIT+HTTP://example.test/owner/repo.git',
    'npm:pkg@file:../pkg',
    'npm:pkg@LiNk:../pkg',
    'npm:pkg@workspace:*',
    'npm:alias@npm:pkg@^1.0.0',
  ])('rejects nested non-registry npm target %s', (source) => {
    expect(() => validatePackageSource(source)).toThrow(/Invalid npm package source/)
  })

  it('accepts well-formed secure git and HTTPS sources', () => {
    expect(validatePackageSource('git:github.com/owner/repo')).toBe('git:github.com/owner/repo')
    expect(validatePackageSource('git:git@github.com:owner/repo')).toBe('git:git@github.com:owner/repo')
    expect(validatePackageSource('git:ssh://git@github.com/owner/repo.git')).toBe('git:ssh://git@github.com/owner/repo.git')
    expect(validatePackageSource('git:https://github.com/owner/repo.git')).toBe('git:https://github.com/owner/repo.git')
    expect(validatePackageSource('ssh://git@github.com/owner/repo.git')).toBe('ssh://git@github.com/owner/repo.git')
    expect(validatePackageSource('https://example.test/pkg.tgz')).toBe('https://example.test/pkg.tgz')
    expect(validatePackageSource('formatter@marketplace', { allowOmpMarketplaceTarget: true })).toBe('formatter@marketplace')
  })

  it('rejects plaintext remote package transports in raw and nested git forms', () => {
    for (const source of [
      'http://example.test/pkg.tgz',
      'http://127.0.0.1.example.test/pkg.tgz',
      'git:http://example.test/owner/repo.git',
      'git:http://localhost.example.test/owner/repo.git',
      'git://example.test/owner/repo.git',
      'git:git://example.test/owner/repo.git',
      'git://127.0.0.1/owner/repo.git',
      'git:git://localhost/owner/repo.git',
    ]) expect(() => validatePackageSource(source), source).toThrow(/HTTPS or SSH/)
  })

  it('allows plain HTTP only for loopback package sources', () => {
    for (const source of [
      'http://localhost:4173/pkg.tgz',
      'http://packages.localhost:4173/pkg.tgz',
      'http://127.0.0.1:4173/pkg.tgz',
      'http://[::1]:4173/pkg.tgz',
      'git:http://localhost:4173/owner/repo.git',
    ]) expect(validatePackageSource(source), source).toBe(source)
  })

  it('rejects argv injection via a leading dash or embedded newlines', () => {
    expect(() => validatePackageSource('--registry=https://evil.test')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('-rf')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg\n--evil')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg\r--evil')).toThrow(/Invalid package source/)
    expect(() => validatePackageSource('npm:pkg x')).toThrow(/Invalid package source/)
  })

  it('rejects credentialed URLs and malformed specs', () => {
    expect(() => validatePackageSource('https://user:pass@evil.test/pkg.tgz')).toThrow(/credentials/)
    expect(() => validatePackageSource('git:https://user:pass@evil.test/repo')).toThrow(/credentials/)
    expect(() => validatePackageSource('http://user:pass@localhost/pkg.tgz')).toThrow(/credentials/)
    expect(() => validatePackageSource('git:http://user:pass@localhost/repo')).toThrow(/credentials/)
    expect(() => validatePackageSource('npm:UPPER CASE')).toThrow(/Invalid npm package source/)
    expect(() => validatePackageSource('npm:../escape')).toThrow(/Invalid npm package source/)
    expect(() => validatePackageSource('git:;rm -rf /')).toThrow(/Invalid git package source/)
    expect(() => validatePackageSource('relative/path')).toThrow(/must be npm:/)
    expect(() => validatePackageSource('')).toThrow(/too short/)
  })

  it('resolves existing absolute paths and rejects missing ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prime-work-package-'))
    dirs.push(dir)
    expect(validatePackageSource(dir)).toBe(realpathSync(dir))
    expect(() => validatePackageSource(join(dir, 'missing'))).toThrow(/does not exist/)
  })
})

describe('PluginService package source validation', () => {
  it.each(['prime', 'pi', 'omp'] as const)('does not launch the %s executable for rejected npm sources', async (harness) => {
    const root = mkdtempSync(join(tmpdir(), 'prime-work-package-service-'))
    dirs.push(root)
    const agentDir = join(root, 'agent')
    const executable = join(root, `${harness}.cjs`)
    const launched = join(root, 'launched')
    mkdirSync(agentDir)
    writeFileSync(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(launched)}, '')\n`)
    chmodSync(executable, 0o755)
    const service = new PluginService(executable, async (path) => path, { agentDir, harness })

    for (const source of ['npm:pkg@HtTp://example.test/pkg.tgz', 'npm:-rf', 'npm:--help']) {
      await expect(service.install(source), source).rejects.toThrow(/Invalid npm package source/)
      expect(existsSync(launched), source).toBe(false)
    }
  })
})
