import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { constants, type Dirent } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { ORB_PET } from '../../src/lib/pets'
import type { PetDefinition } from '../../src/types/api'
import { isRecord } from './validation'

const MAX_PETS = 64
const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_SPRITESHEET_BYTES = 16 * 1024 * 1024
const PET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

interface PetPackage {
  definition: PetDefinition
  directory: string
  spritesheet: string
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

async function boundedFile(path: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null
    const value = await readFile(path)
    return value.length <= maxBytes ? value : null
  } catch { return null }
}

function isWebpHeader(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
}

async function hasWebpSpritesheet(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size < 12 || info.size > MAX_SPRITESHEET_BYTES) return false
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) return false
      const header = Buffer.alloc(12)
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      return bytesRead === 12 && isWebpHeader(header)
    } finally { await handle.close() }
  } catch { return false }
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
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) } catch { return null }
  if (!isRecord(manifest)) return null
  const petId = boundedText(manifest.id, 64)
  const displayName = boundedText(manifest.displayName, 80)
  const description = boundedText(manifest.description, 240)
  if (!petId || !PET_ID.test(petId) || !displayName || !description || manifest.spritesheetPath !== 'spritesheet.webp') return null
  const spritesheet = join(directory, 'spritesheet.webp')
  if (!await hasWebpSpritesheet(spritesheet)) return null
  return {
    definition: { id: selectionId, petId, displayName, description, source, kind: 'spritesheet' },
    directory,
    spritesheet,
  }
}

export class PetService {
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
    const value = await boundedFile(candidate.spritesheet, MAX_SPRITESHEET_BYTES)
    if (!value || !isWebpHeader(value)) return null
    return `data:image/webp;base64,${value.toString('base64')}`
  }
}
