import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validatePackageSource } from '../../electron/main/plugins/package-execution'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('validatePackageSource', () => {
  it('accepts well-formed npm, secure git, and HTTPS sources', () => {
    expect(validatePackageSource('npm:example-package')).toBe('npm:example-package')
    expect(validatePackageSource('npm:@scope/pkg@1.2.3')).toBe('npm:@scope/pkg@1.2.3')
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
