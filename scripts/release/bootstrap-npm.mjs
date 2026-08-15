#!/usr/bin/env node
import { assertSupportedNode, assertSupportedNpm, readNpmVersion, readRepositoryToolchain, runCommand } from './lib.mjs'

try {
  const toolchain = readRepositoryToolchain()
  assertSupportedNode(process.version, toolchain)
  const current = readNpmVersion()
  if (current !== toolchain.npm) {
    console.log(`Installing repository npm ${toolchain.npm} (found ${current})...`)
    runCommand('npm', ['install', '--global', `npm@${toolchain.npm}`])
  }
  const installed = readNpmVersion()
  assertSupportedNpm(installed, toolchain)
  if (installed !== toolchain.npm) throw new Error(`Expected pinned npm ${toolchain.npm} after bootstrap, found ${installed}`)
  console.log(`Repository toolchain bootstrap passed: Node ${process.version} and npm ${installed}.`)
} catch (error) {
  console.error(`Repository toolchain bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
