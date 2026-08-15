import { lstatSync, readdirSync } from 'node:fs'
import { extname, isAbsolute, posix, relative, resolve } from 'node:path'

export interface CoverageFamily {
  id: string
  root: string
  runtimeExtensions: readonly string[]
  responsibility: string
}

export interface CoverageTechnicalExclusion {
  file: string
  reason: string
  compensatingVerification: readonly string[]
}

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
  },
  {
    id: 'preload-capability-bridge',
    root: 'electron/preload',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'The isolated renderer-to-main capability surface exposed by Electron preload.',
  },
  {
    id: 'renderer-application-authority',
    root: 'src/app',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Renderer state admission, reconciliation, workspace scoping, and request routing.',
  },
  {
    id: 'renderer-safety-library',
    root: 'src/lib',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Shared validation, event reduction, command policy, annotations, and bounded rendering logic.',
  },
  {
    id: 'renderer-capability-hooks',
    root: 'src/hooks',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Renderer orchestration that invokes or revokes desktop capabilities and maintains live authority state.',
  },
  {
    id: 'release-verification',
    root: 'scripts/release',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Toolchain, packaging, artifact, dependency, extension, and cross-platform release verification.',
  },
  {
    id: 'shipped-extensions',
    root: 'assets/extensions',
    runtimeExtensions: COVERAGE_RUNTIME_EXTENSIONS,
    responsibility: 'Every first-party extension shipped as an Electron extra resource.',
  },
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
