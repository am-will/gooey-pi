import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boundedErrorMessage,
  errorCode,
  firstAccepted,
  isBoundedString,
  isModelId,
  isModelKey,
  isOneOf,
  isPathWithin,
  isProviderId,
  MODEL_ID,
  MODEL_KEY,
  PROVIDER_ID,
  requireAbsolutePath,
  requireExistingDirectory,
  requireExistingPath,
  requireGitPath,
  requireId,
  requireSelfHostedVoiceUrl,
  requireString,
  requireWebUrl,
  stripAnsi,
} from '../../electron/main/validation'
import { HARNESS_IDS, type HarnessId, LOCALE_PREFERENCES } from '../../src/types/api'

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

describe('requireAbsolutePath', () => {
  it('returns absolute paths unchanged without requiring them to exist', () => {
    expect(requireAbsolutePath('/tmp/does-not-exist/child')).toBe('/tmp/does-not-exist/child')
    expect(requireAbsolutePath('/tmp/root/../other')).toBe('/tmp/root/../other')
  })

  it('rejects relative, empty, oversized, NUL-containing and non-string input with the label', () => {
    expect(() => requireAbsolutePath('relative/dir', 'project path')).toThrow('project path must be absolute')
    expect(() => requireAbsolutePath('./dir')).toThrow('path must be absolute')
    expect(() => requireAbsolutePath('', 'project path')).toThrow('project path is too short')
    expect(() => requireAbsolutePath(`/${'a'.repeat(4096)}`)).toThrow(/too long/)
    expect(() => requireAbsolutePath('/tmp/a\0b')).toThrow(/NUL/)
    expect(() => requireAbsolutePath(undefined, 'project path')).toThrow('project path must be a string')
    expect(() => requireAbsolutePath({})).toThrow(TypeError)
  })
})

