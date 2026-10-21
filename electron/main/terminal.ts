import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import * as pty from 'node-pty'
import type { TerminalActiveContext, TerminalDataEvent, TerminalExitEvent } from '../../src/types/api'
import { TERMINAL_CONTEXT_MAX_CHARS } from '../../src/lib/terminal-context'
import type { WorkspaceUseLease, WorkspaceUseOwner } from './repository-use-gate'
import { killProcessTree, safeChildEnvironment } from './process-utils'
import { canonicalSessionPath } from './session-paths'
import { isPathWithin, rejectUnknownKeys, requireInteger, requireRecord, requireString } from './validation'

interface OwnedTerminal {
  terminal: pty.IPty
  owner: WebContents
  ownerId: number
  cwd: string
  shell: string
  sessionPath?: string
  activeContext?: TerminalActiveContext
  outputWindowStartedAt: number
  outputWindowBytes: number
  pendingOutput: string
  pendingOutputBytes: number
  flushTimer?: NodeJS.Timeout
  resumeTimer?: NodeJS.Timeout
  terminating: boolean
  exited: boolean
  workspaceUse: WorkspaceUseLease
}

interface PendingTerminal {
  ownerId: number
  cwd: string
  sessionPath?: string
  cancelled: boolean
}

function systemShells(): Set<string> {
  if (process.platform === 'win32') {
    const shells = new Set<string>()
    if (process.env.ComSpec && isAbsolute(process.env.ComSpec)) shells.add(process.env.ComSpec)
    if (process.env.SystemRoot && isAbsolute(process.env.SystemRoot)) {
      shells.add(join(process.env.SystemRoot, 'System32', 'cmd.exe'))
      shells.add(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    }
    return shells
  }
  const shells = new Set<string>(['/bin/zsh', '/bin/bash', '/bin/sh'])
  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split(/\r?\n/)) {
      const candidate = line.trim()
      if (candidate.startsWith('/')) shells.add(candidate)
    }
  } catch { /* use conservative defaults */ }
  if (process.env.SHELL?.startsWith('/')) shells.add(process.env.SHELL)
  return shells
}

// Keep pauses below node-pty’s 200 ms socket shutdown drain deadline.
const OUTPUT_WINDOW_MS = 100
const MAX_TERMINAL_OUTPUT_WINDOW_BYTES = 16 * 1024 * 1024 / 10
const MAX_TOTAL_TERMINAL_OUTPUT_WINDOW_BYTES = 32 * 1024 * 1024 / 10
const MAX_TERMINAL_IPC_CHUNK_BYTES = 1024 * 1024
const MAX_TERMINAL_INPUT_CHARS = 1024 * 1024

const execFileAsync = promisify(execFile)

async function processTree(rootPid: number): Promise<number[]> {
  if (process.platform === 'win32') return []
  let output = ''
  try {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4 * 1024 * 1024 })
    output = result.stdout
  } catch { return [] }
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const [pidValue, parentValue] = line.trim().split(/\s+/).map(Number)
    if (!Number.isSafeInteger(pidValue) || !Number.isSafeInteger(parentValue)) continue
    const entries = children.get(parentValue) ?? []; entries.push(pidValue); children.set(parentValue, entries)
  }
  const descendants: number[] = []
  const visit = (pid: number) => { for (const child of children.get(pid) ?? []) { visit(child); descendants.push(child) } }
  visit(rootPid)
  return descendants
}

