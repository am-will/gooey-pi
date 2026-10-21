import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
import { PetService } from '../../electron/main/pets'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gooeypi-pets-'))
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
  expect((await service.list()).map((pet) => pet.id)).toEqual(['orb', 'gooey-pi', 'codex/first'])
  expect(vi.mocked(readFile).mock.calls.some(([path]) => String(path).endsWith('spritesheet.webp'))).toBe(false)
  for (const id of ['codex/duplicate-gooey', 'codex/second', 'codex/invalid', 'codex/large', 'codex/linked']) await expect(service.sprite(id)).resolves.toBeNull()
})
