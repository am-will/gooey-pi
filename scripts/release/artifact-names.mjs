import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const localRequire = createRequire(import.meta.url)
// Resolve builder-util through electron-builder so `${arch}` expands with the
// exact rules of the packaging toolchain that produces the artifacts, instead
// of a second hand-maintained copy of those rules. electron-builder is a dev
// dependency, so this module is only usable in the repository checkout (tests
// and local tooling) - never from the privileged publish job.
const builderRequire = createRequire(localRequire.resolve('electron-builder/package.json'))
const { archFromString, getArtifactArchName } = builderRequire('builder-util')

/** electron-builder target name to the artifact extension its `${ext}` macro expands to. */
export const TARGET_EXTENSIONS = Object.freeze({
  dmg: 'dmg',
  zip: 'zip',
  AppImage: 'AppImage',
  deb: 'deb',
  rpm: 'rpm',
  pacman: 'pacman',
  nsis: 'exe',
})

/** Platform/architecture legs the release workflow packages; mirrors the release.yml build matrices. */
export const RELEASE_BUILD_MATRIX = Object.freeze({
  mac: Object.freeze(['arm64', 'x64']),
  linux: Object.freeze(['arm64', 'x64']),
  win: Object.freeze(['x64']),
})

export function readElectronBuilderConfig(projectDirectory = process.cwd()) {
  const packageJson = JSON.parse(readFileSync(resolve(projectDirectory, 'package.json'), 'utf8'))
  if (!packageJson.build || typeof packageJson.build !== 'object') throw new Error('package.json has no electron-builder build configuration')
  return packageJson.build
}

export function expandArtifactName(template, values) {
  return template.replace(/\$\{([A-Za-z]+)\}/g, (macro, name) => {
    const value = values[name]
    if (value === undefined) throw new Error(`Unsupported artifactName macro for release asset naming: ${macro}`)
    return value
  })
}

/** The artifact filenames electron-builder produces for one platform/architecture leg. */
export function producedArtifactNames(config, version, platform, architecture) {
  const platformConfig = config[platform]
  if (!platformConfig) throw new Error(`electron-builder configuration has no ${platform} platform`)
  const template = platformConfig.artifactName ?? config.artifactName
  if (!template) throw new Error(`electron-builder configuration has no ${platform} artifactName`)
  const targets = platformConfig.target
  if (!Array.isArray(targets) || !targets.length) throw new Error(`electron-builder configuration has no ${platform} targets`)
  return targets.map((target) => {
    const ext = TARGET_EXTENSIONS[target]
    if (!ext) throw new Error(`Unknown electron-builder target for release asset naming: ${platform}/${target}`)
    return expandArtifactName(template, {
      productName: config.productName,
      version,
      ext,
      arch: getArtifactArchName(archFromString(architecture), target),
    })
  })
}

/** Every artifact filename the release build matrix produces for the given platforms. */
export function producedReleaseArtifactNames(config, version, platforms = Object.keys(RELEASE_BUILD_MATRIX), matrix = RELEASE_BUILD_MATRIX) {
  return platforms
    .flatMap((platform) => (matrix[platform] ?? []).flatMap((architecture) => producedArtifactNames(config, version, platform, architecture)))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}
