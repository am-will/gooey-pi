import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebugLogger } from 'builder-util'
import type { Configuration, PlatformSpecificBuildOptions } from 'app-builder-lib'
import type { FileMatcher } from 'app-builder-lib/out/fileMatcher'
import { doMergeConfigs } from 'app-builder-lib/out/util/config/config'
import { describe, expect, it } from 'vitest'

// This shipped builder function lacks a declaration, so describe its exercised inputs here.
const { getMainFileMatchers } = createRequire(import.meta.url)('app-builder-lib/out/fileMatcher.js') as {
  getMainFileMatchers(
    appDir: string,
    destination: string,
    expand: (pattern: string) => string,
    platformOptions: PlatformSpecificBuildOptions,
    packager: { info: { projectDir: string; buildResourcesDir: string; config: Configuration; debugLogger: DebugLogger } },
    output: string,
    electronCompile: boolean,
  ): FileMatcher[]
}
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as { build: Configuration }
const fileStat = statSync(packagePath)
const directoryStat = statSync(dirname(packagePath))

describe('normalized electron-builder application inputs', () => {
  it.each(['mac', 'linux', 'win'] as const)('keeps %s inputs inside the compiled runtime allowlist', (platform) => {
    const appDir = resolve('fixture-app')
    // Real builder normalization converts the shared root globs into a FileSet.
    // The platform strings form another matcher; a negative-only matcher defaults to **/*.
    const config = doMergeConfigs([structuredClone(packageJson.build)])
    const matchers = getMainFileMatchers(appDir, join(appDir, 'destination'), (pattern) => pattern,
      config[platform] ?? {}, { info: { projectDir: appDir, buildResourcesDir: 'build', config, debugLogger: new DebugLogger(false) } }, join(appDir, 'release'), false)
    const filters = matchers.map((matcher) => matcher.createFilter())
    const included = (path: string, directory = false) => filters.some((filter) => filter(join(appDir, path), directory ? directoryStat : fileStat))
    for (const path of ['out/main/index.js', 'out/main/lazy-service.js', 'out/preload/index.js', 'out/renderer/index.html', 'out/renderer/assets/app.js', 'package.json']) {
      expect(included(path), path).toBe(true)
    }
    for (const path of ['vendor/private.tgz', '.audit/local-report.json', '.agents/skills/private/SKILL.md', '.cursor/local.json', 'src/App.tsx', 'tests/private.test.ts', 'coverage/report.html', 'assets/pets/pet.webp', 'CONTRIBUTING.md', 'release/old-build.zip']) {
      expect(included(path), path).toBe(false)
    }
    expect(included('out', true)).toBe(true)
    expect(included('out/main', true)).toBe(true)
    expect(included('.audit', true)).toBe(false)
    expect(included('vendor', true)).toBe(false)
  })
})
