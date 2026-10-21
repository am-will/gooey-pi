import { lstatSync, readdirSync } from 'node:fs'
import { extname, isAbsolute, posix, relative, resolve } from 'node:path'

export interface CoverageFamilyThresholds {
  statements: number
  branches: number
  functions: number
  lines: number
}

export interface CoverageFamily {
  id: string
  root: string
  runtimeExtensions: readonly string[]
  responsibility: string
  thresholds: CoverageFamilyThresholds
}

export interface CoverageTechnicalExclusion {
  file: string
  reason: string
  compensatingVerification: readonly string[]
}

export type SafetyModuleCoverage =
  | { kind: 'measured'; file: string; thresholds: CoverageFamilyThresholds }
  | { kind: 'worker-compensated'; file: string; reason: string; compensatingVerification: readonly string[] }

interface CoverageInventoryOptions {
  families?: readonly CoverageFamily[]
  exclusions?: readonly CoverageTechnicalExclusion[]
}

export interface CoverageInventory {
  includedFiles: string[]
  includePatterns: string[]
  excludedFiles: string[]
  filesByFamily: Readonly<Record<string, readonly string[]>>
}

export const COVERAGE_RUNTIME_EXTENSIONS = Object.freeze(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const)

export const COVERAGE_FAMILIES: readonly CoverageFamily[] = Object.freeze([
  {
    id: 'main-process-authority',
    root: 'electron/main',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Electron IPC, capability brokers, collaboration, schedules, project/store authority, package execution, MCP policy, and process composition.',
    thresholds: { statements: 84, branches: 79, functions: 83, lines: 89 },
  },
  {
    id: 'preload-capability-bridge',
    root: 'electron/preload',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'The isolated renderer-to-main capability surface exposed by Electron preload.',
    thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
  {
    id: 'renderer-application-authority',
    root: 'src/app',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Renderer state admission, reconciliation, workspace scoping, and request routing.',
    thresholds: { statements: 94, branches: 88, functions: 98, lines: 97 },
  },
  {
    id: 'renderer-safety-library',
    root: 'src/lib',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Shared validation, event reduction, command policy, annotations, and bounded rendering logic.',
    thresholds: { statements: 94, branches: 90, functions: 96, lines: 95 },
  },
  {
    id: 'renderer-capability-hooks',
    root: 'src/hooks',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Renderer orchestration that invokes or revokes desktop capabilities and maintains live authority state.',
    thresholds: { statements: 77, branches: 70, functions: 78, lines: 83 },
  },
  {
    id: 'release-verification',
    root: 'scripts/release',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Toolchain, packaging, artifact, dependency, extension, and cross-platform release verification.',
    thresholds: { statements: 70, branches: 68, functions: 82, lines: 73 },
  },
  {
    id: 'shipped-extensions',
    root: 'assets/extensions',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Every first-party extension shipped as an Electron extra resource.',
    thresholds: { statements: 71, branches: 54, functions: 64, lines: 74 },
  },
])

// Measured at c8ef035; branch margin is 5 points, other metrics 2.
export const REQUIRED_SAFETY_COVERAGE: readonly SafetyModuleCoverage[] = Object.freeze([
  { kind: 'measured', file: 'electron/main/ipc.ts', thresholds: { statements: 83, branches: 81, functions: 62, lines: 95 } },
  { kind: 'measured', file: 'electron/main/agent-rpc/manager.ts', thresholds: { statements: 87, branches: 78, functions: 86, lines: 92 } },
  { kind: 'measured', file: 'electron/main/subagents.ts', thresholds: { statements: 84, branches: 80, functions: 98, lines: 91 } },
  { kind: 'measured', file: 'electron/main/lib/capability-bridge.ts', thresholds: { statements: 90, branches: 83, functions: 90, lines: 98 } },
  { kind: 'measured', file: 'electron/main/browser/agent-bridge.ts', thresholds: { statements: 80, branches: 71, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/collaboration/agent-bridge.ts', thresholds: { statements: 89, branches: 76, functions: 87, lines: 93 } },
  { kind: 'measured', file: 'electron/main/collaboration/message-envelope.ts', thresholds: { statements: 80, branches: 76, functions: 98, lines: 94 } },
  { kind: 'measured', file: 'electron/main/schedules/agent-bridge.ts', thresholds: { statements: 87, branches: 78, functions: 98, lines: 95 } },
  { kind: 'measured', file: 'electron/main/schedules/executor.ts', thresholds: { statements: 70, branches: 56, functions: 79, lines: 76 } },
  { kind: 'measured', file: 'electron/main/schedules/heartbeats.ts', thresholds: { statements: 85, branches: 67, functions: 82, lines: 94 } },
  { kind: 'measured', file: 'electron/main/schedules/recurrence.ts', thresholds: { statements: 92, branches: 84, functions: 94, lines: 95 } },
  { kind: 'measured', file: 'electron/main/schedules/service.ts', thresholds: { statements: 86, branches: 73, functions: 91, lines: 96 } },
  { kind: 'measured', file: 'electron/main/projects.ts', thresholds: { statements: 85, branches: 73, functions: 87, lines: 91 } },
  { kind: 'measured', file: 'electron/main/projects/folder-identity.ts', thresholds: { statements: 85, branches: 80, functions: 88, lines: 93 } },
  { kind: 'measured', file: 'electron/main/projects/records.ts', thresholds: { statements: 98, branches: 70, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/projects/session-roots.ts', thresholds: { statements: 98, branches: 95, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/projects/worktrees.ts', thresholds: { statements: 86, branches: 70, functions: 98, lines: 95 } },
  { kind: 'measured', file: 'electron/main/store.ts', thresholds: { statements: 94, branches: 82, functions: 98, lines: 96 } },
  { kind: 'measured', file: 'electron/main/store/durable-file.ts', thresholds: { statements: 95, branches: 82, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/store/legacy-migration.ts', thresholds: { statements: 73, branches: 50, functions: 98, lines: 81 } },
  { kind: 'measured', file: 'electron/main/store/settings-schema.ts', thresholds: { statements: 98, branches: 90, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/store/state-schema.ts', thresholds: { statements: 96, branches: 93, functions: 98, lines: 96 } },
  { kind: 'measured', file: 'electron/main/capability-runtime.ts', thresholds: { statements: 98, branches: 83, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/renderer-security.ts', thresholds: { statements: 82, branches: 68, functions: 78, lines: 85 } },
  { kind: 'measured', file: 'electron/main/renderer-navigation.ts', thresholds: { statements: 98, branches: 73, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/renderer-recovery.ts', thresholds: { statements: 98, branches: 95, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/main-window.ts', thresholds: { statements: 59, branches: 53, functions: 49, lines: 64 } },
  { kind: 'measured', file: 'electron/main/app-lifecycle.ts', thresholds: { statements: 94, branches: 86, functions: 90, lines: 98 } },
  { kind: 'measured', file: 'electron/main/browser/project-cleanup.ts', thresholds: { statements: 98, branches: 95, functions: 98, lines: 98 } },
  { kind: 'measured', file: 'electron/main/schedules/recurrence-evaluator.ts', thresholds: { statements: 80, branches: 70, functions: 82, lines: 86 } },
  {
    kind: 'worker-compensated',
    file: 'electron/main/schedules/recurrence-worker.ts',
    reason: 'The real isolated worker executes outside parent-process V8 collection. Keep its source in the denominator and verify bounded execution and recovery through the actual worker fixture.',
    compensatingVerification: ['tests/backend/recurrence-evaluator.test.ts', 'tests/helpers/recurrence-worker.ts'],
  },
  { kind: 'measured', file: 'electron/main/plugins/mcp.ts', thresholds: { statements: 81, branches: 77, functions: 90, lines: 90 } },
  { kind: 'measured', file: 'electron/main/plugins/package-execution.ts', thresholds: { statements: 91, branches: 88, functions: 88, lines: 93 } },
  { kind: 'measured', file: 'electron/preload/index.ts', thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 } },
  { kind: 'measured', file: 'scripts/release/verify-package.mjs', thresholds: { statements: 41, branches: 40, functions: 51, lines: 44 } },
  { kind: 'measured', file: 'scripts/release/verify-cross-platform-package.mjs', thresholds: { statements: 50, branches: 49, functions: 67, lines: 51 } },
])

// There are intentionally no current exclusions. Any future entry must name one
// exact runtime file and satisfy the validation below; directory or glob
// exclusions are not representable by this policy.
export const COVERAGE_TECHNICAL_EXCLUSIONS: readonly CoverageTechnicalExclusion[] = Object.freeze([])

// Vitest treats coverage.include values as tinyglobby/picomatch patterns even
// when they name one concrete file. Escape every POSIX glob operator while
// preserving repository-relative `/` separators so legal filenames cannot
// expand to a sibling or silently disappear from the denominator.
const UNESCAPED_COVERAGE_GLOB_SYMBOLS = /(?<!\\)([()[\]{}*?|]|^!|[!+@](?=\()|\\(?![()[\]{}!*+?@|]))/g

function escapeCoverageIncludePath(file: string): string {
  return file.replace(UNESCAPED_COVERAGE_GLOB_SYMBOLS, '\\$&')
}

function normalizeRepositoryPath(value: string, label: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (!normalized || isAbsolute(value) || posix.isAbsolute(normalized) || normalized !== posix.normalize(normalized) || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`${label} must be a normalized repository-relative path`)
  }
  return normalized
}

function collectRuntimeFiles(projectRoot: string, family: CoverageFamily): string[] {
  const familyRoot = normalizeRepositoryPath(family.root, `coverage family ${family.id} root`)
  if (!family.id.trim()) throw new Error('coverage family id must not be empty')
  if (!family.responsibility.trim()) throw new Error(`coverage family ${family.id} must document its safety responsibility`)
  if (family.runtimeExtensions.length === 0 || family.runtimeExtensions.some((extension) => !/^\.[a-z0-9]+$/i.test(extension))) {
    throw new Error(`coverage family ${family.id} must declare runtime file extensions`)
  }
  const thresholdValues = [family.thresholds.statements, family.thresholds.branches, family.thresholds.functions, family.thresholds.lines]
  if (thresholdValues.some((value) => !Number.isInteger(value) || value < 1 || value > 100)) {
    throw new Error(`coverage family ${family.id} must declare integer coverage thresholds between 1 and 100`)
  }

  const absoluteProjectRoot = resolve(projectRoot)
  const absoluteFamilyRoot = resolve(absoluteProjectRoot, familyRoot)
  const relativeFamilyRoot = relative(absoluteProjectRoot, absoluteFamilyRoot)
  if (relativeFamilyRoot.startsWith('..') || isAbsolute(relativeFamilyRoot)) throw new Error(`coverage family ${family.id} escapes the project root`)

  let familyRootStats: ReturnType<typeof lstatSync>
  try {
    familyRootStats = lstatSync(absoluteFamilyRoot)
  } catch (error) {
    throw new Error(`coverage family root must be a real directory: ${family.id} (${familyRoot})`, { cause: error })
  }
  if (familyRootStats.isSymbolicLink() || !familyRootStats.isDirectory()) {
    throw new Error(`coverage family root must be a real directory: ${family.id} (${familyRoot})`)
  }

  const runtimeExtensions = new Set(family.runtimeExtensions)
  const files: string[] = []
  const visit = (absoluteDirectory: string, repositoryDirectory: string): void => {
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const repositoryPath = posix.join(repositoryDirectory, entry.name)
      const absolutePath = resolve(absoluteDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`coverage family ${family.id} contains an unsupported symbolic link: ${repositoryPath}`)
      if (entry.isDirectory()) {
        visit(absolutePath, repositoryPath)
      } else if (entry.isFile() && runtimeExtensions.has(extname(entry.name))) {
        files.push(repositoryPath)
      }
    }
  }
  visit(absoluteFamilyRoot, familyRoot)
  return files.sort()
}

export function familyCoverageThresholds(families: readonly CoverageFamily[] = COVERAGE_FAMILIES): Record<string, CoverageFamilyThresholds> {
  const thresholds: Record<string, CoverageFamilyThresholds> = {}
  for (const family of families) {
    const familyRoot = normalizeRepositoryPath(family.root, `coverage family ${family.id} root`)
    const pattern = `${familyRoot}/**`
    if (pattern in thresholds) throw new Error(`duplicate coverage family root: ${familyRoot}`)
    thresholds[pattern] = { ...family.thresholds }
  }
  return thresholds
}

/** Exact-file floors overlap family/global gates without removing any measured file. */
export function safetyCoverageThresholds(modules: readonly SafetyModuleCoverage[], inventory: CoverageInventory): Record<string, CoverageFamilyThresholds> {
  const included = new Set(inventory.includedFiles)
  const classified = new Set<string>()
  const thresholds: Record<string, CoverageFamilyThresholds> = {}
  for (const module of modules) {
    const file = normalizeRepositoryPath(module.file, 'safety coverage file')
    if (classified.has(file)) throw new Error(`duplicate safety coverage classification: ${file}`)
    if (!included.has(file)) throw new Error(`safety coverage file must remain included: ${file}`)
    classified.add(file)
    if (module.kind === 'worker-compensated') {
      if (module.reason.trim().length < 40 || module.compensatingVerification.length === 0 || module.compensatingVerification.some((value) => !value.trim())) {
        throw new Error(`worker coverage ${file} requires a reason and compensating verification`)
      }
      continue
    }
    for (const metric of ['statements', 'branches', 'functions', 'lines'] as const) {
      const value = module.thresholds[metric]
      if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`safety coverage ${file} requires a positive integer percentage for ${metric}`)
    }
    thresholds[escapeCoverageIncludePath(file)] = { ...module.thresholds }
  }
  return thresholds
}

export function createCoverageInventory(projectRoot = process.cwd(), options: CoverageInventoryOptions = {}): CoverageInventory {
  const families = options.families ?? COVERAGE_FAMILIES
  const exclusions = options.exclusions ?? COVERAGE_TECHNICAL_EXCLUSIONS
  const familyIds = new Set<string>()
  const discoveredFiles = new Set<string>()
  const filesByFamily: Record<string, readonly string[]> = {}

  for (const family of families) {
    if (familyIds.has(family.id)) throw new Error(`duplicate coverage family id: ${family.id}`)
    familyIds.add(family.id)
    const files = collectRuntimeFiles(projectRoot, family)
    for (const file of files) {
      if (discoveredFiles.has(file)) throw new Error(`coverage families overlap at runtime file: ${file}`)
      discoveredFiles.add(file)
    }
    filesByFamily[family.id] = files
  }

  const excludedFiles = new Set<string>()
  for (const exclusion of exclusions) {
    const file = normalizeRepositoryPath(exclusion.file, 'coverage exclusion file')
    if (excludedFiles.has(file)) throw new Error(`duplicate coverage exclusion: ${file}`)
    if (!exclusion.reason.trim() || exclusion.reason.trim().length < 40) {
      throw new Error(`coverage exclusion ${file} requires a documented technical reason`)
    }
    if (exclusion.compensatingVerification.length === 0 || exclusion.compensatingVerification.some((verification) => !verification.trim())) {
      throw new Error(`coverage exclusion ${file} requires compensating verification`)
    }
    if (!discoveredFiles.has(file)) throw new Error(`coverage exclusion ${file} does not match a runtime file in a covered family`)
    excludedFiles.add(file)
  }

  const includedFiles = [...discoveredFiles].filter((file) => !excludedFiles.has(file)).sort()
  return {
    includedFiles,
    includePatterns: includedFiles.map(escapeCoverageIncludePath),
    excludedFiles: [...excludedFiles].sort(),
    filesByFamily: Object.freeze(filesByFamily),
  }
}
