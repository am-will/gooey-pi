#!/usr/bin/env node
import { runCommand } from './lib.mjs'

/**
 * @param {(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => unknown} run
 * @param {NodeJS.ProcessEnv} sourceEnvironment
 * @param {NodeJS.Platform} platform
 */
export function installAppDependencies(run = runCommand, sourceEnvironment = process.env, platform = process.platform) {
  const env = { ...sourceEnvironment }
  if (platform === 'darwin' && !env.PYTHON) env.PYTHON = '/usr/bin/python3'

  run('install-electron', [], { env })
  run('electron-builder', ['install-app-deps'], { env })
}

// Also runs where import.meta.main is missing (older Node), so the install never silently exits 0.
if (import.meta.main !== false) {
  try {
    installAppDependencies()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
