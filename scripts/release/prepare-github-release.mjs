#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { validateReleaseTag } from './validate-release-tag.mjs'

const RELEASE_PLATFORMS = ['mac', 'linux', 'win']
const UPDATE_METADATA_BY_PLATFORM = {
  mac: ['latest-mac.yml'],
  // electron-builder gives non-x64 Linux builds an architecture-specific feed
  // name, which electron-updater selects automatically on arm64 runtimes.
  linux: ['latest-linux.yml', 'latest-linux-arm64.yml'],
  win: ['latest.yml'],
}

export function parseReleasePlatforms(value = RELEASE_PLATFORMS.join(',')) {
  const platforms = value
    .split(',')
    .map((platform) => platform.trim())
    .filter(Boolean)
  if (!platforms.length) throw new Error('At least one release platform is required')
  if (new Set(platforms).size !== platforms.length) throw new Error(`Release platforms contain duplicates: ${value}`)
  const unsupported = platforms.filter((platform) => !RELEASE_PLATFORMS.includes(platform))
  if (unsupported.length) throw new Error(`Unsupported release platforms: ${unsupported.join(', ')}`)
  return platforms
}

/**
 * The single source of truth for release asset naming: published GitHub Release
 * name to the name electron-builder produced (and CI downloaded). Only the macOS
 * DMGs are renamed for the public download page; every other asset publishes
 * under its produced name. Asset selection, the missing-asset report, and the
 * updater-feed URL rewriting are all driven by this map, so a rename that
 * reorders sorting cannot mispair entries.
 *
 * tests/release-scripts.test.ts derives the produced names from the
 * electron-builder configuration and fails when this map drifts from them.
 */