describe('requireExistingDirectory', () => {
  it('returns the real path of an existing directory', async () => {
    const dir = temp('prime-work-validation-')
    mkdirSync(join(dir, 'nested'))
    const linked = join(dir, 'linked')
    symlinkSync(join(dir, 'nested'), linked)
    expect(await requireExistingDirectory(linked)).toBe(await requireExistingPath(join(dir, 'nested')))
  })

  it('rejects files, relative paths and non-strings with the existing messages', async () => {
    const dir = temp('prime-work-validation-')
    writeFileSync(join(dir, 'file.txt'), 'data')
    await expect(requireExistingDirectory(join(dir, 'file.txt'), 'cwd')).rejects.toThrow('cwd must be a directory')
    await expect(requireExistingDirectory('relative/dir', 'cwd')).rejects.toThrow('cwd must be absolute')
    await expect(requireExistingDirectory(42, 'cwd')).rejects.toThrow('cwd must be a string')
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
    expect(isPathWithin('/tmp/root', '/tmp/root/..')).toBe(false)
  })

  it('accepts children whose names merely start with two dots', () => {
    expect(isPathWithin('/tmp/root', '/tmp/root/..cache/x')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root/..env')).toBe(true)
    expect(isPathWithin('/tmp/root', '/tmp/root/..cache/../../x')).toBe(false)
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
      'http://[fc00::1]:8000/',
      'http://[fdff::1]:8000/',
      'http://[fe80::1]:8000/',
      'http://[febf::1]:8000/',
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
      'http://fdns.io/',
      'http://fd.example.com/',
      'http://fcserver.attacker.com/',
      'http://fe80.example.com/',
      'http://[::ffff:10.0.0.1]:8000/',
      'http://[fc::1]:8000/',
      'http://[fd::5]:8000/',
      'http://[fd0::1]:8000/',
      'http://[fec0::1]:8000/',
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

describe('stripAnsi', () => {
  it('removes CSI sequences completely, including their parameters', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m plain')).toBe('red plain')
    expect(stripAnsi('\u001b[1;32mbold green\u001b[39;49m')).toBe('bold green')
    expect(stripAnsi('\u001b[?25lhidden cursor\u001b[2K')).toBe('hidden cursor')
  })

  it('removes OSC 8 hyperlinks terminated by BEL or ST, keeping the link text', () => {
    expect(stripAnsi('see \u001b]8;;https://example.com/docs\u0007the docs\u001b]8;;\u0007 now')).toBe('see the docs now')
    expect(stripAnsi('\u001b]8;id=1;https://example.com\u001b\\link\u001b]8;;\u001b\\')).toBe('link')
  })

  it('removes OSC title sequences', () => {
    expect(stripAnsi('\u001b]0;window title\u0007output')).toBe('output')
    expect(stripAnsi('\u001b]2;tab title\u001b\\output')).toBe('output')
  })

  it('removes two-byte escapes and only the introducer of an unterminated OSC', () => {
    expect(stripAnsi('a\u001bMb\u001bDc')).toBe('abc')
    expect(stripAnsi('\u001b]unterminated')).toBe('unterminated')
  })
})

describe('firstAccepted', () => {
  it('returns the first success and never calls later attempts', async () => {
    const calls: string[] = []
    const later = vi.fn(() => 'later')
    const result = await firstAccepted([
      () => { calls.push('first'); throw new Error('first rejected') },
      async () => { calls.push('second'); return 'second' },
      later,
    ])
    expect(result).toBe('second')
    expect(calls).toEqual(['first', 'second'])
    expect(later).not.toHaveBeenCalled()
  })

  it('runs attempts strictly in order, awaiting each before the next', async () => {
    const calls: string[] = []
    let rejectFirst!: (error: Error) => void
    const result = firstAccepted([
      () => new Promise<string>((_resolve, reject) => { calls.push('first'); rejectFirst = reject }),
      () => { calls.push('second'); return 'second' },
    ])
    await new Promise((resolveTick) => setImmediate(resolveTick))
    expect(calls).toEqual(['first'])

    rejectFirst(new Error('first rejected'))
    await expect(result).resolves.toBe('second')
    expect(calls).toEqual(['first', 'second'])
  })

  it('rethrows the first error, not the last, when every attempt fails', async () => {
    const primary = new TypeError('outside the Prime session directory')
    await expect(firstAccepted([
      () => { throw primary },
      async () => { throw new Error('outside the OMP session directory') },
      () => Promise.reject(new Error('outside the Pi session directory')),
    ])).rejects.toBe(primary)
  })

  it('treats a synchronous throw as a rejection and keeps trying', async () => {
    await expect(firstAccepted([() => { throw new Error('sync') }, () => 'fallback'])).resolves.toBe('fallback')
  })

  it('rejects an empty attempt list', async () => {
    await expect(firstAccepted([])).rejects.toThrow(/at least one attempt/)
  })
})

describe('isOneOf', () => {
  it('accepts every member of an as-const array', () => {
    for (const harness of HARNESS_IDS) expect(isOneOf(HARNESS_IDS, harness), harness).toBe(true)
    for (const locale of LOCALE_PREFERENCES) expect(isOneOf(LOCALE_PREFERENCES, locale), locale).toBe(true)
  })

  it('rejects non-members, near misses and non-string values', () => {
    for (const value of ['Prime', 'prime ', '', 'zh', undefined, null, 0, {}, ['prime']]) {
      expect(isOneOf(HARNESS_IDS, value), String(value)).toBe(false)
    }
  })

  it('narrows unknown input to the array element type', () => {
    const value: unknown = 'pi'
    if (!isOneOf(HARNESS_IDS, value)) throw new Error('expected a harness id')
    const harness: HarnessId = value
    expect(harness).toBe('pi')
  })
})

describe('provider and model identifier guards', () => {
  const provider128 = `a${'b'.repeat(127)}`
  const model256 = 'm'.repeat(256)

  it.each([
    ['a 1-character provider', 'a', true],
    ['a 128-character provider', provider128, true],
    ['a 129-character provider', `${provider128}c`, false],
    ['an uppercase provider', 'OpenAI', true],
    ['a provider with dots, dashes and underscores', 'openai-codex_v2.1', true],
    ['a leading dash', '-openai', false],
    ['a leading dot', '.openai', false],
    ['a slash', 'open/ai', false],
    ['an empty string', '', false],
    ['a non-string', 42, false],
  ])('isProviderId: %s -> %s', (_name, value, expected) => {
    expect(isProviderId(value)).toBe(expected)
  })

  it.each([
    ['a 256-character id', model256, true],
    ['a 257-character id', `${model256}m`, false],
    ['an id with path, colon and plus characters', 'org/model:latest+beta', true],
    ['an id with a leading dash', '-model', true],
    ['an id with a space', 'gpt 5', false],
    ['an empty string', '', false],
    ['a non-string', null, false],
  ])('isModelId: %s -> %s', (_name, value, expected) => {
    expect(isModelId(value)).toBe(expected)
  })

  it.each([
    ['a simple key', 'openai/gpt-5', true],
    ['a key whose id contains ":" and "+"', 'ollama/qwen3:32b+q4', true],
    ['a key whose id contains further slashes', 'openrouter/anthropic/claude', true],
    ['an uppercase provider', 'OpenAI/GPT-5', true],
    ['the 385-character maximum', `${provider128}/${model256}`, true],
    ['a 129-character provider', `${provider128}c/model`, false],
    ['a 257-character id', `openai/${model256}m`, false],
    ['no slash', 'openai', false],
    ['an empty provider', '/gpt-5', false],
    ['an empty id', 'openai/', false],
    ['a leading dash on the provider', '-openai/gpt-5', false],
    ['an empty string', '', false],
    ['a non-string', { provider: 'openai', id: 'gpt-5' }, false],
  ])('isModelKey: %s -> %s', (_name, value, expected) => {
    expect(isModelKey(value)).toBe(expected)
  })

  it('keeps the shared patterns stateless across repeated calls', () => {
    for (const pattern of [PROVIDER_ID, MODEL_ID, MODEL_KEY]) {
      expect(pattern.global).toBe(false)
      expect(pattern.sticky).toBe(false)
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(isProviderId('openai')).toBe(true)
      expect(isModelId('gpt-5')).toBe(true)
      expect(isModelKey('openai/gpt-5')).toBe(true)
    }
  })
})

describe('isBoundedString', () => {
  it('accepts non-blank strings up to and including the maximum length', () => {
    expect(isBoundedString('a', 1)).toBe(true)
    expect(isBoundedString('x'.repeat(128), 128)).toBe(true)
    expect(isBoundedString('  padded  ', 10)).toBe(true)
  })

  it('rejects strings over the maximum, counting untrimmed length', () => {
    expect(isBoundedString('x'.repeat(129), 128)).toBe(false)
    expect(isBoundedString(' ab ', 3)).toBe(false)
  })

  it('rejects empty and whitespace-only strings unless allowEmpty is set', () => {
    expect(isBoundedString('', 10)).toBe(false)
    expect(isBoundedString('   ', 10)).toBe(false)
    expect(isBoundedString('', 10, true)).toBe(true)
    expect(isBoundedString('   ', 10, true)).toBe(true)
    expect(isBoundedString('   ', 2, true)).toBe(false)
  })

  it('rejects non-strings regardless of allowEmpty', () => {
    for (const value of [undefined, null, 0, false, ['a'], { length: 1 }]) {
      expect(isBoundedString(value, 10), String(value)).toBe(false)
      expect(isBoundedString(value, 10, true), String(value)).toBe(false)
    }
  })
})

describe('boundedErrorMessage', () => {
  it('collapses line breaks and tabs into single spaces', () => {
    expect(boundedErrorMessage(new Error('first line\r\nsecond\tthird\n\nfourth'))).toBe('first line second third fourth')
  })

  it('caps the message at 512 characters by default and at an explicit maximum', () => {
    expect(boundedErrorMessage(new Error('x'.repeat(600)))).toHaveLength(512)
    expect(boundedErrorMessage(new Error('x'.repeat(3_000)), 2_048)).toHaveLength(2_048)
    expect(boundedErrorMessage(new Error('line one\nline two'), 10)).toBe('line one l')
  })

  it('stringifies non-Error values', () => {
    expect(boundedErrorMessage('plain failure')).toBe('plain failure')
    expect(boundedErrorMessage(42)).toBe('42')
    expect(boundedErrorMessage(undefined)).toBe('undefined')
  })

  it('falls back when the message is empty', () => {
    expect(boundedErrorMessage(new Error(''))).toBe('Unknown error')
    expect(boundedErrorMessage('')).toBe('Unknown error')
    expect(boundedErrorMessage(new Error(''), 240, 'Update check failed')).toBe('Update check failed')
  })
})

describe('errorCode', () => {
  it('returns the string code of errno-style errors', () => {
    expect(errorCode(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(errorCode({ code: 'EEXIST' })).toBe('EEXIST')
  })

  it('reads a real filesystem error code', () => {
    let thrown: unknown
    try { rmSync(join(temp('gooey-error-code-'), 'missing')) } catch (error) { thrown = error }
    expect(errorCode(thrown)).toBe('ENOENT')
  })

  it('returns an empty string when there is no string code instead of throwing', () => {
    expect(errorCode(new Error('plain'))).toBe('')
    expect(errorCode(Object.assign(new Error('numeric'), { code: 42 }))).toBe('')
    for (const value of ['ENOENT', undefined, null, 0, ['ENOENT'], [{ code: 'ENOENT' }]]) {
      expect(errorCode(value), String(value)).toBe('')
    }
  })
})
