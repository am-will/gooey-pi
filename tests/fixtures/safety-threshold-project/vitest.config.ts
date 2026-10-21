import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { createCoverageInventory, familyCoverageThresholds, safetyCoverageThresholds, type CoverageFamily, type SafetyModuleCoverage } from '../../../scripts/release/coverage-inventory'

const root = fileURLToPath(new URL('.', import.meta.url))
const reportsDirectory = process.env.GOOEYPI_COVERAGE_FIXTURE_REPORTS
if (!reportsDirectory) throw new Error('GOOEYPI_COVERAGE_FIXTURE_REPORTS is required')
const families: readonly CoverageFamily[] = [{ id: 'fixture', root: 'src', runtimeExtensions: ['.ts'], responsibility: 'Real overlapping threshold fixture.', thresholds: { statements: 40, branches: 40, functions: 40, lines: 40 } }]
const inventory = createCoverageInventory(root, { families, exclusions: [] })
const modules: SafetyModuleCoverage[] = [{ kind: 'measured', file: 'src/covered.ts', thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } }]
if (process.env.GOOEYPI_COVERAGE_FIXTURE_FAIL === '1') modules.push({ kind: 'measured', file: 'src/uncovered.ts', thresholds: { statements: 1, branches: 1, functions: 1, lines: 1 } })
export default defineConfig({
  root,
  test: {
    include: ['probe.spec.ts'], maxWorkers: 1,
    coverage: {
      provider: 'v8', include: inventory.includePatterns, reporter: ['json-summary'], reportsDirectory,
      thresholds: { lines: 40, ...familyCoverageThresholds(families), ...safetyCoverageThresholds(modules, inventory) },
    },
  },
})
