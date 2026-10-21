import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { constants, type BigIntStats, type Dirent } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { ORB_PET } from '../../src/lib/pets'
import type { PetDefinition } from '../../src/types/api'
import { isRecord } from './validation'

const MAX_PETS = 64
const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024
const MAX_CACHED_SPRITES = 4
const MAX_CACHED_SPRITE_BYTES = 32 * 1024 * 1024
const PET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

interface PetPackage {
  definition: PetDefinition
  directory: string
  spritesheet: string
  spriteIdentity: string
}

export interface PetServiceOptions {
  builtInRoot: string
  codexRoot: string
}

async function stableDirectory(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return null
    return await realpath(path)
  } catch { return null }
}

function fileIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

async function boundedFile(path: string, maxBytes: number, readLimit?: number): Promise<{ bytes: Buffer; identity: string } | null> {
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maxBytes)) return null
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      const identity = fileIdentity(info)
      if (!opened.isFile() || fileIdentity(opened) !== identity) return null
      const limit = readLimit ?? Math.min(maxBytes + 1, Number(info.size) + 1)
      const buffer = Buffer.alloc(limit)
      let offset = 0
      while (offset < limit) {
        const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > maxBytes || fileIdentity(await handle.stat({ bigint: true })) !== identity) return null
      const current = await lstat(path, { bigint: true })
      if (current.isSymbolicLink() || fileIdentity(current) !== identity) return null
      return { bytes: buffer.subarray(0, offset), identity }
    } finally { await handle.close() }
  } catch { return null }
}

function isWebpHeader(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= max ? normalized : null
}

async function readPackage(directory: string, selectionId: string, source: PetDefinition['source']): Promise<PetPackage | null> {
  const manifestBytes = await boundedFile(join(directory, 'pet.json'), MAX_MANIFEST_BYTES)
  if (!manifestBytes) return null
  let manifest: unknown
  try { manifest = JSON.parse(manifestBytes.bytes.toString('utf8')) } catch { return null }
  if (!isRecord(manifest)) return null
  const petId = boundedText(manifest.id, 64)
  const displayName = boundedText(manifest.displayName, 80)
  const description = boundedText(manifest.description, 240)
  if (!petId || !PET_ID.test(petId) || !displayName || !description || manifest.spritesheetPath !== 'spritesheet.webp') return null
  const spritesheet = join(directory, 'spritesheet.webp')
  const header = await boundedFile(spritesheet, MAX_SPRITESHEET_BYTES, 12)
  if (!header || !isWebpHeader(header.bytes)) return null
  return {
    definition: { id: selectionId, petId, displayName, description, source, kind: 'spritesheet' },
    directory,
    spritesheet,
    spriteIdentity: header.identity,
  }
}

export class PetService {
  private readonly sprites = new Map<string, { identity: string; url: string; bytes: number }>()
  private cachedSpriteBytes = 0
  constructor(private readonly options: PetServiceOptions) {}

  private async packages(): Promise<PetPackage[]> {
    const packages: PetPackage[] = []
    const builtInRoot = await stableDirectory(this.options.builtInRoot)
    if (builtInRoot) {
      const gooeyDirectory = await stableDirectory(join(builtInRoot, 'gooey-pi'))
      if (gooeyDirectory) {
        const gooey = await readPackage(gooeyDirectory, 'gooey-pi', 'built-in')
        if (gooey) packages.push(gooey)
      }
    }

    const codexRoot = await stableDirectory(this.options.codexRoot)
    if (!codexRoot) return packages
    let entries: Dirent[]
    try { entries = await readdir(codexRoot, { withFileTypes: true }) } catch { return packages }
    const builtInIds = new Set(packages.map((item) => item.definition.petId))
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (packages.length >= MAX_PETS || !entry.isDirectory() || entry.isSymbolicLink() || !PET_ID.test(entry.name)) continue
      const directory = await stableDirectory(join(codexRoot, entry.name))
      const contained = directory ? relative(codexRoot, directory) : '..'
      if (!directory || !contained || contained.startsWith('..') || isAbsolute(contained)) continue
      const candidate = await readPackage(directory, `codex/${entry.name}`, 'codex')
      if (!candidate || builtInIds.has(candidate.definition.petId)) continue
      packages.push(candidate)
      builtInIds.add(candidate.definition.petId)
    }
    return packages
  }

  async list(): Promise<PetDefinition[]> {
    return [ORB_PET, ...(await this.packages()).map((item) => item.definition)]
  }

  async sprite(selectionId: unknown): Promise<string | null> {
    if (typeof selectionId !== 'string' || !/^(?:gooey-pi|codex\/[a-z0-9][a-z0-9._-]{0,63})$/i.test(selectionId)) throw new TypeError('Invalid pet id')
    const candidate = (await this.packages()).find((item) => item.definition.id === selectionId)
    if (!candidate) return null
    const cached = this.sprites.get(candidate.spritesheet)
    if (cached) {
      this.sprites.delete(candidate.spritesheet)
      if (cached.identity === candidate.spriteIdentity) {
        this.sprites.set(candidate.spritesheet, cached)
        return cached.url
      }
      this.cachedSpriteBytes -= cached.bytes
    }
    const value = await boundedFile(candidate.spritesheet, MAX_SPRITESHEET_BYTES)
    if (!value || value.identity !== candidate.spriteIdentity || !isWebpHeader(value.bytes)) return null
    const url = `data:image/webp;base64,${value.bytes.toString('base64')}`
    const bytes = url.length * 2 // Conservative UTF-16 cost, even when V8 stores ASCII compactly.
    if (bytes <= MAX_CACHED_SPRITE_BYTES) {
      const replaced = this.sprites.get(candidate.spritesheet)
      if (replaced) this.cachedSpriteBytes -= replaced.bytes
      this.sprites.set(candidate.spritesheet, { identity: value.identity, url, bytes })
      this.cachedSpriteBytes += bytes
      while (this.sprites.size > MAX_CACHED_SPRITES || this.cachedSpriteBytes > MAX_CACHED_SPRITE_BYTES) {
        const oldest = this.sprites.entries().next().value
        if (!oldest) break
        this.sprites.delete(oldest[0]); this.cachedSpriteBytes -= oldest[1].bytes
      }
    }
    return url
  }
}
