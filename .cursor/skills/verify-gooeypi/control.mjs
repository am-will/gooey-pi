#!/usr/bin/env node
// GooeyPi verification driver.
//
// Launches the BUILT GooeyPi Electron app in an isolated, disposable HOME +
// Electron user-data-dir, drives one user-facing scenario the way a person
// would (sidebar clicks, keyboard shortcuts), and captures evidence
// (screenshot + ARIA snapshot). Each invocation is a self-contained session:
// launch -> drive -> capture -> tear down. It never touches your real
// ~/.prime / ~/.omp / ~/.pi state or an app instance it did not start.
//
// Requires a display. On a headless machine wrap the command in `xvfb-run -a`.
//
// Usage:
//   node control.mjs doctor [--out DIR]
//   node control.mjs drive <navigation|settings|capabilities> [--out DIR]
//   node control.mjs list
//
// Exit code 0 = healthy / scenario proved; non-zero = failure (details on stderr).

import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const READY = '.app-shell[data-ready="true"]'
const READY_TIMEOUT = 30_000

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') { out.out = argv[i + 1]; i += 1 }
    else out._.push(argv[i])
  }
  return out
}

function log(msg) { process.stdout.write(`[verify-gooeypi] ${msg}\n`) }

function makeOutDir(explicit, name) {
  const base = explicit
    ? resolve(explicit)
    : join(tmpdir(), 'gooeypi-verify', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(base, { recursive: true })
  return base
}

async function launch() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'gooeypi-verify-fixture-'))
  const home = join(fixtureRoot, 'home')
  const userData = join(fixtureRoot, 'user-data')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })

  const env = { ...process.env, HOME: home, PRIME_WORK_E2E_HIDE_WINDOWS: '0' }
  if (!env.DISPLAY) throw new Error('No DISPLAY set. Run under `xvfb-run -a` or an X server.')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: REPO_ROOT,
    env,
    timeout: 30_000,
  })
  const page = await app.firstWindow({ timeout: 20_000 })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.waitForSelector(READY, { timeout: READY_TIMEOUT })
  await dismissNoHarnessPrompt(page)
  return { app, page, fixtureRoot, errors }
}

// A fresh HOME has no Pi/OMP/Prime harness, so GooeyPi shows a modal that makes
// the shell `inert`. Dismiss it so the sidebar is interactive. This is expected
// verification-only state, not a defect.
async function dismissNoHarnessPrompt(page) {
  const dialog = page.getByRole('dialog', { name: 'No Pi family harness detected' })
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 8_000 })
    log('dismissed "No Pi family harness detected" prompt (empty verification HOME)')
  }
}

async function teardown(session) {
  try { await session.app.close() } catch { /* already gone */ }
  if (session.fixtureRoot) rmSync(session.fixtureRoot, { recursive: true, force: true })
}

async function capture(page, outDir, name) {
  const png = join(outDir, `${name}.png`)
  const aria = join(outDir, `${name}.aria.txt`)
  await page.screenshot({ path: png })
  try { writeFileSync(aria, await page.locator('.app-shell').ariaSnapshot()) } catch { /* best effort */ }
  log(`captured ${name}: ${png}`)
}

// --- Scenarios ---------------------------------------------------------------
// Each returns a list of proven assertions (strings) or throws on failure.

async function doctor(page, outDir) {
  const proofs = []
  const title = await page.title()
  proofs.push(`window title: ${JSON.stringify(title)}`)
  const ready = await page.locator('.app-shell').getAttribute('data-ready')
  if (ready !== 'true') throw new Error(`app-shell data-ready=${ready}, expected true`)
  proofs.push('app-shell data-ready=true')
  await capture(page, outDir, 'doctor')
  return proofs
}

