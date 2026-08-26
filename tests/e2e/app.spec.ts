import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME } from '../../electron/main/store'

let app: ElectronApplication | undefined
let page: Page
let fixtureRoot = ''
let fixtureSessionFile = ''
let currentFixture: ReturnType<typeof createHermeticFixture> | undefined
let actionableErrors: string[] = []

const ISSUE_131_LONG_TOKEN = 'ReProductSkuController.getProductPoolDetail,ReProductSkuController.getProductPoolPriceWave'

const instrumentedPages = new WeakSet<Page>()

const attachDiagnostics = (target: Page) => {
  if (instrumentedPages.has(target)) return
  instrumentedPages.add(target)
  target.on('pageerror', (error) => actionableErrors.push(error.message))
  target.on('console', (message) => {
    if (message.type() === 'error') actionableErrors.push(message.text())
  })
}

async function closeHermeticApp(target: ElectronApplication | undefined): Promise<void> {
  if (!target) return
  const child = target.process()
  const closeEvent = target.waitForEvent('close', { timeout: 15_000 }).then(() => undefined, () => undefined)
  const gracefulClose = target.close().then(() => true, () => false)
  const closedGracefully = await Promise.race([
    gracefulClose,
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
  ])
  if (closedGracefully) return
  if (child.exitCode === null) child.kill('SIGKILL')
  await closeEvent
}

interface CapturedClosePrompt {
  message: string
  detail?: string
  buttons: string[]
}

/** Records the async close confirmations and answers Cancel until `__closeResponse` says otherwise. */
async function stubCloseDialog(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ dialog }) => {
    const scope = globalThis as { __closePrompts?: unknown[]; __closeResponse?: number }
    scope.__closePrompts = []
    scope.__closeResponse = 0
    const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<{ response: number }> }
    closeDialog.showMessageBox = (...args) => {
      const options = (args.length > 1 ? args[1] : args[0]) as { message: string; detail?: string; buttons?: string[] }
      scope.__closePrompts?.push({ message: options.message, detail: options.detail, buttons: options.buttons ?? [] })
      return Promise.resolve({ response: scope.__closeResponse ?? 0 })
    }
  })
}

function closePrompts(target: ElectronApplication): Promise<CapturedClosePrompt[]> {
  return target.evaluate(() => (globalThis as { __closePrompts?: unknown[] }).__closePrompts ?? []) as Promise<CapturedClosePrompt[]>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function createHermeticFixture(activeSession = false): { userData: string; home: string; project: string; executable: string; ompExecutable: string; piExecutable: string; cuaExecutable: string; sessionFile: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'prime-work-e2e-'))
  const userData = join(fixtureRoot, 'user-data')
  const home = join(fixtureRoot, 'home')
  const project = join(fixtureRoot, 'project')
  const secondary = join(fixtureRoot, 'secondary-project')
  const sessions = join(home, '.prime', 'agent', 'sessions')
  mkdirSync(userData, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(secondary, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  writeFileSync(join(home, '.prime', 'agent', 'models.json'), JSON.stringify({
    providers: {
      fixture: {
        name: 'Fixture',
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
        apiKey: 'fixture-key',
        models: [{
          id: 'fixture-model',
          name: 'Fixture Model',
          reasoning: true,
          thinkingLevelMap: { medium: 'medium' },
          input: ['text', 'image'],
          contextWindow: 100000,
          maxTokens: 8192,
        }],
      },
    },
  }))
  const canonicalProject = realpathSync(project)
  const canonicalSecondary = realpathSync(secondary)
  const initializeRepository = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), 'base\n')
    for (const args of [
      ['init', '-q'],
      ['config', 'user.name', 'Prime Work E2E'],
      ['config', 'user.email', 'e2e@example.com'],
      ['add', file],
      ['commit', '-qm', 'base'],
    ]) {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(result.stderr)
    }
  }
  initializeRepository(project, 'primary.txt')
  initializeRepository(secondary, 'secondary-change.txt')
  writeFileSync(join(secondary, 'secondary-change.txt'), 'base\nsecondary workspace change\n')
  writeFileSync(join(project, 'README.md'), '# Hermetic Prime Work fixture\n')
  const ompSessions = join(home, '.omp', 'agent', 'sessions', '-omp-project')
  mkdirSync(ompSessions, { recursive: true })
  const ompTitleUnpadded = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: '' })
  const ompTitleSlot = JSON.stringify({ type: 'title', v: 1, title: 'OMP hermetic fixture', updatedAt: '2026-02-01T00:00:00.000Z', pad: ' '.repeat(256 - 1 - Buffer.byteLength(ompTitleUnpadded, 'utf8')) })
  const ompSessionFile = join(ompSessions, '2026-02-01T00-00-00-000Z_019fdf24-aaaa-7000-8000-000000000001.jsonl')
  writeFileSync(ompSessionFile, [
    ompTitleSlot,
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-aaaa-7000-8000-000000000001', timestamp: '2026-02-01T00:00:00.000Z', cwd: canonicalProject }),
    JSON.stringify({ type: 'message', id: 'omp-user', parentId: null, timestamp: '2026-02-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: `OMP hermetic fixture\n${ISSUE_131_LONG_TOKEN}` }], timestamp: 1774915201000 } }),
    JSON.stringify({ type: 'message', id: 'omp-assistant', parentId: 'omp-user', timestamp: '2026-02-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'OMP fixture reply.' }] } }),
    '',
  ].join('\n'))
  const piSessions = join(home, '.pi', 'agent', 'sessions', '--pi-project--')
  mkdirSync(piSessions, { recursive: true })
  const piSessionFile = join(piSessions, '2026-03-01T00-00-00-000Z_019fdf24-bbbb-7000-8000-000000000002.jsonl')
  writeFileSync(piSessionFile, [
    JSON.stringify({ type: 'session', version: 3, id: '019fdf24-bbbb-7000-8000-000000000002', timestamp: '2026-03-01T00:00:00.000Z', cwd: canonicalProject }),
    JSON.stringify({ type: 'session_info', id: 'pi-info', parentId: null, timestamp: '2026-03-01T00:00:00.500Z', name: 'Pi hermetic fixture' }),
    JSON.stringify({ type: 'message', id: 'pi-user', parentId: 'pi-info', timestamp: '2026-03-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Pi hermetic fixture' }], timestamp: 1777341601000 } }),
    JSON.stringify({ type: 'message', id: 'pi-assistant', parentId: 'pi-user', timestamp: '2026-03-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pi fixture reply.' }] } }),
    '',
  ].join('\n'))
  const sessionFile = join(sessions, 'fixture.jsonl')
  writeFileSync(sessionFile, [
    JSON.stringify({ type: 'session', id: 'fixture-session', cwd: canonicalSecondary, timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'fixture-message', parentId: null, message: { role: 'user', content: [
      { type: 'text', text: 'Hermetic desktop fixture' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
    ], timestamp: '2026-01-01T00:00:00.000Z' } }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-agent-message', parentId: 'fixture-message', customType: 'agent_message', display: true,
      content: '[from child:fixture-reviewer]\nAgent-to-agent message received.\n\nEnvelope metadata that should stay hidden.',
      details: { message: 'Fixture review complete. The readable agent response is available here.', from: { sessionName: 'fixture-reviewer', runtimeKind: 'subagent' } },
      timestamp: '2026-01-01T00:00:01.000Z',
    }),
    JSON.stringify({
      type: 'custom_message', id: 'fixture-goal-summary', parentId: 'fixture-agent-message', customType: 'goal_context', display: true,
      content: '<goal_context>Fixture control envelope that should stay hidden.</goal_context>',
      details: { kind: 'created', goalId: 'fixture-goal', objective: 'Verify the readable blue goal summary.', status: 'active', continuationsUsed: 0 },
      timestamp: '2026-01-01T00:00:02.000Z',
    }),
    '',
  ].join('\n'))
  writeFileSync(join(sessions, 'primary.jsonl'), [
    JSON.stringify({ type: 'session', id: 'primary-session', cwd: canonicalProject, timestamp: '2025-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'primary-message', parentId: null, message: { role: 'user', content: 'Primary workspace fixture', timestamp: '2025-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
  writeFileSync(join(sessions, 'collaboration-peer.jsonl'), [
    JSON.stringify({ type: 'session', id: '019fdf24-cccc-7000-8000-000000000003', cwd: canonicalSecondary, timestamp: '2024-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'message', id: 'collaboration-peer-message', parentId: null, message: { role: 'user', content: 'Ownership peer fixture', timestamp: '2024-01-01T00:00:00.000Z' } }),
    '',
  ].join('\n'))
  const identity = (path: string) => {
    const info = lstatSync(path, { bigint: true })
    return {
      dev: info.dev.toString(),
      ino: info.ino.toString(),
      birthtimeNs: info.birthtimeNs > 0n ? info.birthtimeNs.toString() : undefined,
    }
  }
  writeFileSync(join(userData, LEGACY_DESKTOP_STATE_FILENAME), JSON.stringify({
    version: 1,
    projects: [{
      id: 'multi-folder-project', name: 'Multi-folder fixture', path: canonicalProject,
      folders: [canonicalProject, canonicalSecondary], primaryFolder: canonicalProject,
      pinned: false, createdAt: '2025-01-01T00:00:00.000Z', lastOpenedAt: '2026-01-01T00:00:00.000Z',
      folderIdentities: { [canonicalProject]: identity(canonicalProject), [canonicalSecondary]: identity(canonicalSecondary) },
    }],
    settings: { activeHarness: 'prime', browserHome: 'about:blank', telemetry: true, locale: 'en' },
    archivedSessions: [],
    dismissedProjectPaths: [],
  }))

  const daemonExecutable = join(fixtureRoot, 'prime-agent-daemon-fixture.cjs')
  writeFileSync(daemonExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const socketPath = ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}
try { fs.unlinkSync(socketPath) } catch {}
const server = net.createServer((socket) => {
  socket.write(JSON.stringify({ type: 'daemon_hello', protocol: { name: 'prime-agent.daemon', version: 7 }, serverCapabilities: ['session_input_admission'] }) + '\\n')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    while (buffer.includes('\\n')) {
      const index = buffer.indexOf('\\n')
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const envelope = JSON.parse(line)
      if (envelope.command?.type === 'ack_result') {
        fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-ack.json'))}, JSON.stringify(envelope.command))
        continue
      }
      if (envelope.command?.type !== 'follow_up') continue
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'follow-up-args.json'))}, JSON.stringify(envelope.command))
      const timestamp = new Date().toISOString()
      fs.appendFileSync(${JSON.stringify(sessionFile)}, [
        JSON.stringify({ type: 'message', id: 'fixture-external-user', parentId: 'fixture-goal-summary', timestamp, message: { role: 'user', content: envelope.command.message } }),
        JSON.stringify({ type: 'message', id: 'fixture-external-assistant', parentId: 'fixture-external-user', timestamp, message: { role: 'assistant', content: 'The external Prime Agent received the queued reply.' } }),
      ].join('\\n') + '\\n')
      socket.write(JSON.stringify({ id: envelope.id, type: 'response', command: 'follow_up', success: true, data: {} }) + '\\n')
    }
  })
  socket.on('end', () => server.close())
})
server.listen(socketPath)
setTimeout(() => server.close(), 30_000).unref()
`)
  chmodSync(daemonExecutable, 0o755)

  const executable = join(fixtureRoot, 'prime-agent-fixture.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('prime-agent 0.7.0\\n'); process.exit(0) }
if (args[0] === 'schedule') { process.stdout.write(JSON.stringify({ jobs: [] }) + '\\n'); process.exit(0) }
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(realpathSync(sessionFile))}
if (args[0] === 'list') {
  const sessions = ${JSON.stringify(activeSession)}
    ? [{ id: 'active-fixture', activeSessionId: 'active-fixture', lifecycle: 'live', isSessionActive: true, activity: 'working', isStreaming: true, sessionFile, modified: new Date().toISOString() }]
    : []
  process.stdout.write(JSON.stringify({ sessions }) + '\\n')
  process.exit(0)
}
if (args[0] === 'status') {
  const { spawn } = require('node:child_process')
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) {
    const child = spawn(process.execPath, [${JSON.stringify(join(fixtureRoot, 'prime-agent-daemon-fixture.cjs'))}], { detached: true, stdio: 'ignore' })
    child.unref()
    const wait = new Int32Array(new SharedArrayBuffer(4))
    const deadline = Date.now() + 3_000
    while (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))}) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 20)
  }
  if (!fs.existsSync(${JSON.stringify(join(fixtureRoot, 'daemon.sock'))})) process.exit(2)
  process.stdout.write(JSON.stringify([{ isDefault: true, status: 'current', socketPath: ${JSON.stringify(join(fixtureRoot, 'daemon.sock'))} }]) + '\\n')
  process.exit(0)
}
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prime-runtime.pid'))}, String(process.pid))
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prime-runtime-args.json'))}, JSON.stringify(args))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
let pendingPrompt
let streaming = false
let barrierWatcher
const barrierRelease = ${JSON.stringify(join(fixtureRoot, 'prompt-admission-barrier-release'))}
const barrierStarted = ${JSON.stringify(join(fixtureRoot, 'prompt-admission-barrier-started'))}
const barrierAccepted = ${JSON.stringify(join(fixtureRoot, 'prompt-admission-barrier-accepted'))}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_state') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionId: 'fixture-session', sessionFile, isStreaming: streaming, thinkingLevel: 'medium', model: { provider: 'fixture', id: 'fixture-model', name: 'Fixture Model' } } })
  } else if (command.type === 'get_session_stats') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { contextUsage: { tokens: 12000, contextWindow: 100000, percent: 12 } } })
  } else if (command.type === 'list_schedules') {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: { jobs: [] } })
  } else if (command.type === 'steer') {
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'steer-args.json'))}, JSON.stringify(command))
    setTimeout(() => send({ type: 'response', id: command.id, command: command.type, success: true, data: {} }), 500)
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    if (typeof command.message === 'string' && command.message.includes('barrier turn')) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
      fs.writeFileSync(barrierStarted, 'ready')
      streaming = true
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      barrierWatcher = fs.watch(${JSON.stringify(fixtureRoot)}, (_event, filename) => {
        if (filename?.toString() !== 'prompt-admission-barrier-release' || !fs.existsSync(barrierRelease)) return
        barrierWatcher?.close()
        barrierWatcher = undefined
        send({ type: 'agent_end' })
      })
      return
    }
    if (typeof command.message === 'string' && command.message.includes('barrier follow-up')) {
      if (command.streamingBehavior === undefined) {
        send({ id: command.id, type: 'response', command: command.type, success: false,
          error: 'Cannot send prompt while agent is streaming without streamingBehavior' })
        return
      }
      fs.writeFileSync(barrierAccepted, JSON.stringify(command))
      const completedAt = new Date().toISOString()
      fs.appendFileSync(sessionFile, [
        JSON.stringify({ type: 'message', id: 'fixture-barrier-user', parentId: 'fixture-goal-summary',
          timestamp: completedAt, message: { role: 'user', content: command.message } }),
        JSON.stringify({ type: 'message', id: 'fixture-barrier-assistant', parentId: 'fixture-barrier-user',
          timestamp: completedAt, message: { role: 'assistant', content: 'The barrier follow-up was accepted.' } }),
      ].join('\\n') + '\\n')
      streaming = false
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      send({ type: 'agent_end' })
      pendingPrompt = undefined
      return
    }
    if (typeof command.message === 'string' && command.message.includes('stay busy')) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
      streaming = true
      send({ type: 'agent_start' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      return
    }
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'prompt-args.json'))}, JSON.stringify(command))
    send({ type: 'agent_start' })
    if (typeof command.message !== 'string' || !command.message.includes('two questions')) {
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Fixture response.' } })
      send({ type: 'agent_end' })
      send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
      pendingPrompt = undefined
      return
    }
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '**Reviewing the available release channels before asking for input.**' } })
    send({ type: 'tool_execution_start', toolCallId: 'ask-2', toolName: 'ask_user', args: { questions: [
      { question: 'Which release channel?', options: ['Stable', 'Beta'] },
      { question: 'What should I optimize for?', options: ['Speed', 'Safety'] },
    ] } })
    send({ type: 'extension_ui_request', id: 'fixture-question-1', method: 'select', title: 'Which release channel?', options: ['__prime_ask_user__fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
    send({ type: 'extension_ui_request', id: 'fixture-question-2', method: 'select', title: 'What should I optimize for?', options: ['__prime_ask_user__fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
  } else if (command.type === 'extension_ui_response' && pendingPrompt) {
    pendingPrompt.values = { ...(pendingPrompt.values || {}), [command.id]: command.value }
    if (Object.keys(pendingPrompt.values).length < 2) return
    const prompt = pendingPrompt
    pendingPrompt = undefined
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'questionnaire-values.json'))}, JSON.stringify(prompt.values))
    send({ type: 'tool_execution_end', toolCallId: 'ask-2', toolName: 'ask_user', result: { values: prompt.values } })
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The questionnaire answers are ready.' } })
    const completedAt = new Date().toISOString()
    fs.appendFileSync(sessionFile, [
      JSON.stringify({ type: 'message', id: 'fixture-live-assistant-multi', parentId: 'fixture-goal-summary', message: { role: 'assistant', timestamp: completedAt, content: [{ type: 'toolCall', id: 'ask-2', name: 'ask_user', arguments: { questions: [{ question: 'Which release channel?', options: ['Stable', 'Beta'] }, { question: 'What should I optimize for?', options: ['Speed', 'Safety'] }] } }] } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-result-multi', parentId: 'fixture-live-assistant-multi', message: { role: 'toolResult', timestamp: completedAt, toolCallId: 'ask-2', toolName: 'ask_user', content: JSON.stringify({ values: prompt.values }) } }),
      JSON.stringify({ type: 'message', id: 'fixture-live-final-multi', parentId: 'fixture-live-result-multi', message: { role: 'assistant', timestamp: completedAt, content: 'The questionnaire answers are ready.' } }),
    ].join('\\n') + '\\n')
    send({ type: 'agent_end' })
    send({ type: 'response', id: prompt.id, command: prompt.type, success: true, data: {} })
    setTimeout(() => {
      const refreshedAt = new Date().toISOString()
      fs.appendFileSync(sessionFile, JSON.stringify({
        type: 'session_info',
        id: 'fixture-post-completion-catalog-refresh',
        parentId: 'fixture-live-final-multi',
        timestamp: refreshedAt,
        name: 'Post-completion catalog refresh',
      }) + '\\n')
    }, 250)
  } else if (command.id) {
    send({ type: 'response', id: command.id, command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(executable, 0o755)
  const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
  writeFileSync(ompExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('omp/17.2.11\\n'); process.exit(0) }
if (args[0] === 'models' && args.includes('--json')) {
  process.stdout.write(JSON.stringify({ models: [
    { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
    { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', contextWindow: 200000, maxTokens: 8192, reasoning: true, thinking: ['low', 'high'], input: ['text'] },
  ] })); process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'omp-runtime-args.json'))}, JSON.stringify(args))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const resumeIndex = args.indexOf('--resume')
const sessionFile = resumeIndex >= 0 ? args[resumeIndex + 1] : ${JSON.stringify(ompSessionFile)}
let negotiated = false
let pendingPrompt
let answers = {}
send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2] })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'negotiate_protocol') {
    negotiated = true
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { protocolVersion: 2 } })
  } else if (!negotiated) {
    send({ id: command.id, type: 'response', command: command.type, success: false, error: 'Protocol was not negotiated' })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: '019fdf24-aaaa-7000-8000-000000000001', sessionFile, isStreaming: false, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
      contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } } })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    pendingPrompt = command
    answers = {}
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    send({ type: 'tool_execution_start', toolCallId: 'omp-ask-2', toolName: 'ask_user', args: { questions: [
      { question: 'Which OMP release channel?', options: ['Stable', 'Beta'] },
      { question: 'What should OMP optimize for?', options: ['Speed', 'Safety'] },
    ] } })
    send({ type: 'extension_ui_request', id: 'omp-fixture-question-1', method: 'select', title: 'Which OMP release channel?', options: ['__prime_ask_user__omp-fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
    send({ type: 'extension_ui_request', id: 'omp-fixture-question-2', method: 'select', title: 'What should OMP optimize for?', options: ['__prime_ask_user__omp-fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
  } else if (command.type === 'extension_ui_response') {
    answers[command.id] = command.value
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
    if (pendingPrompt && Object.keys(answers).length === 2) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'omp-questionnaire-values.json'))}, JSON.stringify(answers))
      pendingPrompt = undefined
      send({ type: 'tool_execution_end', toolCallId: 'omp-ask-2', toolName: 'ask_user', result: { values: answers } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The OMP questionnaire answers are ready.' } })
      send({ type: 'agent_end', isTerminal: true })
    }
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(ompExecutable, 0o755)
  const piExecutable = join(fixtureRoot, 'pi-fixture.cjs')
  writeFileSync(piExecutable, `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { process.stdout.write('0.84.1\\n'); process.exit(0) }
