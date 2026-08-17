import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isPathWithin,
  requireExistingPath,
  requireGitPath,
  requireId,
  requireSelfHostedVoiceUrl,
  requireString,
  requireWebUrl,
} from '../../electron/main/validation'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir }

describe('requireWebUrl', () => {
  it('accepts http and https and returns the normalized URL', () => {
    expect(requireWebUrl('https://example.com')).toBe('https://example.com/')
    expect(requireWebUrl('http://example.com/path?q=1')).toBe('http://example.com/path?q=1')
    expect(requireWebUrl('  https://example.com  ')).toBe('https://example.com/')
  })

  it('rejects every non-web scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/',
      'data:text/html,<script>alert(1)</script>',
      'chrome://settings',
      'prime-work://app/',
      'vbscript:msgbox(1)',
    ]) expect(() => requireWebUrl(url), url).toThrow(/scheme is not allowed/)
  })

  it('rejects embedded credentials in web URLs', () => {
    expect(() => requireWebUrl('https://user:secret@example.com/')).toThrow(/credentials/)
    expect(() => requireWebUrl('https://user@example.com/')).toThrow(/credentials/)
    expect(() => requireWebUrl('http://:secret@example.com/')).toThrow(/credentials/)
  })

  it('rejects mailto by default and allows it only when opted in', () => {
    expect(() => requireWebUrl('mailto:team@example.com')).toThrow(/scheme is not allowed/)
    expect(requireWebUrl('mailto:team@example.com', { mailto: true })).toBe('mailto:team@example.com')
  })

  it('rejects embedded credentials in mailto URLs too', () => {
    expect(requireWebUrl('mailto:team@example.com?subject=hi', { mailto: true })).toBe('mailto:team@example.com?subject=hi')
    expect(() => requireWebUrl('mailto://user:pass@example.com', { mailto: true })).toThrow(/credentials/)
  })

  it('rejects malformed, empty, and oversized inputs', () => {
    expect(() => requireWebUrl('not a url')).toThrow(/Invalid URL/)
    expect(() => requireWebUrl('')).toThrow(/too short/)
    expect(() => requireWebUrl(undefined)).toThrow(/must be a string/)
    expect(() => requireWebUrl(`https://example.com/${'a'.repeat(8192)}`)).toThrow(/too long/)
    expect(() => requireWebUrl(`https://example.com/${'a'.repeat(100)}`, { max: 64 })).toThrow(/too long/)
  })
})

describe('requireGitPath', () => {
  it('accepts ordinary relative paths', () => {
    expect(requireGitPath('src/file.ts')).toBe('src/file.ts')
    expect(requireGitPath('a')).toBe('a')
    expect(requireGitPath('.hidden/config')).toBe('.hidden/config')
  })

  it('rejects absolute paths and traversal or empty segments', () => {
    expect(() => requireGitPath('/etc/passwd')).toThrow(/relative/)
    for (const path of ['..', '.', 'a/../b', 'a/./b', './a', '../a', 'a//b', 'a/', '/a']) {
      expect(() => requireGitPath(path), path).toThrow(TypeError)
    }
  })

  it('rejects backslash traversal segments', () => {
    expect(() => requireGitPath('..\\outside.txt')).toThrow(/invalid segment/)
    expect(() => requireGitPath('src\\..\\..\\outside.txt')).toThrow(/invalid segment/)
    expect(() => requireGitPath('src/..\\outside.txt')).toThrow(/invalid segment/)
    expect(() => requireGitPath('a\\..\\b')).toThrow(/invalid segment/)
  })

  it('rejects empty and dot segments regardless of separator', () => {
    expect(() => requireGitPath('src//file.ts')).toThrow(/invalid segment/)
    expect(() => requireGitPath('src\\.\\file.ts')).toThrow(/invalid segment/)
  })

  it('rejects non-strings and NUL bytes', () => {
    expect(() => requireGitPath(42)).toThrow(/must be a string/)
    expect(() => requireGitPath('a\0b')).toThrow(/NUL/)
    expect(() => requireGitPath('')).toThrow(/too short/)
  })
})

describe('requireExistingPath', () => {
  it('resolves symlinks to their real path', async () => {
    const dir = temp('prime-work-validation-')
    const target = join(dir, 'target.txt')
    writeFileSync(target, 'data')
    const link = join(dir, 'link.txt')
    symlinkSync(target, link)
    const resolved = await requireExistingPath(link)
    expect(resolved).toBe(await requireExistingPath(target))
    expect(resolved.endsWith('target.txt')).toBe(true)
  })

  it('collapses dot-dot traversal through realpath resolution', async () => {
    const dir = temp('prime-work-validation-')
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'file.txt'), 'data')
    const resolved = await requireExistingPath(join(dir, 'nested', '..', 'file.txt'))
    expect(resolved).toBe(await requireExistingPath(join(dir, 'file.txt')))
  })

  it('rejects relative, missing, and malformed paths', async () => {
    const dir = temp('prime-work-validation-')
    await expect(requireExistingPath('relative/path')).rejects.toThrow(/absolute/)
    await expect(requireExistingPath(join(dir, 'missing.txt'))).rejects.toThrow()
    await expect(requireExistingPath(`${dir}\0`)).rejects.toThrow(/NUL/)
    await expect(requireExistingPath(undefined)).rejects.toThrow(/must be a string/)
  })
})

