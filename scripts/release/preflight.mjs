#!/usr/bin/env node
import { assertSupportedToolchain, validateReleaseCredentials } from './lib.mjs'

try {
  const toolchainOnly = process.argv.slice(2).includes('--toolchain-only')
  const versions = assertSupportedToolchain()
  if (toolchainOnly) {
    console.log(`Release toolchain preflight passed: Node ${versions.node} and npm ${versions.npm}.`)
  } else {
    validateReleaseCredentials(process.env)
    console.log(`Release preflight passed: Node ${versions.node}, npm ${versions.npm}, Developer ID, Team ID, and notarization credentials are present.`)
  }
} catch (error) {
  console.error(`Release preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
