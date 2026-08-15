import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { createCoverageInventory, type CoverageFamily } from '../../../scripts/release/coverage-inventory'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const reportsDirectory = process.env.GOOEYPI_COVERAGE_FIXTURE_REPORTS
if (!reportsDirectory) throw new Error('GOOEYPI_COVERAGE_FIXTURE_REPORTS is required')

const families: readonly CoverageFamily[] = [
  {
    id: 'glob-fixture',
    root: 'src',
    runtimeExtensions: ['.ts'],
    responsibility: 'Fixture safety authority.',
  },
]
const inventory = createCoverageInventory(projectRoot, { families, exclusions: [] })

export default defineConfig({
  root: projectRoot,
  test: {
    include: ['probe.spec.ts'],
    coverage: {
      provider: 'v8',
      include: inventory.includePatterns,
      reporter: ['json-summary'],
      reportsDirectory,
    },
  },
})
