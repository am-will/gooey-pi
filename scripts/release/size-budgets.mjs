import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const KIB = 1024
const MIB = 1024 * KIB

export const BUNDLE_SIZE_BUDGETS = Object.freeze({
  mainBytes: 640 * KIB,
  preloadBytes: 16 * KIB,
  initialRendererBytes: 1280 * KIB,
  largestRendererChunkBytes: 600 * KIB,
  rendererJsCssBytes: 2.25 * MIB,
})

/**
 * Ceilings for one packaged macOS build: `asarBytes` the packed app.asar,
 * `appBytes` the regular-file bytes inside GooeyPi.app, and `dmgBytes`/
 * `zipBytes` the compressed distributables users download (Electron runtime,
 * unpacked native addons, and the bundled agent included).
 *
 * Raising a budget is deliberate: record the measured new size and the
 * dependency or feature that caused the growth in the pull request, and raise it
 * only to the next multiple of 5 MiB above that measurement so unexplained
 * download-size creep still fails the release build.
 */
export const PACKAGE_SIZE_BUDGETS = Object.freeze({
  asarBytes: 220 * MIB,
  appBytes: 480 * MIB,
  dmgBytes: 190 * MIB,
  zipBytes: 185 * MIB,
})

const BUNDLE_LABELS = {
  mainBytes: 'main bundle',
  preloadBytes: 'preload bundle',
  initialRendererBytes: 'initial renderer entry and modulepreloads',
  largestRendererChunkBytes: 'largest renderer JS/CSS chunk',
  rendererJsCssBytes: 'total renderer JS/CSS',
}

const PACKAGE_LABELS = {
  asarBytes: 'app.asar',
  appBytes: 'application bundle',
  dmgBytes: 'DMG artifact',
  zipBytes: 'ZIP artifact',
}

function formatSize(bytes) {
  return `${bytes} bytes (${(bytes / MIB).toFixed(2)} MiB)`
}

function assertSizeMetrics(metrics, budgets, labels) {
  for (const [name, budget] of Object.entries(budgets)) {
    const size = metrics[name]
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`${labels[name]} size is invalid: ${size}`)
    if (size > budget) throw new Error(`${labels[name]} exceeds its size budget: ${formatSize(size)} > ${formatSize(budget)}`)
  }
}

export function assertBundleSizeBudgets(metrics, budgets = BUNDLE_SIZE_BUDGETS) {
  assertSizeMetrics(metrics, budgets, BUNDLE_LABELS)
}

export function assertPackageSizeBudgets(metrics, budgets = PACKAGE_SIZE_BUDGETS) {
  assertSizeMetrics(metrics, budgets, PACKAGE_LABELS)
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing ${label}: ${path}`)
  return statSync(path).size
}

function parseAttributes(tag) {
  const attributes = new Map()
  for (const match of tag.matchAll(/([:\w-]+)(?:\s*=\s*["']([^"']*)["'])?/g)) attributes.set(match[1].toLowerCase(), match[2] ?? '')
  return attributes
}

function initialRendererReferences(html) {
  const references = []
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0])
    if (attributes.get('type') === 'module' && attributes.has('src')) references.push(attributes.get('src'))
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0])
    if (attributes.get('rel')?.split(/\s+/).includes('modulepreload') && attributes.has('href')) references.push(attributes.get('href'))
  }
  if (!references.length) throw new Error('Renderer index has no module entry or modulepreload assets')
  return [...new Set(references)]
}

function resolveRendererAsset(rendererDirectory, reference) {
  if (!reference || reference.includes('?') || reference.includes('#') || /^[a-z][a-z+.-]*:/i.test(reference)) {
    throw new Error(`Renderer index contains an invalid initial asset reference: ${reference}`)
  }
  const path = resolve(rendererDirectory, reference)
  const withinRenderer = relative(rendererDirectory, path)
  if (!withinRenderer || withinRenderer.startsWith('..') || isAbsolute(withinRenderer)) {
    throw new Error(`Renderer index initial asset escapes the renderer output: ${reference}`)
  }
  return path
}

function findRendererChunks(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) findRendererChunks(path, found)
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.css'))) found.push(path)
    else if (!entry.isFile()) throw new Error(`Renderer output contains a forbidden non-file entry: ${path}`)
  }
  return found
}

export function collectBundleSizeMetrics(outDirectory = resolve('out')) {
  const rendererDirectory = join(outDirectory, 'renderer')
  const indexPath = join(rendererDirectory, 'index.html')
  const mainBytes = requireFile(join(outDirectory, 'main', 'index.js'), 'main bundle')
  const preloadBytes = requireFile(join(outDirectory, 'preload', 'index.js'), 'preload bundle')
  requireFile(indexPath, 'renderer index')
  const html = readFileSync(indexPath, 'utf8')
  const initialPaths = initialRendererReferences(html).map((reference) => resolveRendererAsset(rendererDirectory, reference))
  const initialRendererBytes = initialPaths.reduce((total, path) => total + requireFile(path, 'initial renderer asset'), 0)
  const chunkSizes = findRendererChunks(rendererDirectory).map((path) => statSync(path).size)
  if (!chunkSizes.length) throw new Error('Renderer output contains no JS/CSS chunks')
  return {
    mainBytes,
    preloadBytes,
    initialRendererBytes,
    largestRendererChunkBytes: Math.max(...chunkSizes),
    rendererJsCssBytes: chunkSizes.reduce((total, size) => total + size, 0),
  }
}

export function directoryFileSize(directory) {
  let size = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) size += directoryFileSize(path)
    else if (entry.isFile()) size += statSync(path).size
  }
  return size
}

export function collectPackageSizeMetrics({ asar, app, dmg, zip }) {
  return {
    asarBytes: requireFile(asar, 'app.asar'),
    appBytes: directoryFileSize(app),
    dmgBytes: requireFile(dmg, 'DMG artifact'),
    zipBytes: requireFile(zip, 'ZIP artifact'),
  }
}

export function describeSizeMetrics(metrics) {
  return Object.entries(metrics)
    .map(([name, bytes]) => `${name}=${formatSize(bytes)}`)
    .join(', ')
}
