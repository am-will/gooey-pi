import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { safetyCoverageThresholds, type CoverageInventory, type SafetyModuleCoverage } from '../scripts/release/coverage-inventory'

const inventory: CoverageInventory = {
  includedFiles: ['authority.ts', 'worker.ts', 'authority[.].ts'], includePatterns: [], excludedFiles: [], filesByFamily: {},
}
const measured: SafetyModuleCoverage = { kind: 'measured', file: 'authority.ts', thresholds: { statements: 80, branches: 65, functions: 85, lines: 90 } }
const worker: SafetyModuleCoverage = { kind: 'worker-compensated', file: 'worker.ts', reason: 'The actual isolated worker executes outside parent-process V8 coverage collection.', compensatingVerification: ['tests/worker-execution.test.ts'] }

describe('required safety-module threshold classification', () => {
  it('derives exact-file gates while keeping compensated workers in the denominator', () => {
    const before = structuredClone(inventory)
    expect(safetyCoverageThresholds([measured, worker], inventory)).toEqual({ 'authority.ts': measured.thresholds })
    expect(inventory).toEqual(before)
    expect(inventory.includedFiles).toContain('worker.ts')
    expect(inventory.excludedFiles).toEqual([])
  })
  it('escapes legal glob characters in exact module paths', () => {
    expect(safetyCoverageThresholds([{ ...measured, file: 'authority[.].ts' }], inventory)).toEqual({ 'authority\\[.\\].ts': measured.thresholds })
  })
  it('rejects duplicate and stale classifications', () => {
    expect(() => safetyCoverageThresholds([measured, measured], inventory)).toThrow('duplicate safety coverage')
    expect(() => safetyCoverageThresholds([{ ...measured, file: 'removed.ts' }], inventory)).toThrow('must remain included')
    expect(() => safetyCoverageThresholds([{ ...worker, file: 'removed.ts' }], inventory)).toThrow('must remain included')
  })
  it.each([0, -1, 101, 50.5, NaN])('rejects an invalid or ineffective measured floor %s', (lines) => {
    expect(() => safetyCoverageThresholds([{ ...measured, thresholds: { ...measured.thresholds, lines } }], inventory)).toThrow('positive integer percentage')
  })
  it('requires a substantive worker reason and compensating proof', () => {
    expect(() => safetyCoverageThresholds([{ ...worker, reason: '' }], inventory)).toThrow('requires a reason')
    expect(() => safetyCoverageThresholds([{ ...worker, compensatingVerification: [] }], inventory)).toThrow('compensating verification')
    expect(() => safetyCoverageThresholds([{ ...worker, compensatingVerification: [''] }], inventory)).toThrow('compensating verification')
  })
})

it('enforces exact-file floors without subtracting files from family or global summaries', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-safety-floor-'))
  try {
    for (const fail of [false, true]) {
      const reports = join(directory, fail ? 'fail' : 'pass')
      const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--coverage', '--config', join(root, 'tests/fixtures/safety-threshold-project/vitest.config.ts')], {
        cwd: directory, encoding: 'utf8', timeout: 60_000,
        env: { ...process.env, GOOEYPI_COVERAGE_FIXTURE_REPORTS: reports, GOOEYPI_COVERAGE_FIXTURE_FAIL: fail ? '1' : '0' },
      })
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(fail ? 1 : 0)
      const summary = JSON.parse(readFileSync(join(reports, 'coverage-summary.json'), 'utf8')) as Record<string, { lines: { total: number; covered: number; pct: number } }>
      expect(summary.total.lines).toMatchObject({ total: 2, covered: 1, pct: 50 })
      expect(Object.keys(summary).some((file) => file.replaceAll('\\', '/').endsWith('/src/uncovered.ts'))).toBe(true)
      if (fail) {
        expect(result.stderr).toContain('"src/uncovered.ts" threshold (1%)')
        expect(result.stderr).not.toContain('global threshold')
        expect(result.stderr).not.toContain('"src/**" threshold')
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