if (args[0] === 'install' || args[0] === 'remove') {
  const settingsPath = require('node:path').join(process.env.HOME, '.pi', 'agent', 'settings.json')
  fs.mkdirSync(require('node:path').dirname(settingsPath), { recursive: true })
  let settings = {}
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) } catch {}
  const packages = Array.isArray(settings.packages) ? settings.packages.filter((source) => source !== args[1]) : []
  if (args[0] === 'install') packages.push(args[1])
  fs.writeFileSync(settingsPath, JSON.stringify({ ...settings, packages }))
  process.stdout.write(args[0] === 'install' ? 'installed\\n' : 'removed\\n')
  process.exit(0)
}
if (!args.includes('--mode') || args[args.indexOf('--mode') + 1] !== 'rpc') process.exit(2)
if (!args.includes('--no-session')) fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-runtime-args.json'))}, JSON.stringify({ args, cwd: process.cwd() }))
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
const sessionIndex = args.indexOf('--session')
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : ${JSON.stringify(piSessionFile)}
let pendingPrompt
let answers = {}
// Base pi pushes no ready frame and negotiates nothing: answer Prime-shaped
// request/response envelopes immediately.
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  if (command.type === 'get_available_models') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { models: [
      { provider: 'anthropic', id: 'claude-fixture', name: 'Claude Fixture', api: 'anthropic-messages', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
      { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture', api: 'openai-responses', reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 8192 },
    ] } })
  } else if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {
      sessionId: '019fdf24-bbbb-7000-8000-000000000002', sessionFile, isStreaming: false, thinkingLevel: 'medium',
      model: { provider: 'openai-codex', id: 'gpt-fixture', name: 'GPT Fixture' },
    } })
  } else if (command.type === 'get_session_stats') {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { contextUsage: { tokens: 1000, contextWindow: 200000, percent: 0.5 } } })
  } else if (command.type === 'prompt' || command.type === 'follow_up') {
    fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-prompt-args.json'))}, JSON.stringify(command))
    send({ type: 'agent_start' })
    send({ id: command.id, type: 'response', command: command.type, success: true, data: { agentInvoked: true } })
    if (typeof command.message === 'string' && command.message.includes('two Pi questions')) {
      pendingPrompt = command
      answers = {}
      send({ type: 'tool_execution_start', toolCallId: 'pi-ask-2', toolName: 'ask_user', args: { questions: [
        { question: 'Which Pi release channel?', options: ['Stable', 'Beta'] },
        { question: 'What should Pi optimize for?', options: ['Speed', 'Safety'] },
      ] } })
      send({ type: 'extension_ui_request', id: 'pi-fixture-question-1', method: 'select', title: 'Which Pi release channel?', options: ['__prime_ask_user__pi-fixture-group:0:2', 'Stable', 'Beta', 'Other (type your own answer)'] })
      send({ type: 'extension_ui_request', id: 'pi-fixture-question-2', method: 'select', title: 'What should Pi optimize for?', options: ['__prime_ask_user__pi-fixture-group:1:2', 'Speed', 'Safety', 'Other (type your own answer)'] })
      return
    }
    send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Pi fixture response.' } })
    send({ type: 'agent_end' })
  } else if (command.type === 'extension_ui_response') {
    answers[command.id] = command.value
    if (pendingPrompt && Object.keys(answers).length === 2) {
      fs.writeFileSync(${JSON.stringify(join(fixtureRoot, 'pi-questionnaire-values.json'))}, JSON.stringify(answers))
      pendingPrompt = undefined
      send({ type: 'tool_execution_end', toolCallId: 'pi-ask-2', toolName: 'ask_user', result: { values: answers } })
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'The Pi questionnaire answers are ready.' } })
      send({ type: 'agent_end' })
    }
  } else if (command.id) {
    send({ id: command.id, type: 'response', command: command.type, success: true, data: {} })
  }
})
`)
  chmodSync(piExecutable, 0o755)
  const cuaExecutable = join(fixtureRoot, 'cua-driver-fixture.cjs')
  writeFileSync(cuaExecutable, `#!/usr/bin/env node
