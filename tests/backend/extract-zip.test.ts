import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extractZip from 'extract-zip'
import { afterEach, describe, expect, it } from 'vitest'

interface ZipEntry {
  name: string
  data?: Buffer
  mode: number
}

const dirs: string[] = []
const require = createRequire(import.meta.url)
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-extract-zip-'))
  dirs.push(dir)
  return dir
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeZip(path: string, entries: ZipEntry[]): void {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = entry.data ?? Buffer.alloc(0)
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + data.length
  }

  const centralOffset = localOffset
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  writeFileSync(path, Buffer.concat([...localParts, ...centralParts, end]))
}

function primeBundleSource(): string {
  return readFileSync(join(process.cwd(), 'node_modules/prime-agent/dist/bundle/chunk-L3VO7F2S.js'), 'utf8')
}

function loadPrimeBundledExtractZip(source: string): typeof extractZip {
  const dependenciesStart = source.indexOf('// ../../node_modules/wrappy/wrappy.js')
  const dependenciesEnd = source.indexOf('// dist/main.js')
  if (dependenciesStart < 0 || dependenciesEnd <= dependenciesStart) throw new Error('Prime bundled extraction module was not found')

  const commonJs = (callbacks: Record<string, (exports: object, module: { exports: unknown }) => void>) => {
    let module: { exports: unknown } | undefined
    return () => {
      try {
        if (!module) {
          module = { exports: {} }
          callbacks[Object.keys(callbacks)[0]]?.(module.exports as object, module)
        }
        return module.exports
      } catch (error) {
        module = undefined
        throw error
      }
    }
  }

  const evaluate = new Function(
    '__commonJS',
    '__require',
    'require_src',
    `${source.slice(dependenciesStart, dependenciesEnd)}\nreturn require_extract_zip()`,
  )
  return evaluate(commonJs, require, () => require('debug')) as typeof extractZip
}

describe('vendored extract-zip policy', () => {
  it('rejects an escaping symlink before creating it', async () => {
    const root = temp()
    const archive = join(root, 'malicious.zip')
    const output = join(root, 'staging')
    const outside = join(root, 'outside.txt')
    writeZip(archive, [{
      name: 'nested/escape',
      data: Buffer.from('../../outside.txt'),
      mode: 0o120777,
    }])

    await expect(extractZip(archive, { dir: output })).rejects.toThrow(/symbolic link/i)
    expect(existsSync(join(output, 'nested'))).toBe(false)
    expect(existsSync(outside)).toBe(false)
  })

  it('rejects a parent-traversal entry before creating an outside directory', async () => {
    const root = temp()
    const archive = join(root, 'traversal.zip')
    const output = join(root, 'staging')
    const outsideDirectory = join(root, 'escaped-dir')
    const outsideFile = join(outsideDirectory, 'payload')
    writeZip(archive, [{
      name: '../escaped-dir/payload',
      data: Buffer.from('must stay inside the archive'),
      mode: 0o100644,
    }])

    await expect(extractZip(archive, { dir: output })).rejects.toThrow(/invalid relative path|out of bound/i)
    expect(existsSync(outsideFile)).toBe(false)
    expect(existsSync(outsideDirectory)).toBe(false)
  })

  it('preserves ordinary Prime-style archive files and directories', async () => {
    const root = temp()
    const archive = join(root, 'fd.zip')
    const output = join(root, 'staging')
    const prefix = 'fd-v10.2.0-x86_64-pc-windows-msvc/'
    const executable = Buffer.from('representative fd executable bytes')
    writeZip(archive, [
      { name: prefix, mode: 0o040755 },
      { name: `${prefix}fd.exe`, data: executable, mode: 0o100755 },
      { name: `${prefix}README.md`, data: Buffer.from('# fd\n'), mode: 0o100644 },
    ])

    await extractZip(archive, { dir: output })

    expect(statSync(join(output, prefix)).isDirectory()).toBe(true)
    expect(readFileSync(join(output, prefix, 'fd.exe'))).toEqual(executable)
    expect(readFileSync(join(output, prefix, 'README.md'), 'utf8')).toBe('# fd\n')
  })
})

