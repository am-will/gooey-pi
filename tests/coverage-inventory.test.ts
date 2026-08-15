import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COVERAGE_FAMILIES,
  COVERAGE_RUNTIME_EXTENSIONS,
  COVERAGE_TECHNICAL_EXCLUSIONS,
  createCoverageInventory,
  type CoverageFamily,
  type CoverageTechnicalExclusion,
} from '../scripts/release/coverage-inventory'
import vitestConfig from '../vitest.config'

const temporaryDirectories: string[] = []
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const VITEST_ENTRYPOINT = resolve(PROJECT_ROOT, 'node_modules/vitest/vitest.mjs')

const REQUIRED_SAFETY_MODULES = [
  'electron/main/ipc.ts',
  'electron/main/lib/capability-bridge.ts',
  'electron/main/browser/agent-bridge.ts',
  'electron/main/collaboration/agent-bridge.ts',
  'electron/main/collaboration/message-envelope.ts',
  'electron/main/schedules/agent-bridge.ts',
  'electron/main/schedules/executor.ts',
  'electron/main/schedules/heartbeats.ts',
  'electron/main/schedules/recurrence.ts',
  'electron/main/schedules/service.ts',
  'electron/main/projects.ts',
  'electron/main/store.ts',
  'electron/main/plugins/mcp.ts',
  'electron/main/plugins/package-execution.ts',
  'electron/preload/index.ts',
  'scripts/release/verify-package.mjs',
  'scripts/release/verify-cross-platform-package.mjs',
] as const

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('safety-critical coverage inventory', () => {
  it('drives Vitest from broad first-party families without weakening thresholds', () => {
    const inventory = createCoverageInventory(PROJECT_ROOT)
    const config = vitestConfig as {
      root?: string
      test?: {
        coverage?: {
          include?: string[]
          exclude?: string[]
          reporter?: string[]
          thresholds?: { statements?: number; branches?: number; functions?: number; lines?: number }
        }
      }
    }

    expect(COVERAGE_FAMILIES.map(({ root }) => root)).toEqual(['electron/main', 'electron/preload', 'src/app', 'src/lib', 'src/hooks', 'scripts/release', 'assets/extensions'])
    expect(COVERAGE_RUNTIME_EXTENSIONS).toEqual(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
    expect(COVERAGE_FAMILIES.every(({ runtimeExtensions }) => COVERAGE_RUNTIME_EXTENSIONS.every((extension) => runtimeExtensions.includes(extension)))).toBe(true)
    expect(config.test?.coverage?.include).toEqual(inventory.includePatterns)
    expect(config.root).toBe(PROJECT_ROOT)
    expect(config.test?.coverage?.exclude).toBeUndefined()
    expect(config.test?.coverage?.reporter).toEqual(['text', 'html', 'json-summary'])
    expect((JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts['test:coverage']).toBe('vitest run --coverage')
    expect(config.test?.coverage?.thresholds).toEqual({
      statements: 65,
      branches: 50,
      functions: 70,
      lines: 75,
    })
    expect(inventory.includedFiles).toEqual(expect.arrayContaining([...REQUIRED_SAFETY_MODULES]))
  })

  it('automatically includes every shipped extension and every new runtime file in a covered family', () => {
    const inventory = createCoverageInventory(PROJECT_ROOT)
    const shippedExtensions = inventory.includedFiles.filter((file) => file.startsWith('assets/extensions/'))
    expect(shippedExtensions).toEqual([
      'assets/extensions/omp-work-ask-user.ts',
      'assets/extensions/omp-work-browser.ts',
      'assets/extensions/omp-work-collaboration.ts',
      'assets/extensions/omp-work-schedules.ts',
      'assets/extensions/pi-work-fast-mode.ts',
      'assets/extensions/prime-work-browser.ts',
    ])

    const projectRoot = mkdtempSync(join(tmpdir(), 'gooeypi-coverage-inventory-'))
    temporaryDirectories.push(projectRoot)
    mkdirSync(join(projectRoot, 'production', 'nested'), { recursive: true })
    writeFileSync(join(projectRoot, 'production', 'existing.ts'), 'export const existing = true\n')
    writeFileSync(join(projectRoot, 'production', 'notes.md'), 'not runtime code\n')

    const families: readonly CoverageFamily[] = [
      {
        id: 'fixture-runtime',
        root: 'production',
        runtimeExtensions: ['.ts'],
        responsibility: 'Fixture safety authority.',
      },
    ]
    expect(createCoverageInventory(projectRoot, { families, exclusions: [] }).includedFiles).toEqual(['production/existing.ts'])

    writeFileSync(join(projectRoot, 'production', 'nested', 'new-authority.ts'), 'export const authority = true\n')
    expect(createCoverageInventory(projectRoot, { families, exclusions: [] }).includedFiles).toEqual(['production/existing.ts', 'production/nested/new-authority.ts'])
  })

  it('rejects a family root that is a symbolic link or not a real directory', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gooeypi-coverage-family-root-'))
    temporaryDirectories.push(projectRoot)
    mkdirSync(join(projectRoot, 'real-production'))
    writeFileSync(join(projectRoot, 'real-production', 'authority.ts'), 'export const authority = true\n')
    symlinkSync(join(projectRoot, 'real-production'), join(projectRoot, 'linked-production'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(projectRoot, 'not-a-directory'), 'not a directory\n')

    const family = (root: string): CoverageFamily => ({
      id: 'fixture-runtime',
      root,
      runtimeExtensions: ['.ts'],
      responsibility: 'Fixture safety authority.',
    })

    expect(() => createCoverageInventory(projectRoot, { families: [family('linked-production')], exclusions: [] })).toThrow(/family root must be a real directory/)
    expect(() => createCoverageInventory(projectRoot, { families: [family('not-a-directory')], exclusions: [] })).toThrow(/family root must be a real directory/)
  })

  it('loads the explicit repository config coherently from another working directory', () => {
    const foreignWorkingDirectory = mkdtempSync(join(tmpdir(), 'gooeypi-coverage-config-cwd-'))
    temporaryDirectories.push(foreignWorkingDirectory)
    const result = spawnSync(
      process.execPath,
      [VITEST_ENTRYPOINT, 'run', '--config', join(PROJECT_ROOT, 'vitest.config.ts'), 'tests/fixtures/explicit-config-cwd.test.ts'],
      { cwd: foreignWorkingDirectory, encoding: 'utf8', timeout: 60_000 },
    )

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  })

  it('measures unexecuted inventoried files whose legal names contain glob metacharacters', () => {
    const foreignWorkingDirectory = mkdtempSync(join(tmpdir(), 'gooeypi-coverage-glob-cwd-'))
    temporaryDirectories.push(foreignWorkingDirectory)
    const reportsDirectory = join(foreignWorkingDirectory, 'coverage')
    const result = spawnSync(
      process.execPath,
      [VITEST_ENTRYPOINT, 'run', '--coverage', '--config', join(PROJECT_ROOT, 'tests/fixtures/coverage-glob-project/vitest.config.ts')],
      {
        cwd: foreignWorkingDirectory,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, GOOEYPI_COVERAGE_FIXTURE_REPORTS: reportsDirectory },
      },
    )

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const summary = JSON.parse(readFileSync(join(reportsDirectory, 'coverage-summary.json'), 'utf8')) as Record<string, unknown>
    const measuredFiles = Object.keys(summary).map((file) => file.replaceAll('\\', '/'))
    for (const file of ['@(authority).ts', '{authority,other}.ts', 'authority[.].ts']) {
      expect(measuredFiles.some((measuredFile) => measuredFile.endsWith(`/src/${file}`)), file).toBe(true)
    }
  })

  it('keeps technical exclusions exact, documented, and backed by compensating verification', () => {
    expect(COVERAGE_TECHNICAL_EXCLUSIONS).toEqual([])
    for (const exclusion of COVERAGE_TECHNICAL_EXCLUSIONS) {
      expect(exclusion.reason.length).toBeGreaterThan(40)
      expect(exclusion.compensatingVerification.length).toBeGreaterThanOrEqual(2)
      expect(exclusion.compensatingVerification.every((verification) => verification.length > 0)).toBe(true)
    }
  })

  it('fails closed for undocumented, duplicate, or stale exclusions', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'gooeypi-coverage-exclusions-'))
    temporaryDirectories.push(projectRoot)
    mkdirSync(join(projectRoot, 'production'))
    writeFileSync(join(projectRoot, 'production', 'authority.ts'), 'export const authority = true\n')
    const families: readonly CoverageFamily[] = [
      {
        id: 'fixture-runtime',
        root: 'production',
        runtimeExtensions: ['.ts'],
        responsibility: 'Fixture safety authority.',
      },
    ]
    const documented: CoverageTechnicalExclusion = {
      file: 'production/authority.ts',
      reason: 'This fixture represents a process entrypoint that cannot run in the unit-test process.',
      compensatingVerification: ['tests/entrypoint.test.ts', 'npm run build:bundle'],
    }

    expect(() =>
      createCoverageInventory(projectRoot, {
        families,
        exclusions: [{ ...documented, reason: '' }],
      }),
    ).toThrow(/documented technical reason/)
    expect(() =>
      createCoverageInventory(projectRoot, {
        families,
        exclusions: [{ ...documented, compensatingVerification: [] }],
      }),
    ).toThrow(/compensating verification/)
    expect(() => createCoverageInventory(projectRoot, { families, exclusions: [documented, documented] })).toThrow(/duplicate coverage exclusion/)
    expect(() =>
      createCoverageInventory(projectRoot, {
        families,
        exclusions: [{ ...documented, file: 'production/removed.ts' }],
      }),
    ).toThrow(/does not match a runtime file/)
  })
})
