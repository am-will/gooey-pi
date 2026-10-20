#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function assertReleaseTag(tag, packageVersion, lockVersion, lockRootVersion = lockVersion) {
  if (!SEMANTIC_VERSION.test(packageVersion)) throw new Error(`package.json version is not a supported semantic version: ${packageVersion}`)
  // SEMANTIC_VERSION only admits '-' in the prerelease part.
  if (packageVersion.includes('-')) {
    throw new Error(`Prerelease version ${packageVersion} is not supported: releases are published as GitHub's latest stable release, which every installed client auto-updates to`)
  }
  if (lockVersion !== packageVersion) throw new Error(`package-lock.json version ${lockVersion} does not match package.json version ${packageVersion}`)
  if (lockRootVersion !== packageVersion) throw new Error(`package-lock.json root package version ${lockRootVersion} does not match package.json version ${packageVersion}`)
  const expectedTag = `v${packageVersion}`
  if (tag !== expectedTag) throw new Error(`Release tag ${tag || '<empty>'} must exactly match package.json version (${expectedTag})`)
  return { tag, version: packageVersion }
}

export function validateReleaseTag(tag, projectDirectory = process.cwd()) {
  const packageJson = JSON.parse(readFileSync(resolve(projectDirectory, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(readFileSync(resolve(projectDirectory, 'package-lock.json'), 'utf8'))
  return assertReleaseTag(tag, packageJson.version, packageLock.version, packageLock.packages?.['']?.version)
}

if (import.meta.main) {
  const tagIndex = process.argv.indexOf('--tag')
  const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1]
  try {
    const release = validateReleaseTag(tag)
    console.log(`Validated release tag ${release.tag} for GooeyPi ${release.version}.`)
  } catch (error) {
    console.error(`Release tag validation failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
