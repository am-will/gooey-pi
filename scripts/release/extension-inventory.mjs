import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** @typedef {'prime' | 'omp' | 'pi'} ExtensionHost */
/**
 * @typedef {{
 *   file: string
 *   hosts: readonly ExtensionHost[]
 *   brokerEnvironment: readonly string[]
 *   registrations: {
 *     tools: readonly string[]
 *     commands: readonly string[]
 *     events: readonly string[]
 *   }
 * }} ExtensionInventoryEntry
 */

/** @type {readonly ExtensionInventoryEntry[]} */
export const SHIPPED_EXTENSIONS = Object.freeze([
  {
    file: 'omp-work-ask-user.ts',
    hosts: ['prime', 'omp', 'pi'],
    brokerEnvironment: [],
    registrations: { tools: ['ask_user'], commands: [], events: [] },
  },
  {
    file: 'omp-work-browser.ts',
    hosts: ['omp', 'pi'],
    brokerEnvironment: ['PRIME_WORK_BROWSER_URL', 'PRIME_WORK_BROWSER_TOKEN'],
    registrations: {
      tools: [
        'terminal_read',
        'browser_tabs',
        'browser_navigate',
        'browser_screenshot',
        'browser_read_page',
        'browser_click',
        'browser_type',
        'browser_press_key',
        'browser_scroll',
        'browser_evaluate',
      ],
      commands: [],
      events: [],
    },
  },
  {
    file: 'omp-work-collaboration.ts',
    hosts: ['prime', 'omp', 'pi'],
    brokerEnvironment: ['GOOEYPI_COLLABORATION_URL', 'GOOEYPI_COLLABORATION_TOKEN'],
    registrations: {
      tools: ['session_list', 'session_models', 'session_create', 'session_read', 'session_send', 'session_wait'],
      commands: [],
      events: [],
    },
  },
  {
    file: 'omp-work-schedules.ts',
    hosts: ['omp', 'pi'],
    brokerEnvironment: ['PRIME_WORK_SCHEDULE_URL', 'PRIME_WORK_SCHEDULE_TOKEN'],
    registrations: {
      tools: ['scheduled_tasks_list', 'scheduled_task_create_once', 'scheduled_task_create_recurring', 'scheduled_task_update', 'scheduled_task_manage'],
      commands: [],
      events: [],
    },
  },
  {
    file: 'pi-work-fast-mode.ts',
    hosts: ['pi'],
    brokerEnvironment: [],
    registrations: { tools: [], commands: ['gooeypi-fast-mode'], events: ['before_provider_request'] },
  },
  {
    file: 'prime-work-browser.ts',
    hosts: ['prime'],
    brokerEnvironment: ['PRIME_WORK_BROWSER_URL', 'PRIME_WORK_BROWSER_TOKEN'],
    registrations: {
      tools: [
        'terminal_read',
        'browser_tabs',
        'browser_navigate',
        'browser_screenshot',
        'browser_read_page',
        'browser_click',
        'browser_type',
        'browser_press_key',
        'browser_scroll',
        'browser_evaluate',
      ],
      commands: [],
      events: [],
    },
  },
])

export const SHIPPED_EXTENSION_FILES = Object.freeze(SHIPPED_EXTENSIONS.map((extension) => extension.file).sort())

/**
 * Assert that a directory contains only the reviewed, regular extension files.
 * Symlinks and subdirectories fail closed because electron-builder copies the
 * complete source directory into application resources.
 *
 * @param {string} directory
 * @param {string} label
 */
export function assertExtensionSet(directory, label) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    throw new Error(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const nonFiles = entries
    .filter((entry) => !entry.isFile())
    .map((entry) => entry.name)
    .sort()
  const expected = new Set(SHIPPED_EXTENSION_FILES)
  const actual = new Set(files)
  const missing = SHIPPED_EXTENSION_FILES.filter((file) => !actual.has(file))
  const extra = files.filter((file) => !expected.has(file))
  if (missing.length || extra.length || nonFiles.length) {
    throw new Error(
      `${label} does not match the shipped extension inventory (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}; non-file: ${nonFiles.join(', ') || 'none'})`,
    )
  }
  return files
}

/** @param {string} [directory] */
export function assertSourceExtensionSet(directory = resolve('assets/extensions')) {
  return assertExtensionSet(directory, 'Source extension directory')
}

/** @param {string} resourcesDirectory */
export function assertPackagedExtensionSet(resourcesDirectory) {
  return assertExtensionSet(join(resourcesDirectory, 'extensions'), 'Packaged extension resources')
}
