import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
const reads = vi.hoisted(() => [] as Array<{ path: string; bytes: number }>)
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    handle.read = new Proxy(handle.read, { apply(target, receiver, readArgs) {
      if (typeof readArgs[2] === 'number') reads.push({ path: String(args[0]), bytes: readArgs[2] })
      return Reflect.apply(target, receiver, readArgs)
    } })
    return handle
  }) }
})
import { PetService } from '../../electron/main/pets'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function makeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gooeypi-pets-')))
  roots.push(root)
  return root
}

function writePet(root: string, folder: string, id = folder, displayName = folder): string {
  const directory = join(root, folder)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'pet.json'), JSON.stringify({ id, displayName, description: `${displayName} description`, spritesheetPath: 'spritesheet.webp' }))
  writeFileSync(join(directory, 'spritesheet.webp'), Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary'))
  return directory
}

describe('PetService', () => {
  it('always lists Orb, prefers bundled pets, and discovers compatible Codex pets', async () => {
    const root = makeRoot()
    const builtInRoot = join(root, 'built-in')
    const codexRoot = join(root, 'codex')
    writePet(builtInRoot, 'gooey-pi', 'gooey-pi', 'GooeyPi')
    writePet(codexRoot, 'gooey-pi', 'gooey-pi', 'Duplicate Gooey')
    writePet(codexRoot, 'rocky', 'rocky', 'Rocky')
    const service = new PetService({ builtInRoot, codexRoot })

    const pets = await service.list()
    expect(pets.map((pet) => [pet.id, pet.displayName, pet.source])).toEqual([
      ['orb', 'Orb', 'built-in'],
      ['gooey-pi', 'GooeyPi', 'built-in'],
      ['codex/rocky', 'Rocky', 'codex'],
    ])
    await expect(service.sprite('gooey-pi')).resolves.toMatch(/^data:image\/webp;base64,/)
    await expect(service.sprite('codex/rocky')).resolves.toMatch(/^data:image\/webp;base64,/)
    await expect(service.sprite('orb')).rejects.toThrow('Invalid pet id')
    await expect(service.sprite('../escape')).rejects.toThrow('Invalid pet id')
  })

  it('skips malformed, oversized, and symlinked packages without losing built-ins', async () => {
    const root = makeRoot()
    const builtInRoot = join(root, 'built-in')
    const codexRoot = join(root, 'codex')
    writePet(builtInRoot, 'gooey-pi', 'gooey-pi', 'GooeyPi')
    writePet(codexRoot, 'bad-manifest', 'bad id', 'Bad')
    const target = writePet(codexRoot, 'target', 'target', 'Target')
    symlinkSync(target, join(codexRoot, 'linked'))
    const oversized = writePet(codexRoot, 'oversized', 'oversized', 'Oversized')
    writeFileSync(join(oversized, 'pet.json'), 'x'.repeat(16 * 1024 + 1))

    const service = new PetService({ builtInRoot, codexRoot })
    expect((await service.list()).map((pet) => pet.id)).toEqual(['orb', 'gooey-pi', 'codex/target'])
  })
})


it('reads only WebP headers during listing and retains duplicate/symlink/size protections', async () => {
  const root = makeRoot()
  const builtInRoot = join(root, 'built-in')
  const codexRoot = join(root, 'codex')
  writePet(builtInRoot, 'gooey-pi')
  writePet(codexRoot, 'duplicate-gooey', 'gooey-pi')
  writePet(codexRoot, 'first', 'same-pet')
  writePet(codexRoot, 'second', 'same-pet')
  const invalid = writePet(codexRoot, 'invalid'); writeFileSync(join(invalid, 'spritesheet.webp'), 'not a WebP header')
  const oversized = writePet(codexRoot, 'large'); truncateSync(join(oversized, 'spritesheet.webp'), 16 * 1024 * 1024 + 1)
  const linked = writePet(codexRoot, 'linked'); rmSync(join(linked, 'spritesheet.webp')); symlinkSync(join(invalid, 'spritesheet.webp'), join(linked, 'spritesheet.webp'))
  const service = new PetService({ builtInRoot, codexRoot })
  vi.mocked(readFile).mockClear()
  reads.length = 0
  expect((await service.list()).map((pet) => pet.id)).toEqual(['orb', 'gooey-pi', 'codex/first'])
  expect(vi.mocked(readFile).mock.calls.some(([path]) => String(path).endsWith('spritesheet.webp'))).toBe(false)
  expect(reads.filter(({ path }) => path.endsWith('spritesheet.webp')).every(({ bytes }) => bytes === 12)).toBe(true)
  for (const id of ['codex/duplicate-gooey', 'codex/second', 'codex/invalid', 'codex/large', 'codex/linked']) await expect(service.sprite(id)).resolves.toBeNull()
})


it('caches sprite data by verified file identity and invalidates a replacement with preserved mtime', async () => {
  const root = makeRoot()
  const directory = writePet(root, 'gooey-pi')
  const sprite = join(directory, 'spritesheet.webp')
  const service = new PetService({ builtInRoot: root, codexRoot: join(root, 'missing') })
  reads.length = 0
  const first = await service.sprite('gooey-pi')
  expect(await service.sprite('gooey-pi')).toBe(first)
  expect(reads.filter(({ path, bytes }) => path === sprite && bytes > 12)).toHaveLength(1)
  const previous = statSync(sprite)
  renameSync(sprite, `${sprite}.old`)
  writeFileSync(sprite, Buffer.from('RIFF\x04\x00\x00\x00WEBPnew', 'binary'))
  utimesSync(sprite, previous.atime, previous.mtime)
  const replaced = await service.sprite('gooey-pi')
  expect(replaced).not.toBe(first)
  expect(replaced).toBe(`data:image/webp;base64,${Buffer.from('RIFF\x04\x00\x00\x00WEBPnew', 'binary').toString('base64')}`)
})

it('bounds the sprite cache to four entries and never serves cached packages hidden by changed manifests', async () => {
  const root = makeRoot()
  const codexRoot = join(root, 'codex')
  for (let index = 0; index < 5; index++) writePet(codexRoot, `pet-${index}`)
  const service = new PetService({ builtInRoot: join(root, 'missing'), codexRoot })
  reads.length = 0
  for (let index = 0; index < 5; index++) await service.sprite(`codex/pet-${index}`)
  await service.sprite('codex/pet-0')
  expect(reads.filter(({ path, bytes }) => path === join(codexRoot, 'pet-0', 'spritesheet.webp') && bytes > 12)).toHaveLength(2)
  writeFileSync(join(codexRoot, 'pet-0', 'pet.json'), '{}')
  await expect(service.sprite('codex/pet-0')).resolves.toBeNull()
})

it('bounds cached sprite strings by bytes as well as entry count', async () => {
  const root = makeRoot()
  const codexRoot = join(root, 'codex')
  const large = Buffer.alloc(5 * 1024 * 1024, 1)
  Buffer.from('RIFF\x04\x00\x00\x00WEBP', 'binary').copy(large)
  for (let index = 0; index < 3; index++) {
    const directory = writePet(codexRoot, `large-${index}`)
    writeFileSync(join(directory, 'spritesheet.webp'), large)
  }
  const service = new PetService({ builtInRoot: join(root, 'missing'), codexRoot })
  reads.length = 0
  for (let index = 0; index < 3; index++) await service.sprite(`codex/large-${index}`)
  await service.sprite('codex/large-0')
  expect(reads.filter(({ path, bytes }) => path === join(codexRoot, 'large-0', 'spritesheet.webp') && bytes > 12)).toHaveLength(2)
})
