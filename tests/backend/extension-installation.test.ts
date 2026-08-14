import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installOmpExtension, validateExtensionInstallInput } from '../../electron/main/plugins/extension-installation'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function makeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-extension-install-'))
  dirs.push(dir)
  return realpathSync(dir)
}

function writeExtension(root: string, name = 'clock.ts'): string {
  const path = join(root, name)
  writeFileSync(path, 'export default () => undefined\n')
  return path
}

describe('validateExtensionInstallInput', () => {
  it('resolves the source through its real path for both scopes', () => {
    const root = makeRoot()
    const source = writeExtension(root)
    const link = join(root, 'linked.ts')
    symlinkSync(source, link)
    expect(validateExtensionInstallInput({ source: ` ${link} `, scope: 'user' })).toEqual({ source, scope: 'user', projectPath: undefined })
    expect(validateExtensionInstallInput({ source, scope: 'project', projectPath: root })).toEqual({ source, scope: 'project', projectPath: root })
  })

  it('accepts every supported extension suffix regardless of case', () => {
    const root = makeRoot()
    for (const name of ['a.ts', 'b.JS', 'c.mjs', 'd.CJS']) {
      const source = writeExtension(root, name)
      expect(validateExtensionInstallInput({ source, scope: 'user' }).source).toBe(source)
    }
  })

  it('rejects inputs that are not an object or lack a usable source path', () => {
    const root = makeRoot()
    expect(() => validateExtensionInstallInput('clock.ts')).toThrow('Extension installation must contain an object')
    expect(() => validateExtensionInstallInput({ scope: 'user' })).toThrow('extension source must be a string')
    expect(() => validateExtensionInstallInput({ source: 'clock.ts', scope: 'user' })).toThrow('absolute local file path')
    expect(() => validateExtensionInstallInput({ source: join(root, 'missing.ts'), scope: 'user' })).toThrow('Extension source does not exist')
  })

  it('rejects directories, unsupported suffixes, and oversized sources', () => {
    const root = makeRoot()
    const directory = join(root, 'nested.ts')
    mkdirSync(directory)
    expect(() => validateExtensionInstallInput({ source: directory, scope: 'user' })).toThrow('must be a regular file')
    expect(() => validateExtensionInstallInput({ source: writeExtension(root, 'notes.txt'), scope: 'user' })).toThrow('.ts, .js, .mjs, or .cjs file')
    const oversized = join(root, 'huge.ts')
    writeFileSync(oversized, Buffer.alloc(4 * 1024 * 1024 + 1))
    expect(() => validateExtensionInstallInput({ source: oversized, scope: 'user' })).toThrow('must not exceed 4194304 bytes')
  })

  it('requires a known scope and a project path for project scope', () => {
    const root = makeRoot()
    const source = writeExtension(root)
    expect(() => validateExtensionInstallInput({ source, scope: 'global' })).toThrow('Extension scope must be user or project')
    expect(() => validateExtensionInstallInput({ source, scope: 'project' })).toThrow('projectPath must be a string')
  })
})

describe('installOmpExtension', () => {
  it('installs into the OMP user extension directory with owner-only permissions', async () => {
    const root = makeRoot()
    const agentDir = join(root, 'agent')
    const source = writeExtension(root)
    const outcome = await installOmpExtension({ source, scope: 'user' }, agentDir)
    expect(outcome).toEqual({ ok: true, output: 'Installed OMP extension “clock.ts”. Start a new OMP session to load it.' })
    const installed = join(agentDir, 'extensions', 'clock.ts')
    expect(readFileSync(installed, 'utf8')).toContain('export default')
    expect(statSync(installed).mode & 0o777).toBe(0o600)
  })

  it('installs into the project .omp/extensions directory', async () => {
    const root = makeRoot()
    const project = join(root, 'project')
    mkdirSync(project)
    const source = writeExtension(root)
    const outcome = await installOmpExtension({ source, scope: 'project', projectPath: project }, join(root, 'agent'), realpathSync(project))
    expect(outcome.ok).toBe(true)
    expect(readFileSync(join(project, '.omp', 'extensions', 'clock.ts'), 'utf8')).toContain('export default')
  })

  it('reports a blocked outcome instead of overwriting an existing extension', async () => {
    const root = makeRoot()
    const agentDir = join(root, 'agent')
    const source = writeExtension(root)
    await installOmpExtension({ source, scope: 'user' }, agentDir)
    writeFileSync(source, 'export default () => 1\n')
    const duplicate = await installOmpExtension({ source, scope: 'user' }, agentDir)
    expect(duplicate).toEqual({ ok: false, reason: 'blocked', output: 'An OMP extension named “clock.ts” already exists in this scope.' })
    expect(readFileSync(join(agentDir, 'extensions', 'clock.ts'), 'utf8')).toContain('=> undefined')
  })

  it('refuses a symlinked OMP extension directory', async () => {
    const root = makeRoot()
    const agentDir = join(root, 'agent')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(agentDir)
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(agentDir, 'extensions'))
    await expect(installOmpExtension({ source: writeExtension(root), scope: 'user' }, agentDir)).rejects.toThrow('must be a real directory')
  })

  it('refuses a source that grew past the size limit after validation', async () => {
    const root = makeRoot()
    const source = join(root, 'grown.ts')
    writeFileSync(source, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20))
    await expect(installOmpExtension({ source, scope: 'user' }, join(root, 'agent'))).rejects.toThrow('must not exceed 4194304 bytes')
  })
})
