import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ session: { fromPartition: vi.fn(), defaultSession: {} } }))

import { SettingsService } from '../../electron/main/settings-schedules'
import { defaultSettings, JsonStateStore } from '../../electron/main/store'
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

describe('legacy telemetry compatibility contract', () => {
  it('keeps the legacy preference default-off', () => {
    expect(defaultSettings().telemetry).toBe(false)
  })

  it.each(HARNESS_IDS)('defaults an absent legacy preference off for selected agent $harness', (harness) => {
    const statePath = temporaryStatePath()
    writeFileSync(statePath, JSON.stringify({ version: 4, settings: { activeHarness: harness } }))

    expect(new JsonStateStore(statePath).snapshot().settings).toMatchObject({ activeHarness: harness, telemetry: false })
  })

  it.each(HARNESS_TELEMETRY_CASES)('parses telemetry=$telemetry for selected agent $harness', ({ harness, telemetry }) => {
    const statePath = temporaryStatePath()
    writeFileSync(statePath, JSON.stringify({ version: 4, settings: { activeHarness: harness, telemetry } }))

    expect(new JsonStateStore(statePath).snapshot().settings).toMatchObject({ activeHarness: harness, telemetry })
  })

  it.each(HARNESS_TELEMETRY_CASES)('durably persists telemetry=$telemetry for selected agent $harness', async ({ harness, telemetry }) => {
    const statePath = temporaryStatePath()
    const store = new JsonStateStore(statePath)
    const settings = new SettingsService(store, () => '/bin/zsh')
    await settings.update({ activeHarness: harness, telemetry })
    await store.beginShutdown()

    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { settings: { activeHarness: HarnessId; telemetry: boolean } }
    expect(persisted.settings).toMatchObject({ activeHarness: harness, telemetry })
    expect(new JsonStateStore(statePath).snapshot().settings).toMatchObject({ activeHarness: harness, telemetry })
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
      { file: 'electron/main/settings-schedules.ts', source: "telemetry: (value) => requireBoolean(value, 'telemetry')," },
      { file: 'electron/main/store.ts', source: 'telemetry: false,' },
      { file: 'electron/main/store.ts', source: "telemetry: typeof value.telemetry === 'boolean' ? value.telemetry : defaults.telemetry," },
      { file: 'src/lib/data.ts', source: 'telemetry: false,' },
      { file: 'src/pages/settings/contracts.ts', source: "telemetry: 'privacy'," },
      { file: 'src/types/api.ts', source: 'telemetry: boolean' },
    ])
  })
})
