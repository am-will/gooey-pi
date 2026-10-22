#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const APPLE_TICKET_RULE = 'block return out quick proto udp from any to any port 443\n'

function anchorFor(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'macOS' || env.RUNNER_ENVIRONMENT !== 'github-hosted')
    throw new Error('Apple ticket transport is restricted to GitHub-hosted macOS Actions jobs')
  if (![env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT].every((value) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value))) throw new Error('Expected numeric GitHub run ID and attempt')
  return `com.apple/000.gooeypi-notary-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`
}

/** @param {string[]} args @param {string} [input] @returns {{status: number | null, stdout: string, stderr: string, error?: string}} */
function systemRun(args, input) {
  const result = spawnSync('/usr/bin/sudo', ['-n', '/sbin/pfctl', ...args], { input, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message }
}

function output(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}
function checked(run, args, input) {
  const result = run(args, input)
  if (result.status !== 0 || result.error) throw new Error(`pfctl ${args.join(' ')} failed: ${result.error ?? output(result)}`)
  return result
}
function tokenFrom(text) {
  const tokens = [...text.matchAll(/^\s*Token\s*:\s*([0-9]{1,20})\s*$/gm)].map((match) => match[1])
  return tokens.length === 1 ? tokens[0] : undefined
}
function save(file, state, exclusive = false) {
  writeFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' })
}

export function cleanupAppleTicketTransport({ env = process.env, stateFile, run = systemRun }) {
  const anchor = anchorFor(env)
  let state
  try {
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (state.anchor !== anchor) throw new Error('Transport state belongs to another job')
  const errors = []
  try {
    checked(run, ['-a', anchor, '-F', 'rules'])
  } catch (error) {
    errors.push(error)
  }
  if (state.enableAttempted) {
    const token = tokenFrom(state.enableOutput ?? '')
    if (!token) errors.push(new Error(`Cannot identify owned PF reference; retained raw enable output in ${stateFile}`))
    else {
      try {
        checked(run, ['-X', token])
        state.enableAttempted = false
        save(stateFile, state)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  if (errors.length) throw new AggregateError(errors, `Apple ticket transport cleanup failed; state retained at ${stateFile}`)
  rmSync(stateFile)
}

export function setupAppleTicketTransport({ env = process.env, stateFile, run = systemRun }) {
  const anchor = anchorFor(env)
  const root = output(checked(run, ['-sr']))
  if (!/^anchor "com\.apple\/\*"(?:\s|$)/m.test(root)) throw new Error('Live PF root lacks the required com.apple/* filter anchor')
  const children = output(checked(run, ['-a', 'com.apple', '-s', 'Anchors']))
    .split('\n')
    .map((line) => line.trim())
  if (children.some((name) => name === anchor || name === anchor.slice('com.apple/'.length))) throw new Error('Transport anchor is already occupied')
  const state = { anchor, enableAttempted: false, enableOutput: '' }
  save(stateFile, state, true)
  try {
    checked(run, ['-a', anchor, '-f', '-'], APPLE_TICKET_RULE)
    state.enableAttempted = true
    save(stateFile, state)
    const enabled = run(['-E'])
    state.enableOutput = output(enabled)
    save(stateFile, state)
    const token = tokenFrom(state.enableOutput)
    if (enabled.status !== 0 || enabled.error || !token) throw new Error('PF enable failed or did not return exactly one ownership token')
    return { anchor, token }
  } catch (error) {
    try {
      cleanupAppleTicketTransport({ env, stateFile, run })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Transport setup and rollback failed; inspect ${stateFile}`)
    }
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, stateFile, ...extra] = process.argv.slice(2)
    if (!stateFile || extra.length || !['setup', 'cleanup'].includes(mode)) throw new Error('Usage: apple-ticket-transport.mjs <setup|cleanup> <state-file>')
    if (mode === 'cleanup') cleanupAppleTicketTransport({ stateFile })
    else {
      const { anchor, token } = setupAppleTicketTransport({ stateFile })
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `anchor=${anchor}\ntoken=${token}\n`)
      console.log(`Apple ticket transport enabled in ${anchor}; reference ${token}`)
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}
