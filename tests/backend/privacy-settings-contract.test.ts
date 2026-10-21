import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn(), defaultSession: {} } }))

import { SettingsService } from '../../electron/main/settings'
import { defaultSettings, JsonStateStore } from '../../electron/main/store'
import { DEFAULT_SETTINGS } from '../../src/lib/default-settings'
import { HARNESS_IDS, type HarnessId } from '../../src/types/api'

const DIRECT_REFERENCE_ROOTS = ['assets/extensions', 'electron', 'src'] as const
const DIRECT_REFERENCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const TELEMETRY_VALUES = [false, true] as const
const HARNESS_TELEMETRY_CASES = HARNESS_IDS.flatMap((harness) => (
  TELEMETRY_VALUES.map((telemetry) => ({ harness, telemetry }))
)) satisfies Array<{ harness: HarnessId; telemetry: boolean }>
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function temporaryStatePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-privacy-settings-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state.json')
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && DIRECT_REFERENCE_EXTENSIONS.has(extname(entry.name)) ? [path] : []
  })
}

describe('removed legacy preferences', () => {
  it('shares persisted and renderer defaults apart from the OS shell', () => {
    expect(defaultSettings()).toEqual({ ...DEFAULT_SETTINGS, terminalShell: defaultSettings().terminalShell })
  })

  it.each(HARNESS_TELEMETRY_CASES)('drops inert fields on load and rejects new writes for $harness', async ({ harness, telemetry }) => {
    const statePath = temporaryStatePath()
    writeFileSync(statePath, JSON.stringify({ version: 4, settings: { activeHarness: harness, telemetry, enabledHarnesses: [harness] } }))
    const store = new JsonStateStore(statePath)
    expect(store.getSettings()).toMatchObject({ activeHarness: harness })
    expect(store.getSettings()).not.toHaveProperty('telemetry')
    expect(store.getSettings()).not.toHaveProperty('enabledHarnesses')
    const service = new SettingsService(store, () => '/bin/zsh')
    await expect(service.update({ telemetry })).rejects.toThrow('not supported')
    await expect(service.update({ enabledHarnesses: [harness] })).rejects.toThrow('not supported')
    await service.update({ activeHarness: harness })
    await store.beginShutdown()
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(saved.settings).not.toHaveProperty('telemetry')
    expect(saved.settings).not.toHaveProperty('enabledHarnesses')
  })

  it('matches the reviewed direct telemetry source-reference allowlist', () => {
    const references = DIRECT_REFERENCE_ROOTS
      .flatMap(sourceFiles)
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').flatMap((line) => (
        /\btelemetry\b/i.test(line)
          ? [{ file: relative(process.cwd(), file), source: line.trim() }]
          : []
      )))
      .sort((left, right) => left.file.localeCompare(right.file) || left.source.localeCompare(right.source))

    // This intentionally lexical guard scans only the roots and extensions declared above.
    // Exact equality rejects both unexpected references and stale/missing allowlist entries.
    // It does not detect computed, indirect, or aliased consumers and must not be cited as
    // semantic proof that no telemetry consumer or transport exists.
    expect(references).toStrictEqual([
      // The Rust Prime model-catalog probe sets PRIME_AGENT_TELEMETRY=0 for that internal process only.
      { file: 'electron/main/providers-prime-rust.ts', source: "// started, so it must not report usage or mark Rust's telemetry notice shown." },
    ])
  })
})