if (process.argv.includes('--version')) { process.stdout.write('cua-driver 0.19.0\\n'); process.exit(0) }
process.exit(2)
`)
  chmodSync(cuaExecutable, 0o755)
  return { userData, home, project, executable, ompExecutable, piExecutable, cuaExecutable, sessionFile: realpathSync(sessionFile) }
}

function hermeticEnvironment(home: string, executable: string, ompExecutable: string, piExecutable: string, cuaExecutable: string, restrictPath = false): NodeJS.ProcessEnv {
  let path = process.env.PATH
  if (restrictPath) {
    const bin = join(fixtureRoot, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(process.execPath, join(bin, 'node'))
    path = bin
  }
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: path,
    TMPDIR: fixtureRoot,
    SHELL: '/bin/zsh',
    LANG: 'C',
    LC_ALL: 'C',
    NO_COLOR: '1',
    PRIME_WORK_E2E_HIDE_WINDOWS: '1',
    PRIME_AGENT_BINARY: executable,
    OMP_BINARY: ompExecutable,
    PI_BINARY: piExecutable,
    CUA_DRIVER_PATH: cuaExecutable,
  }
  for (const key of ['USER', 'LOGNAME', '__CF_USER_TEXT_ENCODING', 'DISPLAY', 'XAUTHORITY']) if (process.env[key]) env[key] = process.env[key]
  return env
}


test.describe('Prime Work desktop smoke', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright derives fixture usage from this destructuring pattern
  test.beforeEach(async ({}, testInfo) => {
    actionableErrors = []
    app = undefined
    const activeSession = testInfo.title === 'defers a reply to a session that is active outside Prime Work'
      || testInfo.title === 'reflects an external JSONL append without reselecting the live session'
    const liveInstall = testInfo.title === 'adds and connects to a harness installed while the app is open'
    const noHarnesses = testInfo.title === 'opens Harness settings from the no-harness recovery prompt'
    const authenticatedMcp = testInfo.title === 'shows built-in Prime MCPs without inspecting or changing authorization'
    let startupError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = createHermeticFixture(activeSession)
      if (authenticatedMcp) writeFileSync(join(fixture.home, '.prime', 'agent', 'auth.json'), JSON.stringify({ 'mcp:notion': { type: 'oauth', access: 'fixture-token', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 } }))
      currentFixture = fixture
      fixtureSessionFile = fixture.sessionFile
      if (liveInstall) renameSync(fixture.ompExecutable, `${fixture.ompExecutable}.pending`)
      if (noHarnesses) {
        for (const executable of [fixture.executable, fixture.ompExecutable, fixture.piExecutable]) renameSync(executable, `${executable}.pending`)
      }
      try {
        const environment = hermeticEnvironment(fixture.home, fixture.executable, fixture.ompExecutable, fixture.piExecutable, fixture.cuaExecutable, liveInstall || noHarnesses)
        if (testInfo.title === 'Command-Q backgrounds the window and menu-bar Open restores it') environment.PRIME_WORK_E2E_HIDE_WINDOWS = '0'
        app = await electron.launch({
          args: ['.', `--user-data-dir=${fixture.userData}`],
          cwd: process.cwd(),
          env: environment as Record<string, string>,
          timeout: 20_000,
        })
        app.context().on('page', attachDiagnostics)
        for (const target of app.windows()) attachDiagnostics(target)
        page = await app.firstWindow({ timeout: 15_000 })
        attachDiagnostics(page)
        await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })
        return
      } catch (error) {
        startupError = error
        await closeHermeticApp(app)
        app = undefined
        if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
        fixtureRoot = ''
        fixtureSessionFile = ''
      }
    }
    throw startupError ?? new Error('Prime Work did not create its initial window')
  })

  test.afterEach(async () => {
    await closeHermeticApp(app)
    app = undefined
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
    fixtureSessionFile = ''
    currentFixture = undefined
  })

  test('steers the active turn with Ctrl+Enter', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I steer')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()

    await composer.fill('send this queued task now')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await queuedTray.locator('.composer-queue__item').hover()
    await expect(queuedTray.locator('.composer-queue__actions')).toHaveCSS('opacity', '1')
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)
    const sendImmediately = queuedTray.getByRole('button', { name: /^Send queued message immediately:/ })
    await expect(sendImmediately).toHaveAttribute('title', 'Send queued message immediately')
    await sendImmediately.click()
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    const queuedSteerMarker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => existsSync(queuedSteerMarker)).toBe(true)
    expect(JSON.parse(readFileSync(queuedSteerMarker, 'utf8'))).toMatchObject({ type: 'steer', message: 'send this queued task now' })
    await composer.fill('change direction now')
    await composer.press('Control+Enter')
    await expect(page.locator('.message--user').filter({ hasText: 'change direction now' })).toBeVisible()
    const marker = join(fixtureRoot, 'steer-args.json')
    await expect.poll(() => {
      if (!existsSync(marker)) return ''
      return JSON.parse(readFileSync(marker, 'utf8')).message
    }).toBe('change direction now')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ type: 'steer', message: 'change direction now' })
    await expect(composer).toHaveValue('')
  })

  test('admits a queued prompt across the Prime terminal-event barrier', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('barrier turn')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-admission-barrier-started'))).toBe(true)
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()

    await composer.fill('barrier follow-up')
    await composer.press('Enter')
    const queuedTray = page.getByRole('region', { name: 'Queued messages' })
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(1)

    writeFileSync(join(fixtureRoot, 'prompt-admission-barrier-release'), 'release')
    const acceptedPath = join(fixtureRoot, 'prompt-admission-barrier-accepted')
    await expect.poll(() => existsSync(acceptedPath)).toBe(true)
    expect(JSON.parse(readFileSync(acceptedPath, 'utf8'))).toMatchObject({
      type: 'prompt',
      message: 'barrier follow-up',
      streamingBehavior: 'followUp',
    })
    await expect(queuedTray.locator('.composer-queue__item')).toHaveCount(0)
    await expect(page.locator('.message--user').filter({ hasText: 'barrier follow-up' })).toHaveCount(1)
    await expect(page.locator('.message--activity').filter({ hasText: 'Cannot send prompt' })).toHaveCount(0)
  })

  test('centers the compact context-usage dial', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const dial = page.locator('.context-usage-dial')
    await expect(dial).toBeVisible()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Refresh context usage')
    await composer.press('Enter')
    await expect(dial).toHaveText('12')
    const offset = await dial.evaluate((node) => {
      const textNode = node.querySelector('span')?.firstChild
      if (!textNode) throw new Error('Missing context dial text')
      const dialRect = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(textNode)
      const textRect = range.getBoundingClientRect()
      return {
        x: (textRect.left + textRect.right - dialRect.left - dialRect.right) / 2,
        y: (textRect.top + textRect.bottom - dialRect.top - dialRect.bottom) / 2,
        size: dialRect.width,
      }
    })
    expect(offset.size).toBeCloseTo(26.4, 1)
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(0.5)
  })

  test('picks, previews, and removes an image in the composer', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const imagePath = join(fixtureRoot, 'picker.png')
    writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))

    await page.getByRole('button', { name: 'Add context' }).click()
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('option', { name: /Add files/ }).click()
    await (await fileChooser).setFiles(imagePath)
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toBeVisible()
    await expect(page.locator('.composer p[role="status"]')).toHaveText('1 file attached.')
    await page.getByRole('button', { name: 'Remove picker.png' }).click()
    await expect(page.locator('.composer-attachment').filter({ hasText: 'picker.png' })).toHaveCount(0)
  })

  test('collapses composer selectors and keeps the checkout menu inside a narrow conversation pane', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.conversation-column').evaluate((node) => {
      node.style.flex = '0 0 560px'
      const pane = node.querySelector<HTMLElement>('.conversation-pane')
      if (pane) pane.style.minWidth = '0'
    })

    const model = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Model' }) })
    const reasoning = page.locator('.select-control').filter({ has: page.getByRole('combobox', { name: 'Reasoning effort' }) })
    await expect(model.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__chevron')).toHaveCSS('display', 'none')
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '1')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '1')

    await page.locator('.conversation-column').evaluate((node) => { node.style.flex = '0 0 300px' })
    await expect(model.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(reasoning.getByRole('combobox')).toHaveCSS('opacity', '0')
    await expect(model.locator('.select-control__icon')).not.toHaveCSS('display', 'none')
    await expect(reasoning.locator('.select-control__icon')).not.toHaveCSS('display', 'none')

    const controlBounds = await page.locator('.composer__footer').evaluate((footer) => {
      const controls = footer.querySelector<HTMLElement>('.composer__controls')!
      const actions = footer.querySelector<HTMLElement>('.composer__actions')!
      const controlsRect = controls.getBoundingClientRect()
      const actionsRect = actions.getBoundingClientRect()
      return { controlsRight: controlsRect.right, actionsLeft: actionsRect.left }
    })
    expect(controlBounds.controlsRight).toBeLessThanOrEqual(controlBounds.actionsLeft)

    await page.getByRole('button', { name: /^Checkout:/ }).click()
    const menuBounds = await page.getByRole('menu', { name: 'Git worktrees' }).evaluate((menu) => {
      const menuRect = menu.getBoundingClientRect()
      const footerRect = menu.closest('.composer__footer')!.getBoundingClientRect()
      return { menuLeft: menuRect.left, menuRight: menuRect.right, footerLeft: footerRect.left, footerRight: footerRect.right }
    })
    expect(menuBounds.menuLeft).toBeGreaterThanOrEqual(menuBounds.footerLeft - 0.5)
    expect(menuBounds.menuRight).toBeLessThanOrEqual(menuBounds.footerRight + 0.5)
  })

  test('loads the sandboxed preload bridge and hermetic service data', async () => {
    const bridge = await page.evaluate(() => {
      const prime = (window as typeof window & { prime?: Record<string, unknown> }).prime
      const voice = prime?.voice
      return { type: typeof prime, groups: prime ? Object.keys(prime).sort() : [], voiceMethods: voice && typeof voice === 'object' ? Object.keys(voice).sort() : [] }
    })
    expect(bridge.type).toBe('object')
    expect(bridge.groups).toEqual(['agent', 'app', 'browser', 'git', 'heartbeats', 'pets', 'plugins', 'projects', 'providers', 'schedules', 'sessions', 'settings', 'terminal', 'updates', 'voice'])
    expect(bridge.voiceMethods).toContain('testSelfHosted')
    const updateMenu = await app!.evaluate(({ Menu }) => {
      const parents = Menu.getApplicationMenu()?.items ?? []
      const parent = parents.find((item) => item.submenu?.items.some((child) => child.label === 'Check for Updates…'))
      return { found: Boolean(parent), parent: parent?.label, platform: process.platform }
    })
    expect(updateMenu.found).toBe(true)
    expect(updateMenu.parent).toBe(updateMenu.platform === 'darwin' ? 'GooeyPi' : 'Help')
    await expect(page.evaluate(() => window.prime.updates.getState())).resolves.toMatchObject({ phase: 'unsupported' })
    const credentialStatus = await page.evaluate(() => window.prime.voice.credentialStatus())
    expect(typeof credentialStatus.storage.available).toBe('boolean')
    if (!credentialStatus.storage.available) expect(credentialStatus.storage.message).toMatch(/secure|credential|keyring|kwallet/i)
    const invalidSelfHostedTest = await page.evaluate(async () => {
      try { await window.prime.voice.testSelfHosted({ url: '', model: '' }); return '' }
      catch (error) { return String(error) }
    })
    expect(invalidSelfHostedTest).toMatch(/too short|Invalid URL/)
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((window) => !window.isVisible()))).toBe(true)
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.sidebar__brand small')).toHaveText('Work')
    await expect(page.locator('.sidebar__brand .prime-mark svg path')).toHaveCount(2)
    await expect(page.locator('.prime-mark img')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer .sidebar-update')).toHaveCount(0)
    await expect(page.locator('.sidebar__footer button[title="Settings"]')).toBeVisible()
  })

  test('left aligns the harness picker for Linux and Windows chrome', async () => {
    const shell = page.locator('.app-shell')
    const sidebar = page.locator('.sidebar')
    const clearance = page.locator('.sidebar__titlebar .traffic-light-clearance')
    const trigger = page.getByRole('button', { name: 'Prime Work — switch harness' })
    for (const platform of ['linux', 'win32']) {
      await shell.evaluate((node, value) => { node.setAttribute('data-platform', value) }, platform)
      await expect(clearance).toHaveCSS('display', 'none')
      const offset = await trigger.evaluate((node) => node.getBoundingClientRect().left - node.closest('.sidebar')!.getBoundingClientRect().left)
      expect(offset).toBeLessThanOrEqual(8)
      expect(offset).toBeGreaterThanOrEqual(0)
    }
    await expect(sidebar).toBeVisible()
  })

  test('opens General settings when the main process requests Settings', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible()

    await app!.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('app:open-settings')
    })

    await expect(page.getByRole('heading', { name: 'Startup & background' })).toBeVisible()
  })

  test('returns from settings with its back button, New session, Escape, and Ctrl+W', async () => {
    const openSettings = async () => {
      await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
      await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    }

    await openSettings()
    await page.getByRole('button', { name: 'Back to session' }).click()
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toBeVisible()

    await openSettings()
    await page.locator('.sidebar__primary').getByRole('button', { name: /^New session/ }).click()
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toBeVisible()

    await openSettings()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toBeVisible()

    await openSettings()
    await page.keyboard.press('Control+w')
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toBeVisible()
  })

  test('keeps the application shell fixed when focus reveals root overflow', async () => {
    const layout = await page.evaluate(() => {
      const root = document.getElementById('root')
      const shell = document.querySelector<HTMLElement>('.app-shell')
      if (!root || !shell) throw new Error('Application shell is missing')

      const probe = document.createElement('button')
      probe.type = 'button'
      probe.textContent = 'Root overflow focus probe'
      root.append(probe)

      try {
        const initialShellTop = shell.getBoundingClientRect().top
        probe.focus()
        probe.scrollIntoView({ block: 'end' })
        return {
          activeElement: document.activeElement === probe,
          clientHeight: root.clientHeight,
          overflow: getComputedStyle(root).overflow,
          scrollHeight: root.scrollHeight,
          scrollTop: root.scrollTop,
          initialShellTop,
          shellTop: shell.getBoundingClientRect().top,
        }
      } finally {
        probe.remove()
      }
    })

    expect(layout.activeElement).toBe(true)
    expect(layout.overflow).toBe('clip')
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight)
    expect(layout.scrollTop).toBe(0)
    expect(layout.shellTop).toBe(layout.initialShellTop)
  })

  test('uses the persisted selected pet for realtime voice after a full restart', async () => {
    const desktopPet = page.getByRole('button', { name: /Orb, draggable GooeyPi pet/ })
    await expect(desktopPet).toBeVisible()
    await desktopPet.hover()
    await expect(desktopPet).not.toHaveAttribute('title')
    await expect(page.locator('.desktop-pet__name')).toHaveCount(0)
    const idlePetGap = await page.locator('.desktop-pet').evaluate((surface) => {
      const avatar = surface.querySelector<HTMLElement>('.desktop-pet__avatar')!.getBoundingClientRect()
      const waveform = surface.querySelector<HTMLButtonElement>('[aria-label="Open realtime voice"]')!.getBoundingClientRect()
      return waveform.top - avatar.bottom
    })
    expect(idlePetGap).toBeGreaterThanOrEqual(-8)
    expect(idlePetGap).toBeLessThanOrEqual(1)
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    await expect(page.getByRole('complementary', { name: 'Realtime voice session' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Orb, draggable GooeyPi pet/ })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await page.getByRole('complementary', { name: 'Realtime voice session' }).getByRole('button', { name: 'Close realtime voice' }).click()

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Pets', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Pets', exact: true })).toBeVisible()
    await expect(page.getByRole('radio', { name: /^Orb Built/ })).toBeChecked()
    await page.getByRole('radio', { name: /^GooeyPi Built/ }).click()
    await expect(page.getByRole('radio', { name: /^GooeyPi Built/ })).toBeChecked()
    await expect(page.getByRole('heading', { name: 'Codex Pets' })).toBeVisible()
    const showPet = page.getByRole('checkbox', { name: 'Show desktop pet' })
    await showPet.focus()
    await showPet.press('Space')
    await expect(showPet).not.toBeChecked()
    await expect(page.locator('.desktop-pet')).toHaveCount(0)
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings).toMatchObject({ petEnabled: false, petId: 'gooey-pi' })

    await closeHermeticApp(app)
    app = undefined
    if (!currentFixture) throw new Error('Missing hermetic fixture for relaunch')
    app = await electron.launch({
      args: ['.', `--user-data-dir=${currentFixture.userData}`],
      cwd: process.cwd(),
      env: hermeticEnvironment(currentFixture.home, currentFixture.executable, currentFixture.ompExecutable, currentFixture.piExecutable, currentFixture.cuaExecutable, false) as Record<string, string>,
      timeout: 20_000,
    })
    app.context().on('page', attachDiagnostics)
    for (const target of app.windows()) attachDiagnostics(target)
    page = await app.firstWindow({ timeout: 15_000 })
    attachDiagnostics(page)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 })

    await expect(page.locator('.desktop-pet')).toHaveCount(0)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    const realtimePet = page.getByRole('complementary', { name: 'Realtime voice session' })
    await expect(realtimePet.getByRole('button', { name: /GooeyPi, draggable GooeyPi pet/ })).toBeVisible()
    await expect(realtimePet.locator('.pet-sprite img')).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
  })

  test('switches to OMP Work and lists the OMP session catalog, then returns to Prime', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    const ompBrand = page.getByRole('button', { name: 'OMP Work — switch harness' })
    await expect(ompBrand).toBeVisible()
    await expect(page.locator('.sidebar__brand .omp-mark')).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Capabilities' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('OMP fixture reply.')).toBeVisible()
    await ompBrand.click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
  })

  test('wraps an unbroken user-message token inside its chat bubble', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()

    const bubble = page.locator('.user-bubble').filter({ hasText: ISSUE_131_LONG_TOKEN })
    await expect(bubble).toBeVisible()
    const dimensions = await bubble.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth)
  })

  test('switches to Pi Work and lists the pi session catalog, then returns to Prime', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    const piBrand = page.getByRole('button', { name: 'Pi Work — switch harness' })
    await expect(piBrand).toBeVisible()
    await expect(page.locator('.sidebar__brand .pi-mark')).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Scheduled' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Capabilities' })).toBeVisible()
    await page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' }).click()
    await expect(page.getByRole('main').getByText('Pi fixture reply.')).toBeVisible()
    await piBrand.click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByRole('button', { name: 'Prime Work — switch harness' })).toBeVisible()
    await expect(page.locator('.session-row__title').filter({ hasText: 'Hermetic desktop fixture' })).toBeVisible()
  })

  test('closes realtime voice before switching harnesses', async () => {
    await page.locator('.title-toolbar').getByRole('button', { name: 'Open realtime voice' }).click()
    const petSurface = page.locator('.desktop-pet')
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toBeVisible()
    await expect(page.locator('.voice-orb')).toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await expect(petSurface.getByRole('button', { name: 'Mute realtime voice' })).toHaveCount(0)
    await expect(petSurface.getByRole('button', { name: 'Open realtime voice' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'OMP Work — switch harness' })).toBeVisible()
  })

  test('persists a desktop-only OMP provider toggle and removes its models from the picker', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    const voiceModelsBefore = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsBefore.models.map((model) => model.name).sort()).toEqual(['Claude Fixture', 'GPT Fixture'])
    const anthropic = page.getByRole('checkbox', { name: 'Show anthropic provider' })
    await expect(anthropic).toBeChecked()
    await page.getByTitle('Hide provider in OMP').filter({ has: anthropic }).click()
    await expect(anthropic).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['anthropic'])
    const voiceModelsAfter = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModelsAfter.models.map((model) => model.name)).toEqual(['GPT Fixture'])

    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.getByRole('combobox', { name: 'Model' })
    await expect(modelPicker.locator('option', { hasText: 'GPT Fixture' })).toHaveCount(1)
    await expect(modelPicker.locator('option', { hasText: 'Claude Fixture' })).toHaveCount(0)
  })

  test('persists an OMP model toggle and removes only that model from every picker', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()

    const toggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    const groupHeader = page.locator('.provider-model-group__heading[aria-controls="provider-models-openai-codex"]')
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toBeHidden()
    await groupHeader.click()
    await expect(groupHeader).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toBeVisible()
    await expect(toggle).toBeChecked()
    const row = page.locator('.provider-model-row').filter({ has: toggle })
    await expect(row.locator('.provider-model-row__capabilities')).toBeVisible()
    await expect(row.locator('.provider-model-row__toggle')).toBeVisible()
    await row.locator('.provider-model-row__toggle').click()
    await expect(toggle).not.toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual(['openai-codex/gpt-fixture'])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual(['openai-codex'])
    const groups = page.locator('.provider-model-group')
    await expect(groups.nth(0)).toContainText('Claude Fixture')
    await expect(groups.nth(1)).toContainText('GPT Fixture')

    const voiceModels = await page.evaluate(async () => JSON.parse((await window.prime.voice.executeTool({ name: 'list_models', arguments: {} }, 'omp')).output) as { models: Array<{ name: string }> })
    expect(voiceModels.models.map((model) => model.name)).toEqual(['Claude Fixture'])
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    const modelPicker = page.getByRole('combobox', { name: 'Model' })
    await expect(modelPicker.locator('option', { hasText: 'GPT Fixture' })).toHaveCount(0)
    await expect(modelPicker.locator('option', { hasText: 'Claude Fixture' })).toHaveCount(1)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await page.getByRole('tab', { name: /Models/ }).click()
    const hiddenToggle = page.getByRole('checkbox', { name: 'Show GPT Fixture model' })
    await page.locator('.provider-model-row').filter({ has: hiddenToggle }).locator('.provider-model-row__toggle').click()
    await expect(hiddenToggle).toBeChecked()
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledModels).toEqual([])
    await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.ompDisabledProviders).toEqual([])
    await page.getByRole('tab', { name: /Providers/ }).click()
    await expect(page.getByRole('checkbox', { name: 'Show openai-codex provider' })).toBeChecked()
  })

  test('keeps Harness settings shared when changing the default while providers follow the active harness', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByText('OMP approval mode', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Prime Agent executable override')).toBeVisible()
    await expect(page.getByLabel('OMP executable override')).toBeVisible()
    await expect(page.getByLabel('Pi executable override')).toBeVisible()

    const selects = page.locator('.settings-content select')
    await selects.nth(0).selectOption('pi')
    await expect(page.getByRole('button', { name: 'Pi Work — switch harness' })).toBeVisible()
    await expect(page.getByText('OMP approval mode', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByText('Pi catalogue', { exact: true })).toBeVisible()
  })

  test('refreshes harness discovery through the live settings and preload path', async () => {
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()

    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByText('Prime Agent is ready', { exact: true })).toBeVisible()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()
    await expect(page.getByText('Pi is ready', { exact: true })).toBeVisible()

    const result = await page.evaluate(() => window.prime.app.refreshHarnesses())
    expect(result.meta.harnesses.prime.path).toBeTruthy()
    expect(result.meta.harnesses.omp.path).toBeTruthy()
    expect(result.meta.harnesses.pi.path).toBeTruthy()

    await page.getByRole('button', { name: /Work — switch harness/ }).click()
    await expect(page.getByRole('menuitemradio')).toHaveCount(3)
  })

  test('adds and connects to a harness installed while the app is open', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await expect(page.getByRole('menuitemradio', { name: /OMP Work/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const ompExecutable = join(fixtureRoot, 'omp-fixture.cjs')
    renameSync(`${ompExecutable}.pending`, ompExecutable)
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByText('OMP not detected', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Refresh harnesses' }).click()
    await expect(page.getByText('OMP is ready', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude-fixture')
    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Connect to the newly installed harness')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'omp-runtime-args.json'))).toBe(true)
  })

  test('opens Harness settings from the no-harness recovery prompt', async () => {
    await expect(page.getByRole('heading', { name: 'No Pi family harness detected' })).toBeVisible()
    await expect(page.getByText('Install one to get started.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Take me there' }).click()
    await expect(page.getByRole('heading', { name: 'Harness', exact: true, level: 1 })).toBeVisible()
    const refresh = page.getByRole('button', { name: 'Refresh harnesses' })
    await expect(refresh).toBeVisible()
    await expect(page.getByLabel('Pi executable override')).toBeVisible()
    await refresh.click()
    await expect(refresh).toBeEnabled()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('keeps thread order stable and mutes acknowledged failure indicators', async () => {
    const titles = page.locator('.session-row__title')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    await expect(titles.nth(1)).toHaveText('Primary workspace fixture')
    const primaryFile = join(fixtureSessionFile, '..', 'primary.jsonl')
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-background-assistant', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Background work failed.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')
    await expect(titles.nth(0)).toHaveText('Hermetic desktop fixture')
    const attentionColor = await primaryRow.evaluate((node) => getComputedStyle(node).backgroundColor.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [])
    expect(attentionColor.length).toBeGreaterThanOrEqual(3)
    expect(attentionColor[2]).toBeGreaterThan(attentionColor[1])

    const failureMark = primaryRow.locator('.session-status-mark--failed')
    const activeFailureColor = await failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)

    await primaryRow.locator('.session-row').click()
    await expect(primaryRow).not.toHaveClass(/has-attention/)
    await expect(primaryRow).toHaveClass(/session-row-wrap--failed/)
    await expect(failureMark).toHaveAttribute('title', 'Failed — notification cleared')
    await expect.poll(() => failureMark.locator('> span').evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe(activeFailureColor)
    await expect(activityCount).toHaveCount(0)
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-new-user', parentId: 'primary-background-assistant', timestamp: '2028-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Move this thread now.' },
    })}\n`)
    await expect(titles.nth(0)).toHaveText('Primary workspace fixture')
  })

  test('clears individual and all Activity notifications persistently', async () => {
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    const primaryActivity = page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })
    const fixtureActivity = page.locator('.activity-row').filter({ hasText: 'Hermetic desktop fixture' })
    await expect(primaryActivity).toBeVisible()
    await expect(fixtureActivity).toBeVisible()

    const clearPrimary = primaryActivity.getByRole('button', { name: 'Clear Primary workspace fixture activity' })
    await primaryActivity.hover()
    await expect(clearPrimary).toHaveCSS('opacity', '1')
    await clearPrimary.click()
    await expect(primaryActivity).toHaveCount(0)
    await expect(fixtureActivity).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('prime-work.cleared-activity') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.reload()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.locator('.activity-row').filter({ hasText: 'Primary workspace fixture' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear all' }).click()
    await expect(page.getByRole('heading', { name: 'You’re all caught up' })).toBeVisible()
  })

  test('removes archived chats from Activity and clears their notifications', async () => {
    const primaryFile = join(fixtureSessionFile, '..', 'primary.jsonl')
    appendFileSync(primaryFile, `${JSON.stringify({
      type: 'message', id: 'primary-archive-failure', parentId: 'primary-message', timestamp: '2027-01-01T00:00:00.000Z',
      message: { role: 'assistant', content: 'Archive this failed work.', stopReason: 'error' },
    })}\n`)

    const primaryRow = page.locator('.session-row-wrap').filter({ hasText: 'Primary workspace fixture' })
    await expect(primaryRow).toHaveClass(/has-attention/)
    const activityCount = page.locator('.sidebar__primary button[title="Activity"] .nav-count')
    await expect(activityCount).toHaveText('1')

    await primaryRow.getByTitle('Archive Primary workspace fixture').click()
    await primaryRow.getByTitle('Confirm archive Primary workspace fixture').click()
    await expect(primaryRow).toHaveCount(0)
    await expect(activityCount).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => {
      const cleared = JSON.parse(window.localStorage.getItem('prime-work.cleared-session-attention') ?? '{}') as Record<string, string>
      return cleared['primary-session']
    })).toBeTruthy()

    await page.getByRole('button', { name: 'Activity', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
    await expect(page.getByText('Primary workspace fixture', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Archived', exact: true })).toHaveCount(0)
  })

  test('destroys an open session browser guest when its thread is archived', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const preview = page.locator('.browser-preview webview[partition="persist:prime-work-browser"]')
    await expect(preview).toHaveCount(1)
    await expect.poll(() => preview.evaluate(async (node) => {
      const webview = node as HTMLElement & {
        executeJavaScript(script: string): Promise<unknown>
        getWebContentsId(): number
      }
      await webview.executeJavaScript('window.__fixtureGameTimer = setInterval(() => {}, 10)')
      return webview.getWebContentsId()
    })).toBeGreaterThan(0)
    const guestId = await preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())
    expect(await app!.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), guestId)).toBe(true)

    await sessionRow.getByTitle('Archive Hermetic desktop fixture').click()
    await sessionRow.getByTitle('Confirm archive Hermetic desktop fixture').click()

    await expect(sessionRow).toHaveCount(0)
    await expect.poll(() => app!.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)
      return guest === undefined || guest.isDestroyed()
    }, guestId)).toBe(true)
    await expect.poll(() => preview.evaluate((node) => (node as HTMLElement & { getWebContentsId(): number }).getWebContentsId())).not.toBe(guestId)
  })

  test('stops a dev server launched from the thread terminal when archived', async () => {
    const sessionRow = page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' })
    await sessionRow.locator('.session-row').click()
    await page.getByLabel(/Toggle terminal/).click()
    const terminal = page.locator('.terminal-drawer:not([hidden])')
    const input = terminal.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    const pidFile = join(fixtureRoot, 'archived-dev-server.pid')
    await input.click()
    await page.keyboard.type(`/bin/sh -c 'echo $$ > ${pidFile}; while true; do /bin/sleep 1; done'`)
    await page.keyboard.press('Enter')
    await expect.poll(() => existsSync(pidFile)).toBe(true)
    const serverPid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(serverPid).toBeGreaterThan(0)

    try {
      await sessionRow.getByTitle('Archive Hermetic desktop fixture').click()
      await sessionRow.getByTitle('Confirm archive Hermetic desktop fixture').click()

      await expect(sessionRow).toHaveCount(0)
      await expect(page.locator('.terminal-drawer')).toHaveCount(0)
      await expect.poll(() => {
        try { process.kill(serverPid, 0); return false } catch { return true }
      }).toBe(true)
    } finally {
      try { process.kill(serverPid, 'SIGKILL') } catch { /* archive cleanup succeeded */ }
    }
  })

  test('enforces the live preload and IPC frame boundaries', async () => {
    const initialMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(initialMeta.version).toBeTruthy()

    await page.evaluate(() => { window.location.hash = 'cfr-11-safe-fragment' })
    await expect(page).toHaveURL(/#cfr-11-safe-fragment$/)
    const fragmentMeta = await page.evaluate(() => window.prime.app.getMeta())
    expect(fragmentMeta).toEqual(initialMeta)

    await page.evaluate(() => {
      const iframe = document.createElement('iframe')
      iframe.name = 'untrusted-subframe'
      iframe.srcdoc = '<!doctype html><title>Untrusted subframe</title>'
      document.body.append(iframe)
    })
    await expect.poll(() => Boolean(page.frame({ name: 'untrusted-subframe' }))).toBe(true)
    const subframe = page.frame({ name: 'untrusted-subframe' })
    expect(subframe).not.toBeNull()
    await subframe!.waitForLoadState()
    expect(await subframe!.evaluate(() => typeof (window as Window & { prime?: unknown }).prime)).toBe('undefined')

    const deniedUrl = 'data:text/html,<title>Untrusted renderer</title><main>untrusted</main>'
    await app!.evaluate(async ({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Expected the Prime Work window')
      await window.loadURL(url)
    }, deniedUrl)
    await expect(page).toHaveURL(/^data:text\/html,/)
    const deniedAccess = await page.evaluate(async () => {
      const prime = (window as Window & { prime?: typeof window.prime }).prime
      if (!prime) return { bridge: 'undefined', result: 'unavailable' }
      try {
        await prime.app.getMeta()
        return { bridge: 'object', result: 'resolved' }
      } catch (error) {
        return { bridge: 'object', result: error instanceof Error ? error.message : String(error) }
      }
    })
    expect(deniedAccess.bridge).toBe('object')
    expect(deniedAccess.result).toMatch(/IPC sender is not authorized/i)
  })

  test('defers a reply to a session that is active outside Prime Work', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Queue this follow-up from Prime Work')
    await composer.press('Enter')

    const queuedMessages = page.getByRole('region', { name: 'Queued messages' })
    await expect(queuedMessages.locator('.composer-queue__item')).toHaveCount(1)
    await expect(queuedMessages).toContainText('Queue this follow-up from Prime Work')
    expect(existsSync(join(fixtureRoot, 'follow-up-args.json'))).toBe(false)
    expect(existsSync(join(fixtureRoot, 'follow-up-ack.json'))).toBe(false)
    await expect(page.locator('.transcript').getByText('The external Prime Agent received the queued reply.')).toHaveCount(0)
    await expect(page.getByText(/Prime Agent RPC exited|Request failed/)).toHaveCount(0)

    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.getByRole('region', { name: 'Queued messages' })).toContainText('Queue this follow-up from Prime Work')
  })

  test('reflects an external JSONL append without reselecting the live session', async () => {
    await expect(page.locator('.transcript').getByText('Hermetic desktop fixture', { exact: true })).toBeVisible()
    const selectedSession = page.locator('.session-row-wrap.is-selected')
    await expect(selectedSession).toHaveCount(1)

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const reasoning = `External live reasoning ${nonce}`
    const answer = `External live answer ${nonce}`
    const timestamp = new Date().toISOString()
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message',
      id: `fixture-external-${nonce}`,
      parentId: 'fixture-goal-summary',
      timestamp,
      message: {
        role: 'assistant',
        timestamp,
        content: [
          { type: 'thinking', thinking: reasoning },
          { type: 'toolCall', id: `fixture-tool-${nonce}`, name: 'fixture_external_tool', arguments: { nonce } },
          { type: 'text', text: answer },
        ],
      },
    })}