describe('Prime production bundle ZIP policy', () => {
  it('connects the production tool downloader to the hardened embedded extractor', () => {
    const source = primeBundleSource()
    const extractModuleStart = source.indexOf('// ../../node_modules/extract-zip/index.js')
    const extractModuleEnd = source.indexOf('// dist/main.js')
    const toolsManagerStart = source.indexOf('// dist/utils/tools-manager.js')
    const toolsManagerEnd = source.indexOf('// dist/modes/interactive/components/custom-editor.js', toolsManagerStart)
    const extractModule = source.slice(extractModuleStart, extractModuleEnd)
    const toolsManager = source.slice(toolsManagerStart, toolsManagerEnd)

    expect(extractModuleStart).toBeGreaterThanOrEqual(0)
    expect(extractModuleEnd).toBeGreaterThan(extractModuleStart)
    expect(toolsManagerStart).toBeGreaterThanOrEqual(0)
    expect(toolsManagerEnd).toBeGreaterThan(toolsManagerStart)
    expect(toolsManager).toContain('var import_extract_zip = __toESM(require_extract_zip(), 1);')
    expect(toolsManager).toContain('await (0, import_extract_zip.default)(archivePath, { dir: extractDir });')
    expect(extractModule).toContain('throw new Error(`Symbolic link entries are not supported: ${entry.fileName}`)')
    expect(extractModule).not.toContain('await fs6.symlink(')

    const symlinkGuard = extractModule.indexOf('if (isSymlink(entry)) {')
    const resolveDestination = extractModule.indexOf('const dest = path6.resolve(this.opts.dir, entry.fileName);')
    const lexicalContainment = extractModule.indexOf('const relativeDest = path6.relative(this.opts.dir, dest);')
    const lexicalGuard = extractModule.indexOf(
      'if (relativeDest === ".." || relativeDest.startsWith(`..${path6.sep}`) || path6.isAbsolute(relativeDest)) {',
    )
    const firstEntryMkdir = extractModule.indexOf('await fs6.mkdir(destDir, { recursive: true });')
    expect(symlinkGuard).toBeGreaterThanOrEqual(0)
    expect(resolveDestination).toBeGreaterThan(symlinkGuard)
    expect(resolveDestination).toBeGreaterThanOrEqual(0)
    expect(lexicalContainment).toBeGreaterThan(resolveDestination)
    expect(lexicalGuard).toBeGreaterThan(lexicalContainment)
    expect(firstEntryMkdir).toBeGreaterThan(lexicalGuard)
  })

  it('rejects an escaping symlink through Prime bundled production code', async () => {
    const root = temp()
    const archive = join(root, 'prime-malicious.zip')
    const output = join(root, 'staging')
    const outside = join(root, 'outside.txt')
    writeZip(archive, [{
      name: 'nested/escape',
      data: Buffer.from('../../outside.txt'),
      mode: 0o120777,
    }])

    const bundledExtractZip = loadPrimeBundledExtractZip(primeBundleSource())
    await expect(bundledExtractZip(archive, { dir: output })).rejects.toThrow(/symbolic link/i)
    expect(existsSync(join(output, 'nested'))).toBe(false)
    expect(existsSync(outside)).toBe(false)
  })

  it('rejects parent traversal and preserves ordinary extraction through Prime bundled code', async () => {
    const root = temp()
    const maliciousArchive = join(root, 'prime-traversal.zip')
    const maliciousOutput = join(root, 'malicious-staging')
    const outsideDirectory = join(root, 'escaped-dir')
    writeZip(maliciousArchive, [{
      name: '../escaped-dir/payload',
      data: Buffer.from('must stay inside the archive'),
      mode: 0o100644,
    }])

    const bundledExtractZip = loadPrimeBundledExtractZip(primeBundleSource())
    await expect(bundledExtractZip(maliciousArchive, { dir: maliciousOutput })).rejects.toThrow(/invalid relative path|out of bound/i)
    expect(existsSync(outsideDirectory)).toBe(false)

    const ordinaryArchive = join(root, 'prime-fd.zip')
    const ordinaryOutput = join(root, 'ordinary-staging')
    const prefix = 'fd-v10.2.0-x86_64-pc-windows-msvc/'
    const executable = Buffer.from('representative fd executable bytes')
    writeZip(ordinaryArchive, [
      { name: prefix, mode: 0o040755 },
      { name: `${prefix}fd.exe`, data: executable, mode: 0o100755 },
    ])

    await bundledExtractZip(ordinaryArchive, { dir: ordinaryOutput })
    expect(readFileSync(join(ordinaryOutput, prefix, 'fd.exe'))).toEqual(executable)
  })
})
