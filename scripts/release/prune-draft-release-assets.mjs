#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * `gh release upload --clobber` replaces same-named assets but never removes
 * assets a previous run left behind, so a resumed draft whose earlier run used
 * different artifact names would publish both the stale and the new files while
 * SHA256SUMS.txt covers only the new set. Every asset on the draft that is not
 * in the expected set is therefore deleted before the draft is published.
 */
export function staleDraftReleaseAssets(assetNames, expectedNames) {
  const expected = new Set(expectedNames)
  if (!expected.size) throw new Error('The expected release asset set is empty')
  const stale = assetNames.filter((name) => !expected.has(name))
  return [...new Set(stale)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

/** Reads the `gh release view --json assets` payload (or a bare name array). */
export function parseDraftAssetNames(source) {
  const value = JSON.parse(source)
  const assets = Array.isArray(value) ? value : value?.assets
  if (!Array.isArray(assets)) throw new Error('Draft release asset listing is not an array')
  return assets.map((asset) => {
    const name = typeof asset === 'string' ? asset : asset?.name
    if (typeof name !== 'string' || !name) throw new Error('Draft release asset listing contains an entry without a name')
    return name
  })
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
    const assetsFile = option('--assets')
    const expectedDirectory = option('--expected')
    if (!assetsFile || !expectedDirectory) throw new Error('Provide --assets <gh json file> and --expected <prepared asset directory>')
    const stale = staleDraftReleaseAssets(parseDraftAssetNames(readFileSync(resolve(assetsFile), 'utf8')), readdirSync(resolve(expectedDirectory)))
    for (const name of stale) console.log(name)
  } catch (error) {
    console.error(`Draft release asset pruning failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