`)

    await expect(page.locator('.transcript').getByText(reasoning, { exact: true })).toHaveCount(1)
    await expect(page.locator('.transcript').getByText(answer, { exact: true })).toHaveCount(1)
    await expect(page.locator('.activity-line--tool')).toContainText('fixture_external_tool')
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(selectedSession).toHaveCount(1)
  })

  test('keeps session options visible and starts a new session from a hovered project', async () => {
    const sessionOptions = page.locator('.session-row__more').first()
    await expect(sessionOptions).toBeVisible()
    await expect.poll(() => sessionOptions.evaluate((node) => getComputedStyle(node).opacity)).toBe('1')

    const projectRow = page.locator('.project-row').first()
    const projectSession = projectRow.getByRole('button', { name: /^New session in / })
    await expect.poll(() => projectSession.evaluate((node) => getComputedStyle(node).opacity)).toBe('0')
    await expect.poll(async () => {
      await projectRow.hover()
      return projectSession.evaluate((node) => getComputedStyle(node).opacity)
    }).toBe('1')
    await projectSession.click()

    await expect(projectRow).toHaveClass(/is-selected/)
    await expect(page.locator('.session-row-wrap.is-selected')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('keeps wrapped editing native and aligned through classic scrollbar overflow', async () => {
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await page.addStyleTag({ content: `
      .composer-input > textarea { overflow-y: scroll !important; }
      .composer-input > textarea::-webkit-scrollbar { width: 28px; }
    ` })

    await composer.fill('@Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await expect(composer).toHaveAttribute('aria-autocomplete', 'list')
    await reference.click()

    const longToken = 'unbroken-token-'.repeat(18)
    const draft = `@Ownership peer fixture\nFirst wrapped line ${'with words '.repeat(22)}\nEDITME ${longToken}\n${'final line '.repeat(30)}`
    await composer.fill(draft)
    const editStart = draft.indexOf('EDITME')
    await composer.evaluate((element, start) => {
      const textarea = element as HTMLTextAreaElement
      textarea.focus()
      textarea.setSelectionRange(start, start + 'EDITME'.length)
    }, editStart)
    await composer.pressSequentially('replacement')
    await expect(composer).toHaveValue(draft.replace('EDITME', 'replacement'))

    const layout = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      textarea.scrollTop = textarea.scrollHeight
      textarea.dispatchEvent(new Event('scroll'))
      const style = getComputedStyle(textarea)
      return {
        hasVerticalOverflow: textarea.scrollHeight > textarea.clientHeight,
        scrollbarWidth: textarea.offsetWidth - textarea.clientWidth,
        scrollTop: textarea.scrollTop,
        color: style.color,
        textFillColor: style.webkitTextFillColor,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        mirrorCount: textarea.parentElement?.querySelectorAll('.composer-input__highlight').length ?? -1,
      }
    })
    expect(layout.hasVerticalOverflow).toBe(true)
    expect(layout.scrollbarWidth).toBeGreaterThanOrEqual(24)
    expect(layout.scrollTop).toBeGreaterThan(0)
    expect(layout.selectionStart).toBe(layout.selectionEnd)
    expect(layout.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
    expect(layout.mirrorCount).toBe(0)

    await page.emulateMedia({ forcedColors: 'active' })
    const forcedColorText = await composer.evaluate((element) => {
      const style = getComputedStyle(element)
      return { color: style.color, textFillColor: style.webkitTextFillColor }
    })
    expect(forcedColorText.color).not.toBe('rgba(0, 0, 0, 0)')
    expect(forcedColorText.textFillColor).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('copies a session id and routes an @session mention without exposing its UUID block', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedSessionId?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedSessionId = text } },
      })
    })
    const selected = page.locator('.session-row-wrap.is-selected .session-row')
    await selected.click({ button: 'right' })
    const sessionMenu = page.getByLabel('Session options')
    await sessionMenu.getByRole('button', { name: 'Copy session UUID' }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedSessionId?: string }).__copiedSessionId)).toBe('fixture-session')

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Coordinate with @Ownership')
    const reference = page.getByRole('option', { name: /@Ownership peer fixture/ })
    await expect(reference).toBeVisible()
    await reference.click()
    const caret = await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement
      return { start: textarea.selectionStart, end: textarea.selectionEnd, length: textarea.value.length }
    })
    expect(caret).toEqual({ start: caret.length, end: caret.length, length: caret.length })
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await composer.pressSequentially('about ownership')
    await expect(composer).toHaveValue('Coordinate with @Ownership peer fixture about ownership')
    await composer.press('Enter')

    const marker = join(fixtureRoot, 'prompt-args.json')
    await expect.poll(() => existsSync(marker)).toBe(true)
    const sent = JSON.parse(readFileSync(marker, 'utf8')) as { message: string }
    expect(sent.message).toContain('Coordinate with @Ownership peer fixture about ownership')
    expect(sent.message).toContain('prime session UUID 019fdf24-cccc-7000-8000-000000000003')
    expect(sent.message).toContain('===== BEGIN GOOEYPI SESSION REFERENCES =====')
    appendFileSync(fixtureSessionFile, `${JSON.stringify({
      type: 'message', id: 'fixture-session-reference', parentId: 'fixture-goal-summary', timestamp: new Date().toISOString(),
      message: { role: 'user', content: sent.message, timestamp: new Date().toISOString() },
    })}\n`)
    await page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' }).locator('.session-row').click()
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const userMessage = page.locator('.message--user').filter({ hasText: 'Coordinate with @Ownership peer fixture about ownership' })
    await expect(userMessage).toBeVisible()
    await expect(userMessage).not.toContainText('019fdf24-cccc-7000-8000-000000000003')
    await expect(userMessage).not.toContainText('GOOEYPI SESSION REFERENCES')
    const linkedMention = userMessage.getByRole('button', { name: 'Open session Ownership peer fixture' })
    await expect(linkedMention).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(linkedMention).toHaveCSS('border-top-width', '0px')
    await linkedMention.click()
    await expect(page.locator('.session-row-wrap').filter({ hasText: 'Ownership peer fixture' })).toHaveClass(/is-selected/)
  })

  test('removes a project from the sidebar through its context menu', async () => {
    const projectRow = page.locator('.project-row').first()
    await expect(projectRow).toBeVisible()
    await expect(page.locator('.sidebar__primary .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.project-row__new-session .lucide-notebook-pen')).toHaveCount(1)
    await expect(page.locator('.sidebar__section-heading .lucide-folder-plus')).toHaveCount(1)
    await expect(page.getByTitle('New session (⌘N)')).toHaveCount(2)
    await expect(page.getByTitle('Add project')).toHaveCount(1)
    await expect(projectRow.getByTitle('New session in Multi-folder fixture')).toHaveCount(1)
    await expect(page.getByTitle('Archive Hermetic desktop fixture')).toHaveCount(1)

    await projectRow.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Project options for Multi-folder fixture' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Remove project' }).click()

    const dialog = page.getByRole('dialog', { name: 'Remove project' })
    await expect(dialog).toContainText('The folder and saved sessions will not be deleted.')
    await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.locator('.project-row')).toHaveCount(0)
    expect(existsSync(join(fixtureRoot, 'project'))).toBe(true)
  })

  test('renders agent handoffs and goal summaries as collapsed readable disclosures', async () => {
    const agentDisclosure = page.getByRole('button', { name: 'Message from agent: fixture-reviewer' })
    const goalDisclosure = page.getByRole('button', { name: 'Goal summary' })
    await expect(agentDisclosure).toHaveAttribute('aria-expanded', 'false')
    await expect(goalDisclosure).toHaveAttribute('aria-expanded', 'false')

    await agentDisclosure.click()
    await goalDisclosure.click()
    await expect(page.locator('.agent-message__content')).toContainText('Fixture review complete.')
    await expect(page.locator('.goal-message__content')).toContainText('Verify the readable blue goal summary.')
    await expect(page.getByText(/Envelope metadata|Fixture control envelope/)).toHaveCount(0)
  })

  test('copies a specific user or agent message from the action directly below it', async () => {
    await page.evaluate(() => {
      const target = window as Window & { __copiedMessage?: string }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { target.__copiedMessage = text } },
      })
    })

    const userMessage = page.locator('.message--user').filter({ hasText: 'Hermetic desktop fixture' })
    await userMessage.hover()
    const userCopy = userMessage.locator('.message-actions button')
    await expect(userCopy).toHaveAccessibleName('Copy user message')
    await expect(userCopy).toBeVisible()
    await userCopy.click()
    await expect(userCopy).toHaveAccessibleName('Copied user message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Hermetic desktop fixture')

    const agentMessage = page.locator('.message--agent')
    await expect(agentMessage.getByRole('button', { name: 'Copy agent message' })).toHaveCount(0)
    await agentMessage.getByRole('button', { name: 'Message from agent: fixture-reviewer' }).click()
    await agentMessage.hover()
    const agentCopy = agentMessage.locator('.message-actions button')
    await expect(agentCopy).toHaveAccessibleName('Copy agent message')
    await expect(agentCopy).toBeVisible()
    await agentCopy.click()
    await expect(agentCopy).toHaveAccessibleName('Copied agent message')
    await expect.poll(() => page.evaluate(() => (window as Window & { __copiedMessage?: string }).__copiedMessage)).toBe('Fixture review complete. The readable agent response is available here.')
  })

  test('navigates all primary workspace pages and command palette', async () => {
    for (const destination of ['Projects', 'Activity', 'Scheduled', 'Capabilities']) {
      await page.getByRole('button', { name: destination, exact: true }).click()
      await expect(page.locator('.page')).toBeVisible()
      if (destination === 'Capabilities') {
        await expect(page.locator('.feature-strip')).toHaveCount(0)
        await expect(page.locator('.directory-tools')).toBeVisible()
        const askUserToggle = page.getByRole('button', { name: 'Enable Ask user' })
        await expect(askUserToggle).toHaveAttribute('aria-pressed', 'false')
        await askUserToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        await page.getByRole('button', { name: 'Disable Ask user' }).click()
        const askUserConfirmation = page.getByRole('dialog', { name: 'Disable Ask user?' })
        await expect(askUserConfirmation).toContainText('Are you sure?')
        await askUserConfirmation.getByRole('button', { name: 'Yes, disable' }).click()
        await expect(page.getByRole('button', { name: 'Enable Ask user' })).toHaveAttribute('aria-pressed', 'false')
        await page.getByRole('button', { name: 'Enable Ask user' }).click()
        await expect(page.getByRole('button', { name: 'Disable Ask user' })).toHaveAttribute('aria-pressed', 'true')
        const browserToggle = page.getByRole('button', { name: 'Disable Browser' })
        await browserToggle.click()
        const browserConfirmation = page.getByRole('dialog', { name: 'Disable Browser?' })
        await browserConfirmation.getByRole('button', { name: 'Cancel' }).click()
        await expect(page.getByRole('button', { name: 'Disable Browser' })).toHaveAttribute('aria-pressed', 'true')
        const computerUseToggle = page.getByRole('button', { name: 'Enable Computer Use | TryCUA' })
        await expect(computerUseToggle).toHaveAttribute('aria-pressed', 'false')
        await computerUseToggle.click()
        await expect(page.getByRole('button', { name: 'Disable Computer Use | TryCUA' })).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => JSON.parse(readFileSync(join(fixtureRoot, 'user-data', CURRENT_DESKTOP_STATE_FILENAME), 'utf8')).settings.computerUseEnabled).toBe(true)
        await page.getByRole('button', { name: 'Add', exact: true }).click()
        const addDialog = page.getByRole('dialog', { name: 'Add a Prime capability' })
        await expect(addDialog.getByText('Add MCP', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Package', { exact: true })).toBeVisible()
        await expect(addDialog.getByText('Add Extension', { exact: true })).toBeVisible()
        await expect(addDialog.getByText(/Not every third-party package, plugin, or extension will work in GooeyPi/)).toBeVisible()
        const addMcp = addDialog.getByRole('button', { name: /Add MCP/ })
        await expect(addMcp).toBeDisabled()
        await expect(addMcp).toContainText('Prime MCP setup is managed outside GooeyPi')
        await expect(addDialog.getByText('Server URL', { exact: true })).toHaveCount(0)
        await expect(addDialog.getByText('Authentication', { exact: true })).toHaveCount(0)
        await addDialog.getByRole('button', { name: 'Close' }).click()
      }
    }
    await page.locator('.sidebar__footer button').filter({ hasText: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'General' })).toBeVisible()
    await page.getByRole('button', { name: 'Providers', exact: true }).click()
    await expect(page.getByLabel('Search providers')).toBeVisible()
    await expect(page.locator('.provider-row')).not.toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Disable all', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Disable all', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable all', exact: true })).toBeVisible()
    await expect(page.locator('.provider-row input[type="checkbox"]:checked')).toHaveCount(0)
    await page.getByRole('tab', { name: /Models/ }).click()
    await expect(page.getByLabel('Search models')).toBeVisible()
    await expect(page.locator('.provider-model-row')).not.toHaveCount(0)
    await page.getByRole('button', { name: 'Harness', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: /Show reasoning summaries/ })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: /Show tool calls/ })).toBeChecked()
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('installs, disables, and restores Pi MCP support from its directory toggle', async () => {
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()

    const enable = page.getByRole('button', { name: 'Enable Pi MCP Adapter' })
    await expect(enable).toHaveAttribute('aria-pressed', 'false')
    await enable.click()
    await expect(page.getByRole('button', { name: 'Disable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'true')
    const settingsPath = join(fixtureRoot, 'home', '.pi', 'agent', 'settings.json')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toContain('npm:pi-mcp-adapter')
    await expect(page.getByRole('status').filter({ hasText: 'Pi MCP Adapter installed.' })).toBeVisible()

    await page.getByRole('button', { name: 'Pi Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Prime Work/ }).click()
    await expect(page.getByText('Pi MCP Adapter installed.')).toHaveCount(0)
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await expect(page.getByRole('heading', { name: 'Extend Pi' })).toBeVisible()

    await page.getByRole('button', { name: 'Add', exact: true }).click()
    const chooser = page.getByRole('dialog', { name: 'Add a Pi capability' })
    await chooser.getByRole('button', { name: /Add MCP/ }).click()
    const addDialog = page.getByRole('dialog', { name: 'Add MCP server' })
    await addDialog.getByLabel('Server name').fill('docs')
    await addDialog.getByLabel('Executable').fill('mcp-docs')
    await addDialog.getByLabel(/Arguments/).fill('--local')
    await addDialog.getByRole('button', { name: 'Save local server' }).click()
    const mcpPath = join(fixtureRoot, 'home', '.pi', 'agent', 'mcp.json')
    await expect.poll(() => existsSync(mcpPath) ? JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers.docs : null).toEqual({ command: 'mcp-docs', args: ['--local'], enabled: true })

    await addDialog.getByRole('button', { name: 'Close' }).click()

    await page.getByRole('button', { name: 'Disable Pi MCP Adapter' }).click()
    const confirmation = page.getByRole('dialog', { name: 'Disable Pi MCP Adapter?' })
    await expect(confirmation).toContainText('Are you sure?')
    await confirmation.getByRole('button', { name: 'Yes, disable' }).click()
    await expect(page.getByRole('button', { name: 'Enable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toEqual([
      { source: 'npm:pi-mcp-adapter', extensions: [], skills: [], prompts: [], themes: [] },
    ])

    await page.getByRole('button', { name: 'Enable Pi MCP Adapter' }).click()
    await expect(page.getByRole('button', { name: 'Disable Pi MCP Adapter' })).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => JSON.parse(readFileSync(settingsPath, 'utf8')).packages).toContain('npm:pi-mcp-adapter')
  })

  test('keeps transcript text from showing through the composer disclaimer', async () => {
    await page.getByRole('button', { name: 'Toggle inspector' }).click()
    await expect(page.locator('.composer-note')).toBeVisible()
    const colors = await page.locator('.composer-note').evaluate((node) => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--canvas)'
      document.body.append(probe)
      const canvas = getComputedStyle(probe).backgroundColor
      probe.remove()
      return { note: getComputedStyle(node).backgroundColor, canvas }
    })
    expect(colors.note).toBe(colors.canvas)
    expect(colors.note).not.toContain('rgba')
  })

  test('applies themed native select colors and restores system appearance', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    const nativeSelectTheme = () => page.evaluate(() => {
      const select = document.createElement('select')
      const option = document.createElement('option')
      option.textContent = 'Theme probe'
      select.append(option)
      document.body.append(select)
      const root = getComputedStyle(document.documentElement)
      const selectStyle = getComputedStyle(select)
      const optionStyle = getComputedStyle(option)
      const result = {
        scheme: selectStyle.colorScheme,
        optionColor: optionStyle.color,
        optionBackground: optionStyle.backgroundColor,
        themeColor: root.getPropertyValue('--text').trim(),
        themeBackground: root.getPropertyValue('--surface-raised').trim(),
      }
      select.remove()
      return result
    })
    await page.getByRole('button', { name: /Light/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'light',
      optionColor: 'rgb(32, 32, 30)',
      optionBackground: 'rgb(255, 255, 255)',
      themeColor: '#20201e',
      themeBackground: '#ffffff',
    })
    await page.getByRole('button', { name: /Dark/ }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    expect(await nativeSelectTheme()).toMatchObject({
      scheme: 'dark',
      optionColor: 'rgb(241, 241, 238)',
      optionBackground: 'rgb(34, 34, 32)',
      themeColor: '#f1f1ee',
      themeBackground: '#222220',
    })
    await page.getByRole('button', { name: /System/ }).click()
  })

  test('increases interface text within the bounded appearance choices', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByRole('radio', { name: 'Larger', exact: true }).click()
    await expect(page.getByRole('radio', { name: 'Larger', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.15, 2)

    await page.setViewportSize({ width: 480, height: 700 })
    const fits = await page.locator('.settings-row--text-size').evaluate((row) => row.scrollWidth <= row.clientWidth)
    expect(fits).toBe(true)
    await page.setViewportSize({ width: 1440, height: 920 })
    await page.getByRole('radio', { name: 'Default', exact: true }).click()
    await expect.poll(async () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getZoomFactor())).toBeCloseTo(1.1, 2)
  })

  test('traps modal focus, closes on Escape, and restores the trigger', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
    const trigger = page.getByRole('button', { name: 'Clear data' })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Clear browser data?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
    await expect(page.locator('.app-shell')).toHaveAttribute('inert')
    await page.keyboard.press('Meta+K')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(page.locator('.app-shell')).not.toHaveAttribute('inert')
  })

  test('supports keyboard navigation for composer suggestions', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('/')
    const options = page.locator('.composer-menu').getByRole('option')
    await expect(options).toHaveCount(5)
    await expect(composer).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')
    await expect(composer).toHaveValue('/plan ')
    await expect(composer).toHaveAttribute('aria-expanded', 'false')
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await expect(page.getByRole('combobox', { name: 'Message Prime' })).toHaveValue('')
  })

  test('routes the Prime MCP slash command to Capabilities without starting an agent turn', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('/mcp')
    await expect(page.locator('.composer-menu').getByRole('option', { name: /\/mcp View MCP integrations/ })).toBeVisible()
    await page.getByRole('button', { name: 'Send message' }).click()

    await expect(page.getByRole('heading', { name: /Extend/ })).toBeVisible()
    await expect(page.getByText('Manage packages, extensions, MCP servers, and reusable skills for this harness.')).toBeVisible()
    expect(existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(false)
  })

  test('shows built-in Prime MCPs without inspecting or changing authorization', async () => {
    await page.getByRole('button', { name: 'Capabilities', exact: true }).click()
    const notion = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Notion', exact: true }) })
    await expect(notion).toContainText('Configuration and authorization are managed directly in Prime Agent')
    await expect(notion.getByLabel('Externally managed Notion')).toBeVisible()
    await expect(notion.getByRole('button', { name: 'Disable Notion' })).toHaveCount(0)
    await expect(notion.getByRole('button', { name: 'Forget authorization for Notion' })).toHaveCount(0)
    const notionBox = await notion.boundingBox()
    const controlBox = await notion.getByLabel('Externally managed Notion').boundingBox()
    if (!notionBox || !controlBox) throw new Error('Notion capability controls did not render')
    expect(Math.abs(notionBox.x + notionBox.width - controlBox.x - controlBox.width)).toBeLessThanOrEqual(6)
    await expect(notion.getByRole('button', { name: 'Remove Notion' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Ask user' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Browser' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Remove Computer Use | TryCUA' })).toHaveCount(0)
    expect(JSON.parse(readFileSync(join(fixtureRoot, 'home', '.prime', 'agent', 'auth.json'), 'utf8'))['mcp:notion'].access).toBe('fixture-token')
  })

  test('round-trips a grouped Prime ask_user questionnaire', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Ask me two questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(page.locator('.work-disclosure__rail')).toBeVisible()
    const workStatus = page.locator('.work-disclosure__status')
    await expect(workStatus).toHaveAttribute('role', 'status')
    await expect(workStatus).toContainText('Working')
    await expect(page.locator('.activity-line--reasoning')).toContainText('Reviewing the available release channels')
    await expect(page.locator('.thinking-dots > span')).toHaveCount(3)
    await expect(page.locator('.work-disclosure__button')).toHaveCount(0)
    await expect(dialog).toContainText('Question 1 of 2')
    const context = dialog.getByRole('textbox', { name: 'Additional context' })
    await context.fill('For the pilot')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Safety' }).click()
    await expect(dialog).toContainText('Submit answers')
    const submitStep = dialog.locator('.extension-questionnaire__progress button').last()
    await expect(submitStep).toHaveAttribute('aria-current', 'step')
    await expect(submitStep).toBeFocused()
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 2 of 2')
    await expect(dialog.getByRole('option', { name: 'Safety' })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Control+ArrowLeft')
    await expect(dialog).toContainText('Question 1 of 2')
    await expect(dialog.getByRole('textbox', { name: 'Additional context' })).toHaveValue('For the pilot')
    await page.keyboard.press('Control+ArrowRight')
    await expect(dialog).toContainText('Question 2 of 2')

    await dialog.getByRole('option', { name: 'Other (type your own answer)' }).click()
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('A custom priority')
    await page.keyboard.press('Enter')
    await expect(dialog).toContainText('Submit answers')
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    expect(JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8'))).toMatchObject({
      type: 'prompt',
      message: 'Ask me two questions',
    })
    const runtimeArgs = JSON.parse(readFileSync(join(fixtureRoot, 'prime-runtime-args.json'), 'utf8')) as string[]
    expect(runtimeArgs).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    const worked = page.locator('.work-disclosure__button')
    await expect(worked).toContainText(/^Worked for /)
    await expect(worked).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.activity-line--reasoning')).toHaveCount(0)
    await worked.click()
    await expect(page.locator('.activity-line--question')).toContainText('What should I optimize for?')

    const completedRow = page.locator('.session-row-wrap').filter({ hasText: 'Post-completion catalog refresh' })
    await expect(completedRow).toHaveCount(1)
    await expect(completedRow).toHaveClass(/session-row-wrap--complete/)
    await expect(completedRow).toHaveClass(/is-selected/)
    await expect(completedRow).not.toHaveClass(/has-attention/)
    await expect(page.getByRole('status', { name: 'A session turn ended or needs attention' })).toHaveCount(0)
    await completedRow.locator('.session-row').click()
  })

  test('injects ask_user into OMP and answers its grouped questionnaire in the app', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /OMP Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'OMP hermetic fixture' }).click()
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude-fixture')

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('Ask me two OMP questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Which OMP release channel?')
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('OMP app verification')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('What should OMP optimize for?')
    await dialog.getByRole('option', { name: 'Safety' }).click()
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const valuesPath = join(fixtureRoot, 'omp-questionnaire-values.json')
    await expect.poll(() => existsSync(valuesPath)).toBe(true)
    expect(JSON.parse(readFileSync(valuesPath, 'utf8'))).toEqual({
      'omp-fixture-question-1': JSON.stringify({ answer: 'Beta', answerSource: 'option', context: 'OMP app verification' }),
      'omp-fixture-question-2': JSON.stringify({ answer: 'Safety', answerSource: 'option' }),
    })
    const runtimeArgs = JSON.parse(readFileSync(join(fixtureRoot, 'omp-runtime-args.json'), 'utf8')) as string[]
    const injectedExtensions = runtimeArgs.flatMap((value, index) => value === '--extension' ? [runtimeArgs[index + 1]] : [])
    expect(injectedExtensions).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/OMP RPC exited|Request failed/)).toHaveCount(0)
  })

  test('injects ask_user into Pi and answers its grouped questionnaire in the app', async () => {
    await page.evaluate(() => window.prime.settings.update({ askUserEnabled: true }))
    await page.getByRole('button', { name: 'Prime Work — switch harness' }).click()
    await page.getByRole('menuitemradio', { name: /Pi Work/ }).click()
    await page.locator('.session-row__title').filter({ hasText: 'Pi hermetic fixture' }).click()
    await expect(page.getByRole('combobox', { name: 'Model' })).toHaveValue('anthropic/claude-fixture')

    const composer = page.getByRole('combobox', { name: 'Message Pi' })
    await composer.fill('Ask me two Pi questions')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Answer 2 questions' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Which Pi release channel?')
    await dialog.getByRole('option', { name: 'Beta' }).click()
    await expect(dialog).toContainText('What should Pi optimize for?')
    await dialog.getByRole('textbox', { name: 'Additional context' }).fill('Pi app verification')
    await dialog.getByRole('option', { name: 'Safety' }).click()
    await dialog.getByRole('button', { name: 'Submit answers', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const valuesPath = join(fixtureRoot, 'pi-questionnaire-values.json')
    await expect.poll(() => existsSync(valuesPath)).toBe(true)
    expect(JSON.parse(readFileSync(valuesPath, 'utf8'))).toEqual({
      'pi-fixture-question-1': JSON.stringify({ answer: 'Beta', answerSource: 'option' }),
      'pi-fixture-question-2': JSON.stringify({ answer: 'Safety', answerSource: 'option', context: 'Pi app verification' }),
    })
    const runtime = JSON.parse(readFileSync(join(fixtureRoot, 'pi-runtime-args.json'), 'utf8')) as { args: string[]; cwd: string }
    const injectedExtensions = runtime.args.flatMap((value, index) => value === '--extension' ? [runtime.args[index + 1]] : [])
    expect(injectedExtensions).toContain(join(process.cwd(), 'assets', 'extensions', 'omp-work-ask-user.ts'))
    expect(runtime.args).not.toContain('--cwd')
    if (!currentFixture) throw new Error('Missing hermetic fixture')
    expect(runtime.cwd).toBe(realpathSync(currentFixture.project))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-ready', 'true')
    await expect(page.getByText(/Pi RPC exited|Request failed/)).toHaveCount(0)
  })

  test('preserves a rejected shell draft while rolling back the committed setting', async () => {
    await page.keyboard.press('Meta+,')
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    const shell = page.getByLabel('Shell executable')
    const rejectedDraft = '/definitely/not-an-executable'
    await expect(shell).toHaveValue('/bin/zsh')
    await shell.fill(rejectedDraft)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('alert')).toHaveCount(0)

    await shell.press('Enter')

    const inlineError = page.getByRole('alert').filter({ hasText: /setting could not be saved/i })
    await expect(inlineError).toBeVisible()
    await expect(shell).toHaveAttribute('aria-invalid', 'true')
    await expect(shell).toHaveAttribute('aria-describedby', await inlineError.getAttribute('id') ?? '')
    await expect(page.locator('.toast')).toContainText(/shell is not executable/i)
    await expect(shell).toHaveValue(rejectedDraft)
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect.poll(() => page.evaluate(() => window.prime.settings.get().then((settings) => settings.terminalShell))).toBe('/bin/zsh')

    await page.getByRole('button', { name: 'General', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).first().click()
    await expect(page.locator('.settings-content input.mono')).toHaveValue('/bin/zsh')
  })

  test('uses overlay panels at the compact desktop breakpoint', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 960, height: 700 })
    await expect.poll(() => page.locator('.sidebar').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.inspector')).toHaveCount(0)
    const sidebarScrim = page.getByRole('button', { name: 'Close sidebar' })
    await expect(page.locator('.panel-scrim--sidebar')).toBeVisible()
    await expect(sidebarScrim).toBeVisible()
    await sidebarScrim.click({ position: { x: 400, y: 300 } })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)
    // Panel reconciliation may restore a confirmed inspector preference after
    // the sidebar closes. Normalize either valid state before testing the toggle.
    await page.waitForTimeout(250)
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.focus()
    await inspectorToggle.press('Enter')
    await expect.poll(() => page.locator('.inspector').evaluate((node) => getComputedStyle(node).position)).toBe('fixed')
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.locator('.panel-scrim--inspector')).toBeVisible()
    await page.setViewportSize({ width: 1440, height: 920 })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThan(980)
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
  })

  test('grows the transcript column on a wide pane and keeps the docked surfaces aligned', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.setViewportSize({ width: 1800, height: 900 })
    if (await page.locator('.inspector').count()) {
      await page.locator('.inspector').getByRole('button', { name: 'Close inspector' }).click()
      await expect(page.locator('.inspector')).toHaveCount(0)
    }
    const measure = () => page.evaluate(() => {
      const width = (selector: string) => document.querySelector(selector)?.getBoundingClientRect().width ?? 0
      return { pane: width('.conversation-pane'), column: width('.transcript__inner'), dock: width('.conversation-bottom-dock') }
    })

    await expect.poll(async () => (await measure()).pane).toBeGreaterThan(1459)
    const wide = await measure()
    expect(wide.column).toBeGreaterThan(760)
    expect(wide.column).toBeLessThanOrEqual(1240)
    // The scrolled column and the absolutely positioned dock share one measure,
    // so they must stay the same width even when a scrollbar takes up space.
    expect(wide.column).toBeCloseTo(wide.dock, 1)

    await page.setViewportSize({ width: 720, height: 700 })
    await expect.poll(async () => (await measure()).pane).toBeLessThan(760)
    const compact = await measure()
    expect(compact.column).toBeCloseTo(compact.pane, 1)
  })

  test('auto-closes both drawers at the smallest breakpoint while keeping them user-toggleable', async () => {
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Show sidebar/ })).toBeVisible()
    await expect(page.locator('.workbench')).not.toHaveAttribute('inert')
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.locator('.sidebar').getByRole('button', { name: /Hide sidebar/ }).click()
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await page.getByRole('button', { name: /Show sidebar/ }).click()
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.sidebar')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).sidebarOpen)).toBe(false)

    const inspectorToggle = page.getByRole('button', { name: 'Toggle inspector' })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await expect(page.locator('.title-toolbar')).not.toHaveAttribute('inert')
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).inspectorOpen)).toBe(false)

    await page.setViewportSize({ width: 721, height: 700 })
    await inspectorToggle.click()
    await expect(page.locator('.inspector')).toBeVisible()
    await page.setViewportSize({ width: 720, height: 700 })
    await expect(page.locator('.inspector')).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).inspectorOpen)).toBe(false)
  })

  test('attaches an isolated browser guest without navigation errors', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Browser' }).click()
    const guest = page.locator('webview[partition="persist:prime-work-browser"]')
    await expect(guest).toHaveCount(1)
    await expect.poll(() => guest.evaluate(async (node) => {
      const webview = node as HTMLElement & { executeJavaScript(script: string): Promise<unknown> }
      return webview.executeJavaScript('typeof window.prime')
    })).toBe('undefined')
    await page.waitForTimeout(2_500)
    expect(actionableErrors.filter((error) => /ERR_ABORTED|GUEST_VIEW_MANAGER_CALL/i.test(error))).toEqual([])
    await page.getByRole('tab', { name: 'Browser' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
  })

  test('binds Git to a secondary workspace and clears stale paths during a folder switch', async () => {
    await page.getByRole('tab', { name: 'Changes' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await expect(page.getByRole('button', { name: /Stage$/ }).last()).toBeVisible()

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.file-changes')).not.toContainText('secondary-change.txt')
    await expect(page.locator('.file-changes')).toContainText('README.md')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Stage$/ }).last().click()
    await page.getByRole('button', { name: 'Staged', exact: true }).click()
    await expect(page.locator('.file-changes')).toContainText('secondary-change.txt')
    await page.getByRole('button', { name: /Unstage$/ }).last().click()
  })
  test('dismisses the file changes popup, disables it in settings, and undoes a file', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const changesCard = page.locator('.changes-card')
    await expect(changesCard).toBeVisible()
    await changesCard.getByRole('button', { name: 'Dismiss file changes' }).click()
    await expect(changesCard).toHaveCount(0)

    await page.keyboard.press('Meta+,')
    const popupToggle = page.getByRole('checkbox', { name: 'Show file changes popup' })
    await expect(popupToggle).toBeChecked()
    await popupToggle.focus()
    await popupToggle.press('Space')
    await expect(popupToggle).not.toBeChecked()
    await expect.poll(() => page.evaluate(async () => (await window.prime.settings.get()).showFileChangesPopup)).toBe(false)
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    await expect(page.locator('.changes-card')).toHaveCount(0)

    await page.getByRole('tab', { name: 'Changes' }).click()
    await page.locator('.file-changes > button').first().click()
    await page.getByRole('button', { name: 'Undo changes', exact: true }).click()
    const undoDialog = page.getByRole('dialog', { name: 'Undo file changes?' })
    await expect(undoDialog).toContainText('staged and unstaged changes')
    await undoDialog.getByRole('button', { name: 'Undo changes', exact: true }).click()
    await expect.poll(() => readFileSync(join(fixtureRoot, 'secondary-project', 'secondary-change.txt'), 'utf8')).toBe('base\n')
    await expect(page.locator('.file-changes')).toContainText('No unstaged changes.')
  })

  test('resizes the inspector horizontally and terminal vertically', async () => {
    await page.getByRole('button', { name: /^New session/ }).first().click()
    await page.getByRole('tab', { name: 'Summary' }).click()

    const inspector = page.locator('.inspector')
    const inspectorHandle = page.getByRole('separator', { name: 'Resize inspector' })
    await expect(inspectorHandle).toBeVisible()
    const inspectorBefore = await inspector.boundingBox()
    const inspectorHandleBox = await inspectorHandle.boundingBox()
    expect(inspectorBefore).not.toBeNull()
    expect(inspectorHandleBox).not.toBeNull()
    await page.mouse.move(inspectorHandleBox!.x + inspectorHandleBox!.width / 2, inspectorHandleBox!.y + 80)
    await page.mouse.down()
    await page.mouse.move(inspectorHandleBox!.x - 72, inspectorHandleBox!.y + 80, { steps: 5 })
    await page.mouse.up()
    const inspectorAfter = await inspector.boundingBox()
    expect(inspectorAfter!.width).toBeGreaterThan(inspectorBefore!.width + 50)
    await inspectorHandle.focus()
    await page.keyboard.press('ArrowRight')
    expect((await inspector.boundingBox())!.width).toBeLessThan(inspectorAfter!.width)

    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer')
    const terminalHandle = page.getByRole('separator', { name: 'Resize terminal' })
    await expect(terminalHandle).toBeVisible()
    const terminalBefore = await drawer.boundingBox()
    expect(terminalBefore).not.toBeNull()
    await expect.poll(async () => Number(await terminalHandle.getAttribute('aria-valuemax'))).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.hover()
    const terminalHandleBox = await terminalHandle.boundingBox()
    expect(terminalHandleBox).not.toBeNull()
    const terminalHandleCenter = {
      x: terminalHandleBox!.x + terminalHandleBox!.width / 2,
      y: terminalHandleBox!.y + terminalHandleBox!.height / 2,
    }
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y)
    await page.mouse.down()
    await expect(terminalHandle).toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(terminalHandleCenter.x, terminalHandleCenter.y - 64, { steps: 5 })
    await page.mouse.up()
    const terminalAfter = await drawer.boundingBox()
    expect(terminalAfter!.height).toBeGreaterThan(terminalBefore!.height + 44)
    await terminalHandle.focus()
    await page.keyboard.press('ArrowDown')
    expect((await drawer.boundingBox())!.height).toBeLessThan(terminalAfter!.height)
    await page.getByLabel('Close terminal', { exact: true }).click()
  })

  test('shuts down cleanly with an active terminal', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const input = drawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('while true; do sleep 1; done')
    await page.keyboard.press('Enter')
    // Intentionally leave the PTY open. The shared teardown closes the
    // Electron app and exercises the native node-pty shutdown path.
  })

  test('restores each session terminal without leaking it into another session', async () => {
    await page.getByLabel(/Toggle terminal/).click()
    const visibleDrawer = page.locator('.terminal-drawer:not([hidden])')
    const input = visibleDrawer.locator('.xterm-helper-textarea')
    await expect(input).toBeVisible()
    await input.click()
    await page.keyboard.type('echo secondary-session-state')
    await page.keyboard.press('Enter')
    await expect(visibleDrawer.locator('.xterm-rows')).toContainText('secondary-session-state', { timeout: 8_000 })

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    const primaryDrawer = page.locator('.terminal-drawer:not([hidden])')
    const primaryInput = primaryDrawer.locator('.xterm-helper-textarea')
    await expect(primaryInput).toBeVisible()
    await primaryInput.click()
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect(primaryDrawer.locator('.xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/, { timeout: 8_000 })
    await expect(primaryDrawer.locator('.xterm-rows')).not.toContainText('secondary-session-state')

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText('secondary-session-state')
    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden]) .xterm-rows')).toContainText(/prime-work-e2e-[^/]+\/project/)
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await page.locator('.terminal-drawer:not([hidden])').getByLabel('Close terminal', { exact: true }).click()
  })

  test('opens independent terminal tabs inside the conversation column', async () => {
    const project = await page.evaluate(async () => {
      const projects = await window.prime.projects.list()
      const selected = projects[0]
      if (!selected) return null
      return selected.inferred ? window.prime.projects.grantInferred(selected.primaryFolder) : selected
    })
    expect(project).not.toBeNull()
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.locator('.terminal-drawer .xterm')).toBeVisible()
    await expect(page.locator('.terminal-live-dot.is-connected')).toBeVisible()
    const firstTerminalLine = () => page.locator('.terminal-surface:not([hidden]) .xterm-rows').evaluate((rows) =>
      [...rows.children].map((row) => row.textContent?.trim() ?? '').find(Boolean) ?? '',
    )
    await expect.poll(firstTerminalLine).toMatch(/\S/)
    expect(await firstTerminalLine()).not.toBe('%')
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    const activeTerminal = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await activeTerminal.click()
    await page.keyboard.type('echo first-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    await page.getByLabel('New terminal').click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await activeTerminal.click()
    await page.keyboard.type('echo second-terminal')
    await page.keyboard.press('Enter')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('second-terminal')

    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText('second-terminal')

    await page.locator('.session-row').filter({ hasText: 'Primary workspace fixture' }).click()
    await expect(page.locator('.terminal-drawer:not([hidden])')).toHaveCount(0)
    await page.getByLabel(/Toggle terminal/).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(1)
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).not.toContainText(/first-terminal|second-terminal/)
    await expect(page.getByLabel(/Split terminal/)).toHaveCount(0)

    await page.locator('.session-row').filter({ hasText: 'Hermetic desktop fixture' }).click()
    await expect(page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')).toHaveCount(2)
    await page.getByRole('tab', { name: /zsh 1/ }).click()
    await expect(page.locator('.terminal-surface:not([hidden]) .xterm-rows')).toContainText('first-terminal')

    const geometry = await page.evaluate(() => {
      const session = document.querySelector('.session-workspace')!.getBoundingClientRect()
      const conversation = document.querySelector('.conversation-column')!.getBoundingClientRect()
      const terminal = document.querySelector('.terminal-drawer')!.getBoundingClientRect()
      const inspector = document.querySelector('.inspector')!.getBoundingClientRect()
      return {
        terminalRight: terminal.right,
        conversationRight: conversation.right,
        sessionTop: session.top,
        sessionBottom: session.bottom,
        inspectorTop: inspector.top,
        inspectorBottom: inspector.bottom,
      }
    })
    expect(Math.abs(geometry.terminalRight - geometry.conversationRight)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorTop - geometry.sessionTop)).toBeLessThanOrEqual(1)
    expect(Math.abs(geometry.inspectorBottom - geometry.sessionBottom)).toBeLessThanOrEqual(1)

    const drawer = page.locator('.terminal-drawer:not([hidden])')
    const before = await drawer.evaluate((node) => node.getBoundingClientRect().height)
    await drawer.getByLabel('Maximize terminal').click()
    await expect(drawer).toHaveClass(/is-maximized/)
    expect(await drawer.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(before)
    await drawer.getByLabel('Restore terminal').click()
    await drawer.getByLabel('Close terminal', { exact: true }).click()
  })

  test('attaches and removes active terminal selection context', async () => {
    await page.getByRole('tab', { name: 'Summary' }).click()
    await page.getByLabel(/Toggle terminal/).click()
    const input = page.locator('.terminal-surface:not([hidden]) .xterm-helper-textarea')
    await input.click()
    await page.keyboard.type("printf 'terminal-selection-marker\\n'")
    await page.keyboard.press('Enter')
    const outputLine = page.locator('.terminal-surface:not([hidden]) .xterm-rows > div').filter({ hasText: 'terminal-selection-marker' }).last()
    await expect(outputLine).toBeVisible()
    await expect(page.locator('.composer-attachment--terminal')).toHaveCount(0)

    const selectOutput = async () => {
      const box = await outputLine.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(Math.min(box!.x + box!.width - 2, box!.x + 190), box!.y + box!.height / 2, { steps: 5 })
      await page.mouse.up()
      await expect(page.getByLabel(/Inspect selected text from/)).toBeVisible()
    }

    await selectOutput()
    const clearBox = await outputLine.boundingBox()
    expect(clearBox).not.toBeNull()
    await page.mouse.click(clearBox!.x + 2, clearBox!.y + clearBox!.height / 2)
    await expect(page.getByLabel(/Inspect selected text from/)).toHaveCount(0)
    await selectOutput()

    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('Explain the terminal output')
    await composer.press('Enter')
    await expect.poll(() => existsSync(join(fixtureRoot, 'prompt-args.json'))).toBe(true)
    const prompt = JSON.parse(readFileSync(join(fixtureRoot, 'prompt-args.json'), 'utf8')) as { message: string }
    expect(prompt.message).toContain('Explain the terminal output\n\n===== BEGIN TERMINAL SELECTION CONTEXT =====')
    expect(prompt.message).toContain('--- Selected text ---')
    expect(prompt.message).toContain('terminal-selection-marker')
    expect(prompt.message).not.toContain('Terminal buffer')
  })

  test('closes immediately when no agent or schedule is active', async () => {
    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    const dialogCalls = await app!.evaluate(({ BrowserWindow, dialog }) => {
      let calls = 0
      const closeDialog = dialog as unknown as { showMessageBox: (...args: unknown[]) => Promise<unknown> }
      closeDialog.showMessageBox = () => {
        calls += 1
        return Promise.resolve({ response: 0 })
      }
      BrowserWindow.getAllWindows()[0]?.close()
      return calls
    })
    expect(dialogCalls).toBe(0)
    await closed
    app = undefined
  })

  test('Command-Q backgrounds the window and menu-bar Open restores it', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')
    await app!.evaluate(({ Menu }) => {
      const scope = globalThis as { __trayOpen?: () => void }
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string; click?: () => void }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open GooeyPi|separator|Settings...|Quit') {
          scope.__trayOpen = items.find((item) => item.label === 'Open GooeyPi')?.click
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    })
    await page.evaluate(() => window.prime.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as { __trayOpen?: unknown }).__trayOpen)).toBe('function')
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)

    await app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('Main window is missing')
      window.focus()
      window.webContents.focus()
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['meta'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['meta'] })
    })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible(), destroyed: window?.isDestroyed() }
    })).toEqual({ count: 1, visible: false, destroyed: false })
    expect(app!.process().exitCode).toBeNull()

    await app!.evaluate(() => {
      const open = (globalThis as { __trayOpen?: () => void }).__trayOpen
      if (!open) throw new Error('Menu-bar Open was not captured')
      open()
    })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    await expect(page.locator('.app-shell')).toBeVisible()
  })

  test('does not recreate the menu-bar item while Quit is shutting down', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')
    const trayBuildsPath = join(fixtureRoot, 'tray-menu-builds.log')
    await app!.evaluate(({ Menu }, markerPath) => {
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open GooeyPi|separator|Settings...|Quit') {
          process.getBuiltinModule('node:fs').appendFileSync(markerPath, 'tray\n')
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    }, trayBuildsPath)
    await page.evaluate(() => window.prime.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => existsSync(trayBuildsPath) ? readFileSync(trayBuildsPath, 'utf8').trim().split('\n').length : 0).toBe(1)

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit() })
    await closed

    expect(readFileSync(trayBuildsPath, 'utf8').trim().split('\n')).toHaveLength(1)
    app = undefined
  })

  test('asks before closing and quits after confirmation while an agent runs', async () => {
    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I close the window')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()
    await stubCloseDialog(app!)

    const runningPrompt = {
      message: 'Close GooeyPi while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
      buttons: ['Cancel', 'Close GooeyPi'],
    }
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    // Quit routes through the same confirmation instead of bypassing it.
    await app!.evaluate(({ app: electronApp }) => { electronApp.quit() })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt, runningPrompt])
    await expect(page.locator('.app-shell')).toBeVisible()

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(({ app: electronApp }) => {
      (globalThis as { __closeResponse?: number }).__closeResponse = 1
      electronApp.quit()
    })
    await closed
    app = undefined
  })

  test('backgrounds active work and routes tray Quit through confirmation and cleanup', async () => {
    test.skip(process.platform !== 'darwin', 'macOS menu-bar lifecycle')

    // Capture the real Quit closure when enabling the setting creates the tray.
    await app!.evaluate(({ Menu }) => {
      const scope = globalThis as { __trayQuit?: () => void }
      const originalBuildFromTemplate = Menu.buildFromTemplate.bind(Menu)
      Menu.buildFromTemplate = ((template) => {
        const items = template as Array<{ label?: string; type?: string; click?: () => void }>
        if (items.map((item) => item.label ?? item.type).join('|') === 'Open GooeyPi|separator|Settings...|Quit') {
          scope.__trayQuit = items.find((item) => item.label === 'Quit')?.click
        }
        return originalBuildFromTemplate(template)
      }) as typeof Menu.buildFromTemplate
    })
    await page.evaluate(() => window.prime.settings.update({ keepRunningInBackground: true }))
    await expect.poll(() => app!.evaluate(() => typeof (globalThis as { __trayQuit?: unknown }).__trayQuit)).toBe('function')

    await page.locator('.session-row-wrap').filter({ hasText: 'Hermetic desktop fixture' }).locator('.session-row').click()
    const composer = page.getByRole('combobox', { name: 'Message Prime' })
    await composer.fill('stay busy while I background the window')
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Stop Prime' })).toBeVisible()
    const runtimePidPath = join(fixtureRoot, 'prime-runtime.pid')
    await expect.poll(() => existsSync(runtimePidPath)).toBe(true)
    const runtimePid = Number(readFileSync(runtimePidPath, 'utf8'))
    expect(runtimePid).toBeGreaterThan(0)
    expect(processIsAlive(runtimePid)).toBe(true)
    await stubCloseDialog(app!)

    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.show() })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true)
    await app!.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() })
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { count: BrowserWindow.getAllWindows().length, visible: window?.isVisible(), destroyed: window?.isDestroyed() }
    })).toEqual({ count: 1, visible: false, destroyed: false })
    expect(await closePrompts(app!)).toEqual([])
    expect(app!.process().exitCode).toBeNull()
    expect(processIsAlive(runtimePid)).toBe(true)

    const runningPrompt = {
      message: 'Close GooeyPi while an agent is running?',
      detail: 'An agent run is still in progress and will be stopped.',
      buttons: ['Cancel', 'Close GooeyPi'],
    }
    await app!.evaluate(() => {
      const quit = (globalThis as { __trayQuit?: () => void }).__trayQuit
      if (!quit) throw new Error('Tray Quit was not captured')
      quit()
    })
    await expect.poll(() => closePrompts(app!)).toEqual([runningPrompt])
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false)
    expect(app!.process().exitCode).toBeNull()
    expect(processIsAlive(runtimePid)).toBe(true)

    const closed = app!.waitForEvent('close', { timeout: 45_000 })
    await app!.evaluate(() => {
      const scope = globalThis as { __closeResponse?: number; __trayQuit?: () => void }
      scope.__closeResponse = 1
      if (!scope.__trayQuit) throw new Error('Tray Quit was not captured')
      scope.__trayQuit()
    })
    await closed
    await expect.poll(() => processIsAlive(runtimePid)).toBe(false)
    app = undefined
  })
})
