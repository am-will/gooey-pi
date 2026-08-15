#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    installAppDependencies()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