export function releaseAssetNames(version, platforms = RELEASE_PLATFORMS) {
  const assets = {
    mac: [
      [`GooeyPi-${version}-m-chip.dmg`, `GooeyPi-${version}-arm64.dmg`],
      [`GooeyPi-${version}-intel-chip.dmg`, `GooeyPi-${version}-x64.dmg`],
      [`GooeyPi-${version}-arm64.zip`],
      [`GooeyPi-${version}-x64.zip`],
    ],
    linux: [
      [`GooeyPi-${version}-linux-arm64.AppImage`],
      [`GooeyPi-${version}-linux-arm64.deb`],
      [`GooeyPi-${version}-linux-aarch64.pacman`],
      [`GooeyPi-${version}-linux-aarch64.rpm`],
      [`GooeyPi-${version}-linux-x86_64.AppImage`],
      [`GooeyPi-${version}-linux-amd64.deb`],
      [`GooeyPi-${version}-linux-x64.pacman`],
      [`GooeyPi-${version}-linux-x86_64.rpm`],
    ],
    win: [[`GooeyPi-${version}-win-x64.exe`], [`GooeyPi-${version}-win-x64.zip`]],
  }
  const entries = platforms
    .flatMap((platform) => [...assets[platform], ...UPDATE_METADATA_BY_PLATFORM[platform].map((name) => [name])])
    .map(([published, downloaded = published]) => /** @type {[string, string]} */ ([published, downloaded]))
    .sort(([left], [right]) => compareNames(left, right))
  const names = new Map(entries)
  if (names.size !== entries.length) throw new Error('Release asset names contain duplicate published names')
  if (new Set(names.values()).size !== names.size) throw new Error('Release asset names contain duplicate downloaded names')
  return names
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

export function expectedGitHubReleaseAssets(version, platforms = RELEASE_PLATFORMS) {
  return [...releaseAssetNames(version, platforms).keys()]
}

function parseUpdateMetadata(path, expectedVersion) {
  const value = load(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Update metadata is not an object: ${path}`)
  if (value.version !== expectedVersion) throw new Error(`Update metadata version does not match ${expectedVersion}: ${path}`)
  if (!Array.isArray(value.files) || !value.files.length) throw new Error(`Update metadata has no files: ${path}`)
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || typeof file.url !== 'string' || !file.url) throw new Error(`Update metadata contains an invalid file: ${path}`)
    // electron-updater downloads by size and verifies by sha512, so a missing or
    // non-positive size and an empty digest are unusable even when every
    // manifest agrees on them.
    if (typeof file.sha512 !== 'string' || !file.sha512) throw new Error(`Update metadata file ${file.url} has no sha512: ${path}`)
    if (typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size <= 0) throw new Error(`Update metadata file ${file.url} has an invalid size: ${path}`)
  }
  return value
}

// Old electron-updater clients follow the top-level legacy `path`/`sha512`
// instead of the `files` list, so those fields - and every other
// electron-builder field such as `releaseDate` - are taken from one deliberately
// chosen manifest: the one describing the primary (x64) architecture, which is
// the build a legacy client can always run. Without this rule the legacy fields
// would come from whichever artifact directory happened to sort first.
const PRIMARY_ARCHITECTURE_PATTERN = /-(?:x64|x86_64|amd64)\.[A-Za-z]+$/

function isPrimaryArchitectureAsset(url) {
  return typeof url === 'string' && PRIMARY_ARCHITECTURE_PATTERN.test(url)
}

export function mergeUpdateMetadata(paths, expectedVersion) {
  if (!paths.length) throw new Error('Update metadata is missing')
  const manifests = paths
    .slice()
    .sort(compareNames)
    .map((path) => parseUpdateMetadata(path, expectedVersion))
  const files = new Map()
  for (const manifest of manifests)
    for (const file of manifest.files) {
      const previous = files.get(file.url)
      if (previous && (previous.sha512 !== file.sha512 || previous.size !== file.size)) throw new Error(`Update metadata disagrees for ${file.url}`)
      files.set(file.url, file)
    }
  const mergedFiles = [...files.values()].sort((left, right) => compareNames(left.url, right.url))
  const primaryManifest =
    manifests.find((manifest) => isPrimaryArchitectureAsset(manifest.path)) ?? manifests.find((manifest) => manifest.files.some((file) => isPrimaryArchitectureAsset(file.url))) ?? manifests[0]
  const legacyFile = files.get(primaryManifest.path) ?? primaryManifest.files.find((file) => isPrimaryArchitectureAsset(file.url)) ?? primaryManifest.files[0]
  return {
    ...primaryManifest,
    files: mergedFiles,
    path: legacyFile.url,
    sha512: legacyFile.sha512,
  }
}

export function expectedDownloadedReleaseAssets(version, platforms = RELEASE_PLATFORMS) {
  return [...releaseAssetNames(version, platforms).values()]
}

function listFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) listFiles(path, found)
    else if (entry.isFile()) found.push(path)
    else throw new Error(`Downloaded release artifacts contain a forbidden non-file entry: ${path}`)
  }
  return found
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function prepareGitHubRelease({ inputDirectory, outputDirectory, tag, platforms = RELEASE_PLATFORMS, projectDirectory = process.cwd() }) {
  const release = validateReleaseTag(tag, projectDirectory)
  if (!existsSync(inputDirectory) || !lstatSync(inputDirectory).isDirectory()) throw new Error(`Downloaded release artifact directory does not exist: ${inputDirectory}`)
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length) throw new Error(`GitHub Release output directory must be empty: ${outputDirectory}`)
  mkdirSync(outputDirectory, { recursive: true })

  const names = releaseAssetNames(release.version, platforms)
  const downloadedNames = new Set(names.values())
  const publishedNameByDownloadedName = new Map([...names].map(([published, downloaded]) => [downloaded, published]))
  const updateMetadataNames = new Set(Object.values(UPDATE_METADATA_BY_PLATFORM).flat())
  const selected = new Map()
  const metadata = new Map()
  for (const path of listFiles(inputDirectory)) {
    const name = basename(path)
    if (!downloadedNames.has(name)) continue
    if (updateMetadataNames.has(name)) {
      const candidates = metadata.get(name) ?? []
      candidates.push(path)
      metadata.set(name, candidates)
      continue
    }
    if (selected.has(name)) throw new Error(`Downloaded release artifacts contain duplicate files named ${name}`)
    selected.set(name, path)
  }
  const missing = [...names].filter(([published, downloaded]) => !selected.has(downloaded) && !metadata.has(published)).map(([published]) => published)
  if (missing.length) throw new Error(`Downloaded release artifacts are incomplete; missing ${missing.join(', ')}`)

  const checksumLines = []
  for (const [name, downloadedName] of names) {
    const destination = join(outputDirectory, name)
    const metadataPaths = metadata.get(name)
    if (metadataPaths) {
      const manifest = mergeUpdateMetadata(metadataPaths, release.version)
      for (const file of manifest.files) {
        if (file.url !== basename(file.url) || !downloadedNames.has(file.url) || updateMetadataNames.has(file.url)) {
          throw new Error(`Update metadata references an unpublished release asset: ${file.url}`)
        }
      }
      if (manifest.path !== undefined && !downloadedNames.has(manifest.path)) {
        throw new Error(`Update metadata references an unpublished release asset: ${manifest.path}`)
      }
      // The CI artifacts retain electron-builder's architecture filenames, but
      // the public release may use clearer labels (for example, m-chip and
      // intel-chip for the macOS DMGs). Keep the checksums intact while making
      // every feed URL resolve to the filename that is actually published.
      const publishedManifest = {
        ...manifest,
        files: manifest.files.map((file) => ({ ...file, url: publishedNameByDownloadedName.get(file.url) })),
        ...(manifest.path === undefined ? {} : { path: publishedNameByDownloadedName.get(manifest.path) }),
      }
      writeFileSync(destination, dump(publishedManifest, { lineWidth: -1, noRefs: true, sortKeys: false }))
    } else copyFileSync(selected.get(downloadedName), destination)
    if (lstatSync(destination).size === 0) throw new Error(`Release asset is empty: ${name}`)
    checksumLines.push(`${await sha256(destination)}  ${name}`)
  }
  writeFileSync(join(outputDirectory, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`)
  return { ...release, assets: [...names.keys()], checksumFile: 'SHA256SUMS.txt' }
}

export function invokedAsScript() {
  if (!process.argv[1]) return true
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href
}

function option(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (invokedAsScript()) {
  try {
    const inputDirectory = option('--input')
    const outputDirectory = option('--output')
    const tag = option('--tag')
    const platforms = parseReleasePlatforms(option('--platforms'))
    if (!inputDirectory || !outputDirectory) throw new Error('Provide --input and --output directories')
    const release = await prepareGitHubRelease({ inputDirectory: resolve(inputDirectory), outputDirectory: resolve(outputDirectory), tag, platforms })
    console.log(`Prepared ${release.assets.length} assets and ${release.checksumFile} for ${release.tag}.`)
  } catch (error) {
    console.error(`GitHub Release preparation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