describe('isPathWithin', () => {
  it('accepts the root itself and true descendants', () => {
    expect(isPathWithin('/tmp/root', '/tmp/root')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root/child')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root/a/b/c')).toBe(true)
    expect(isPathWithin('/tmp/root/', '/tmp/root/child')).toBe(true)
  })

  it('rejects siblings, parents, traversal, and shared prefixes', () => {
    expect(isPathWithin('/tmp/root', '/tmp/other')).toBe(false)
    expect(isPathWithin('/tmp/root', '/tmp')).toBe(false)
    expect(isPathWithin('/tmp/root', '/tmp/root/../escape')).toBe(false)
    expect(isPathWithin('/tmp/root', '/tmp/rootbeer')).toBe(false)
    expect(isPathWithin('/tmp/root', '/')).toBe(false)
  })

  it('normalizes traversal inside the candidate before comparing', () => {
    expect(isPathWithin('/tmp/root', '/tmp/root/a/../b')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root/a/../../root/b')).toBe(true)
  })

  it('is a lexical check that does not resolve symlinks', () => {
    // Pins current behavior: a symlink inside the root that points outside
    // still counts as "within"; callers needing physical containment must
    // realpath first (as requireExistingPath does).
    const dir = temp('prime-work-validation-')
    const outside = temp('prime-work-validation-outside-')
    const link = join(dir, 'escape')
    symlinkSync(outside, link)
    expect(isPathWithin(dir, link)).toBe(true)
  })
})

describe('requireString', () => {
  it('enforces type, NUL bytes, and the default 64 KiB maximum', () => {
    expect(requireString('value', 'label')).toBe('value')
    expect(() => requireString(42, 'label')).toThrow(/must be a string/)
    expect(() => requireString('a\0b', 'label')).toThrow(/NUL/)
    expect(requireString('x'.repeat(64 * 1024), 'label')).toHaveLength(64 * 1024)
    expect(() => requireString('x'.repeat(64 * 1024 + 1), 'label')).toThrow(/too long/)
  })

  it('applies min and max to the trimmed value when trim is set', () => {
    expect(requireString('  padded  ', 'label', { trim: true })).toBe('padded')
    expect(() => requireString('   ', 'label', { min: 1, trim: true })).toThrow(/too short/)
    expect(requireString('   ', 'label', { min: 1 })).toBe('   ')
    expect(() => requireString(`  ${'x'.repeat(4)}  `, 'label', { max: 4, trim: true })).not.toThrow()
    expect(() => requireString('x'.repeat(5), 'label', { max: 4 })).toThrow(/too long/)
  })
})

describe('requireId', () => {
  it('accepts the documented id alphabet', () => {
    expect(requireId('runtime-1')).toBe('runtime-1')
    expect(requireId('a.b:c@d_e-f')).toBe('a.b:c@d_e-f')
    expect(requireId('  spaced-id  ')).toBe('spaced-id')
  })

  it('rejects characters outside the alphabet and out-of-range lengths', () => {
    for (const id of ['has space', 'slash/id', 'back\\slash', 'hash#id', 'emoji😀', '../up', 'semi;colon']) {
      expect(() => requireId(id), id).toThrow(/invalid characters/)
    }
    expect(() => requireId('')).toThrow(/too short/)
    expect(() => requireId('x'.repeat(257))).toThrow(/too long/)
    expect(requireId('x'.repeat(256))).toHaveLength(256)
  })
})

describe('requireSelfHostedVoiceUrl', () => {
  it('accepts loopback and private-network HTTP hosts', () => {
    for (const url of [
      'http://127.0.0.1:8000/',
      'http://localhost:8000/',
      'http://[::1]:8000/',
      'http://192.168.124.8:8000/',
      'http://10.0.0.5:9000',
      'http://172.16.0.1:9000',
      'http://172.31.255.254:9000',
      'http://[fd12::1]:8000/',
      'http://[fc00::5]:8000/',
      'http://[fe80::1]:8000/',
    ]) expect(requireSelfHostedVoiceUrl(url), url).toMatch(/^https?:/)
  })

  it('rejects public HTTP hosts but still allows them over HTTPS', () => {
    for (const url of [
      'http://1.2.3.4:8000/',
      'http://8.8.8.8:8000/',
      'http://9.255.255.255/',
      'http://172.15.0.1/',
      'http://172.32.0.1/',
      'http://192.169.0.1/',
      'http://example.com/',
      'http://[2001:db8::1]:8000/',
    ]) expect(() => requireSelfHostedVoiceUrl(url), url).toThrow(/private network/)
    expect(requireSelfHostedVoiceUrl('https://example.com/v1/')).toBe('https://example.com/v1/')
    expect(requireSelfHostedVoiceUrl('https://1.2.3.4:8000/')).toBe('https://1.2.3.4:8000/')
  })

  it('rejects query and fragment on self-hosted voice URLs', () => {
    expect(() => requireSelfHostedVoiceUrl('http://192.168.1.2:8000/?x=1')).toThrow(/query or fragment/)
    expect(() => requireSelfHostedVoiceUrl('http://192.168.1.2:8000/#frag')).toThrow(/query or fragment/)
  })

  it('normalizes the accepted URL', () => {
    expect(requireSelfHostedVoiceUrl('http://192.168.124.8:8000')).toBe('http://192.168.124.8:8000/')
  })
})