async function navigation(page, outDir) {
  const proofs = []
  // Each sidebar button opens a page whose level-1 heading proves the route.
  // Capabilities titles as "Extend <active harness>" (harness-dependent).
  const pages = [
    { button: 'Projects', heading: 'Projects' },
    { button: 'Activity', heading: 'Activity' },
    { button: 'Scheduled', heading: 'Scheduled' },
    { button: 'Capabilities', heading: /^Extend / },
  ]
  for (const p of pages) {
    await page.getByRole('button', { name: p.button, exact: true }).click()
    await page.getByRole('heading', { name: p.heading, level: 1 }).first().waitFor({ state: 'visible', timeout: 8_000 })
    await capture(page, outDir, `nav-${p.button.toLowerCase()}`)
    proofs.push(`${p.button} -> level-1 heading ${p.heading} visible`)
  }
  return proofs
}

async function settings(page, outDir) {
  const proofs = []
  await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
  await page.getByRole('heading', { name: 'General' }).waitFor({ state: 'visible', timeout: 8_000 })
  await capture(page, outDir, 'settings-general')
  proofs.push('Settings opened -> "General" heading visible')

  for (const section of ['Appearance', 'Pets']) {
    await page.getByRole('button', { name: section, exact: true }).click()
    await page.getByRole('heading', { name: section, exact: true }).first().waitFor({ state: 'visible', timeout: 8_000 })
    await capture(page, outDir, `settings-${section.toLowerCase()}`)
    proofs.push(`Settings section "${section}" -> heading visible`)
  }

  await page.keyboard.press('Escape')
  await page.locator(READY).waitFor({ state: 'visible', timeout: 8_000 })
  proofs.push('Escape closed Settings -> returned to app shell')
  return proofs
}

async function capabilities(page, outDir) {
  const proofs = []
  await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
  await page.getByRole('heading', { name: /^Extend /, level: 1 }).first().waitFor({ state: 'visible', timeout: 8_000 })
  // The page exposes Capabilities/Skills tabs and a directory heading.
  await page.getByRole('heading', { name: 'Capabilities', level: 2 }).first().waitFor({ state: 'visible', timeout: 8_000 })
  await capture(page, outDir, 'capabilities')
  proofs.push('Capabilities page shows "Extend <harness>" h1 and a Capabilities directory heading')
  return proofs
}

const SCENARIOS = { navigation, settings, capabilities }

// --- Entry -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0]

  if (command === 'list') {
    log(`scenarios: ${Object.keys(SCENARIOS).join(', ')}`)
    return
  }

  if (command !== 'doctor' && command !== 'drive') {
    process.stderr.write('Usage: node control.mjs <doctor|drive <scenario>|list> [--out DIR]\n')
    process.exit(2)
  }

  const scenarioName = command === 'doctor' ? 'doctor' : args._[1]
  if (command === 'drive' && !SCENARIOS[scenarioName]) {
    process.stderr.write(`Unknown scenario "${scenarioName}". Known: ${Object.keys(SCENARIOS).join(', ')}\n`)
    process.exit(2)
  }

  const outDir = makeOutDir(args.out, scenarioName)
  log(`repo: ${REPO_ROOT}`)
  log(`evidence dir: ${outDir}`)
  let session
  try {
    log('launching built app (needs out/main/index.js; run `npm run build` if missing)...')
    session = await launch()
    log('app ready (.app-shell[data-ready=true])')
    const runner = command === 'doctor' ? doctor : SCENARIOS[scenarioName]
    const proofs = await runner(session.page, outDir)
    if (session.errors.length) log(`renderer errors observed (non-fatal): ${session.errors.length}`)
    log('PROVEN:')
    for (const p of proofs) log(`  - ${p}`)
    log(`OK: ${scenarioName}. Evidence in ${outDir}`)
  } catch (error) {
    process.stderr.write(`[verify-gooeypi] FAILED: ${scenarioName}: ${error?.message ?? error}\n`)
    if (session) { try { await capture(session.page, outDir, `${scenarioName}-failure`) } catch { /* ignore */ } }
    await teardown(session)
    process.exit(1)
  }
  await teardown(session)
}

main()