function shellArguments(shell: string, command?: string): string[] {
  if (process.platform !== 'win32') return command === undefined ? ['-l'] : ['-lc', command]
  const name = basename(shell).toLowerCase()
  if (name === 'cmd.exe') return command === undefined ? ['/K'] : ['/D', '/S', '/C', command]
  if (name === 'powershell.exe' || name === 'pwsh.exe') {
    if (command === undefined) return ['-NoLogo']
    const trackedCommand = `${command}\n$gooeyPiSuccess = $?\n$gooeyPiExitCode = $LASTEXITCODE\nif (-not $gooeyPiSuccess) {\n  if ($null -ne $gooeyPiExitCode -and $gooeyPiExitCode -ne 0) { exit $gooeyPiExitCode }\n  exit 1\n}\nexit 0`
    return ['-NoLogo', '-Command', trackedCommand]
  }
  return command === undefined ? [] : [command]
}
function terminalEnvironment(commandRunner: boolean): Record<string, string> {
  const env = Object.fromEntries(Object.entries(safeChildEnvironment({
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  })).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  if (process.env.NO_COLOR === undefined) delete env.NO_COLOR
  else env.NO_COLOR = process.env.NO_COLOR
  // npm injects its configured prefix into apps launched through `npm run`.
  // Login-shell nvm refuses to initialize while that npm override is present.
  if (commandRunner) {
    delete env.npm_config_prefix
    delete env.NPM_CONFIG_PREFIX
  }
  return env
}


export class TerminalService {
  private readonly pendingCreates = new Set<PendingTerminal>()
  private closed = false
  private readonly terminals = new Map<string, OwnedTerminal>()
  private readonly activeBySession = new Map<string, string>()
  private readonly terminationPromises = new Map<OwnedTerminal, Promise<void>>()
  private readonly allowedShells = systemShells()
  private totalOutputWindowStartedAt = Date.now()
  private totalOutputWindowBytes = 0

  constructor(
    private readonly authorizeCwd: (cwd: string) => Promise<string>,
    private readonly configuredShell: () => string,
    private readonly authorizeSessionPath: (path: string) => Promise<string> = async (path) => canonicalSessionPath(path),
    private readonly beginWorkspaceUse: (cwd: string, owner: WorkspaceUseOwner) => Promise<WorkspaceUseLease> = async () => ({ release: () => undefined }),
  ) {}

  validateShell(value: unknown): string {
    const requested = requireString(value, 'shell', { min: 1, max: 4096 })
    if (!isAbsolute(requested)) throw new TypeError('shell must be an absolute path')
    let canonical: string
    try {
      canonical = realpathSync(requested)
      accessSync(canonical, constants.X_OK)
      if (!statSync(canonical).isFile()) throw new Error('not a file')
    } catch { throw new TypeError('shell is not executable') }
    const allowedCanonical = new Set<string>()
    for (const shell of this.allowedShells) {
      if (!shell || !isAbsolute(shell) || !existsSync(shell)) continue
      try { allowedCanonical.add(realpathSync(shell)) } catch { /* ignore */ }
    }
    if (!allowedCanonical.has(canonical)) throw new TypeError(process.platform === 'win32' ? 'shell is not an approved Windows shell' : 'shell is not listed in /etc/shells')
    return canonical
  }

  async create(owner: WebContents, raw: unknown): Promise<{ terminalId: string; shell: string }> {
    const options = requireRecord(raw, 'terminal options')
    rejectUnknownKeys(options, ['cwd', 'sessionPath', 'shell', 'command', 'cols', 'rows'], 'terminal options')
    if (this.closed) throw new Error('Terminal service is shutting down')
    if (this.terminals.size + this.pendingCreates.size >= 8) throw new Error('GooeyPi supports at most eight concurrent terminals')
    const requestedCwd = requireString(options.cwd, 'cwd', { min: 1, max: 4096 })
    const requestedSessionPath = options.sessionPath === undefined ? undefined : requireString(options.sessionPath, 'sessionPath', { min: 1, max: 4096 })
    const pending: PendingTerminal = { ownerId: owner.id, cwd: canonicalSessionPath(requestedCwd), sessionPath: requestedSessionPath === undefined ? undefined : canonicalSessionPath(requestedSessionPath), cancelled: false }
    this.pendingCreates.add(pending)
    try {
      const cwd = await this.authorizeCwd(requestedCwd)
      pending.cwd = cwd
      this.assertPendingCreate(owner, pending)
      const sessionPath = requestedSessionPath === undefined
        ? undefined
        : canonicalSessionPath(await this.authorizeSessionPath(requestedSessionPath))
      pending.sessionPath = sessionPath
      this.assertPendingCreate(owner, pending)
      if (this.terminals.size >= 8) throw new Error('GooeyPi supports at most eight concurrent terminals')
      const shell = this.validateShell(options.shell ?? this.configuredShell())
      const command = options.command === undefined
        ? undefined
        : requireString(options.command, 'terminal command', { min: 1, max: 64 * 1024 })
      const cols = options.cols === undefined ? 100 : requireInteger(options.cols, 'cols', 2, 1_000)
      const rows = options.rows === undefined ? 30 : requireInteger(options.rows, 'rows', 1, 1_000)
      const env = terminalEnvironment(command !== undefined)
      const terminalId = randomUUID()
      const workspaceUse = await this.beginWorkspaceUse(cwd, { kind: 'terminal', terminalId })
      let terminal: pty.IPty
      try {
        this.assertPendingCreate(owner, pending)
        if (this.terminals.size >= 8) throw new Error('GooeyPi supports at most eight concurrent terminals')
        terminal = pty.spawn(shell, shellArguments(shell, command), { cwd, cols, rows, name: 'xterm-256color', env })
      } catch (error) {
        workspaceUse.release()
        throw error
      }
      const owned: OwnedTerminal = { terminal, owner, ownerId: owner.id, cwd, shell, sessionPath, outputWindowStartedAt: Date.now(), outputWindowBytes: 0, pendingOutput: '', pendingOutputBytes: 0, terminating: false, exited: false, workspaceUse }
      this.terminals.set(terminalId, owned)
      terminal.onData((data) => this.forwardOutput(terminalId, owned, data))
      terminal.onExit(({ exitCode, signal }) => {
        owned.exited = true
        owned.workspaceUse.release()
        this.terminals.delete(terminalId)
        this.removeActive(terminalId, owned)
        if (owned.flushTimer) clearTimeout(owned.flushTimer)
        if (owned.resumeTimer) { clearTimeout(owned.resumeTimer); owned.resumeTimer = undefined }
        this.flushOutput(terminalId, owned)
        if (!owner.isDestroyed()) { try { owner.send('terminal:exit', { terminalId, exitCode, signal } satisfies TerminalExitEvent) } catch { /* renderer exited */ } }
      })
      try { this.assertPendingCreate(owner, pending) } catch (error) { await this.terminate(terminalId, owned); throw error }
      return { terminalId, shell }
    } finally { this.pendingCreates.delete(pending) }
  }

  input(owner: WebContents, idValue: unknown, dataValue: unknown): void {
    const terminal = this.owned(owner, idValue)
    if (typeof dataValue !== 'string' || dataValue.length > MAX_TERMINAL_INPUT_CHARS) throw new TypeError('terminal data must be a string at most 1 MiB characters')
    terminal.terminal.write(dataValue)
  }

  async bindSession(owner: WebContents, idValue: unknown, sessionPathValue: unknown): Promise<boolean> {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    this.owned(owner, id)
    const sessionPath = canonicalSessionPath(await this.authorizeSessionPath(requireString(sessionPathValue, 'sessionPath', { min: 1, max: 4096 })))
    const terminal = this.owned(owner, id)
    if (terminal.sessionPath && terminal.sessionPath !== sessionPath) throw new Error('Terminal already belongs to another task')
    terminal.sessionPath = sessionPath
    return true
  }

  resize(owner: WebContents, idValue: unknown, colsValue: unknown, rowsValue: unknown): void {
    const terminal = this.owned(owner, idValue)
    terminal.terminal.resize(requireInteger(colsValue, 'cols', 2, 1_000), requireInteger(rowsValue, 'rows', 1, 1_000))
  }

  setActiveContext(owner: WebContents, idValue: unknown, raw: unknown): void {
    const terminal = this.owned(owner, idValue)
    if (!terminal.sessionPath) return
    const context = requireRecord(raw, 'terminal context')
    rejectUnknownKeys(context, ['label', 'content', 'truncated'], 'terminal context')
    const label = requireString(context.label, 'terminal label', { min: 1, max: 128, trim: true })
    const content = requireString(context.content, 'terminal content', { max: TERMINAL_CONTEXT_MAX_CHARS })
    if (typeof context.truncated !== 'boolean') throw new TypeError('terminal context truncated must be a boolean')
    terminal.activeContext = { label, content, truncated: context.truncated }
    this.activeBySession.set(terminal.sessionPath, requireString(idValue, 'terminalId', { min: 1, max: 128 }))
  }

  clearActiveContext(owner: WebContents, idValue: unknown): void {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    const terminal = this.owned(owner, id)
    terminal.activeContext = undefined
    this.removeActive(id, terminal)
  }

  readActive(sessionPathValue: string): (TerminalActiveContext & { cwd: string }) | undefined {
    const sessionPath = canonicalSessionPath(sessionPathValue)
    const id = this.activeBySession.get(sessionPath)
    const terminal = id ? this.terminals.get(id) : undefined
    if (!terminal || terminal.sessionPath !== sessionPath || !terminal.activeContext || terminal.terminating) return undefined
    return { ...terminal.activeContext, cwd: terminal.cwd }
  }

  async kill(owner: WebContents, idValue: unknown): Promise<boolean> {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    const owned = this.terminals.get(id)
    if (!owned || owned.ownerId !== owner.id) return false
    await this.terminate(id, owned)
    return true
  }

  async killOwner(ownerId: number): Promise<void> {
    this.cancelPendingCreates((pending) => pending.ownerId === ownerId)
    await Promise.all([...this.terminals].filter(([, terminal]) => terminal.ownerId === ownerId).map(([id, terminal]) => this.terminate(id, terminal)))
  }

  async killAll(): Promise<void> {
    this.closed = true
    this.cancelPendingCreates(() => true)
    const starting = [...this.terminals].map(([id, terminal]) => this.terminate(id, terminal))
    await Promise.all([...new Set([...this.terminationPromises.values(), ...starting])])
  }

  /** Terminates every PTY and descendant process tree bound to one session. */
  async killForSession(sessionPathValue: unknown): Promise<void> {
    const sessionPath = canonicalSessionPath(requireString(sessionPathValue, 'sessionPath', { min: 1, max: 4096 }))
    this.cancelPendingCreates((pending) => pending.sessionPath === sessionPath)
    const matches = [...this.terminals].filter(([, terminal]) => terminal.sessionPath === sessionPath)
    await Promise.all(matches.map(([id, terminal]) => this.terminate(id, terminal)))
  }

  async killForProjectRoots(roots: string[]): Promise<void> {
    this.cancelPendingCreates((pending) => roots.some((root) => isPathWithin(root, pending.cwd)))
    const matches = [...this.terminals].filter(([, terminal]) => roots.some((root) => isPathWithin(root, terminal.cwd)))
    await Promise.all(matches.map(([id, terminal]) => this.terminate(id, terminal)))
  }

  private cancelPendingCreates(matches: (pending: PendingTerminal) => boolean): void {
    for (const pending of this.pendingCreates) {
      if (!matches(pending)) continue
      pending.cancelled = true
      this.pendingCreates.delete(pending)
    }
  }

  private forwardOutput(id: string, owned: OwnedTerminal, data: string): void {
    if (owned.terminating || owned.owner.isDestroyed()) return
    const now = Date.now()
    if (now - owned.outputWindowStartedAt >= OUTPUT_WINDOW_MS) { owned.outputWindowStartedAt = now; owned.outputWindowBytes = 0 }
    const bytes = Buffer.byteLength(data)
    owned.outputWindowBytes += bytes
    if (now - this.totalOutputWindowStartedAt >= OUTPUT_WINDOW_MS) { this.totalOutputWindowStartedAt = now; this.totalOutputWindowBytes = 0 }
    this.totalOutputWindowBytes += bytes
    if (bytes > MAX_TERMINAL_IPC_CHUNK_BYTES) {
      owned.pendingOutput += '\r\n[GooeyPi stopped this terminal because one output frame exceeded 1 MiB.]\r\n'
      owned.pendingOutputBytes = Buffer.byteLength(owned.pendingOutput)
      this.flushOutput(id, owned)
      void this.terminate(id, owned)
      return
    }
    if (owned.pendingOutputBytes + bytes > MAX_TERMINAL_IPC_CHUNK_BYTES) this.flushOutput(id, owned)
    owned.pendingOutput += data; owned.pendingOutputBytes += bytes
    if (!owned.flushTimer) owned.flushTimer = setTimeout(() => { owned.flushTimer = undefined; this.flushOutput(id, owned) }, 16)
    const terminalLimited = owned.outputWindowBytes >= MAX_TERMINAL_OUTPUT_WINDOW_BYTES
    const totalLimited = this.totalOutputWindowBytes >= MAX_TOTAL_TERMINAL_OUTPUT_WINDOW_BYTES
    if (!owned.resumeTimer && (terminalLimited || totalLimited)) {
      try { owned.terminal.pause() } catch { return }
      const resumeAt = Math.max(
        terminalLimited ? owned.outputWindowStartedAt + OUTPUT_WINDOW_MS : now,
        totalLimited ? this.totalOutputWindowStartedAt + OUTPUT_WINDOW_MS : now,
      )
      owned.resumeTimer = setTimeout(() => {
        owned.resumeTimer = undefined
        if (!owned.exited && !owned.terminating) { try { owned.terminal.resume() } catch { /* PTY exited */ } }
      }, Math.max(1, Math.min(OUTPUT_WINDOW_MS, resumeAt - now)))
      owned.resumeTimer.unref()
    }
  }

  private flushOutput(id: string, owned: OwnedTerminal): void {
    if (!owned.pendingOutput || owned.owner.isDestroyed()) { owned.pendingOutput = ''; owned.pendingOutputBytes = 0; return }
    const data = owned.pendingOutput; owned.pendingOutput = ''; owned.pendingOutputBytes = 0
    try { owned.owner.send('terminal:data', { terminalId: id, data } satisfies TerminalDataEvent) } catch { /* renderer exited */ }
  }

  private terminate(id: string, owned: OwnedTerminal): Promise<void> {
    const active = this.terminationPromises.get(owned)
    if (active) return active
    owned.terminating = true
    this.terminals.delete(id)
    this.removeActive(id, owned)
    const operation = this.terminateProcess(id, owned)
    this.terminationPromises.set(owned, operation)
    const cleanup = () => { if (this.terminationPromises.get(owned) === operation) this.terminationPromises.delete(owned) }
    void operation.then(cleanup, cleanup)
    return operation
  }

  private async terminateProcess(id: string, owned: OwnedTerminal): Promise<void> {
    if (owned.flushTimer) { clearTimeout(owned.flushTimer); owned.flushTimer = undefined }
    if (owned.resumeTimer) {
      clearTimeout(owned.resumeTimer); owned.resumeTimer = undefined
      try { owned.terminal.resume() } catch { /* PTY exited */ }
    }
    this.flushOutput(id, owned)
    if (owned.exited) return
    // Shell children can detach from the process group, so signal a snapshot of
    // the descendant tree alongside the group at every rung.
    const descendants = await processTree(owned.terminal.pid)
    const graceful = await killProcessTree(owned.terminal.pid, {
      ladder: [
        { signal: 'SIGHUP', waitMs: 150 },
        { signal: 'SIGTERM', waitMs: 350 },
      ],
      hasExited: () => owned.exited,
      descendants,
      signalDirect: (signal) => owned.terminal.kill(process.platform === 'win32' ? undefined : signal),
    })
    if (process.platform === 'win32') return
    // Re-snapshot before the SIGKILL rung: only descendants still parented
    // under this pty may be force-killed, which narrows the window in which a
    // recycled PID could be hit with the stale snapshot.
    const survivors = new Set(await processTree(owned.terminal.pid))
    const remaining = descendants.filter((pid) => survivors.has(pid))
    if (graceful || owned.exited) {
      for (const pid of remaining) { try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ } }
      return
    }
    await killProcessTree(owned.terminal.pid, {
      ladder: [{ signal: 'SIGKILL', waitMs: 0 }],
      descendants: remaining,
      signalDirect: (signal) => owned.terminal.kill(signal),
    })
  }

  private assertPendingCreate(owner: WebContents, pending: PendingTerminal): void {
    if (owner.isDestroyed() || pending.cancelled || this.closed) throw new Error('Terminal owner was closed or creation was cancelled')
  }

  private owned(owner: WebContents, idValue: unknown): OwnedTerminal {
    const id = requireString(idValue, 'terminalId', { min: 1, max: 128 })
    const terminal = this.terminals.get(id)
    if (!terminal || terminal.ownerId !== owner.id) throw new Error('Terminal was not found')
    return terminal
  }

  private removeActive(id: string, terminal: OwnedTerminal): void {
    if (terminal.sessionPath && this.activeBySession.get(terminal.sessionPath) === id) this.activeBySession.delete(terminal.sessionPath)
  }
}
