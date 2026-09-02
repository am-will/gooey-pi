import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalService } from '../../electron/main/terminal'

const dirs: string[] = []
const testShell = ['/bin/zsh', '/bin/bash', '/bin/sh'].find((shell) => {
  try { accessSync(shell, constants.X_OK); return true } catch { return false }
}) ?? '/bin/sh'
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const waitFor = async (predicate: () => boolean, timeout = 4_000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 30)) }
  throw new Error('Timed out waiting for terminal child')
}

describe('TerminalService', () => {
  it('holds repository use until the terminal exits', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gooeypi-terminal-use-')); dirs.push(cwd)
    const owner = { id: 39, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const release = vi.fn()
    const begin = vi.fn(async () => ({ release }))
    const service = new TerminalService(async () => cwd, () => testShell, async (path) => path, begin)

    await service.create(owner, { cwd, shell: testShell, command: 'exit 0', cols: 80, rows: 24 })
    expect(begin).toHaveBeenCalledWith(cwd, expect.objectContaining({ kind: 'terminal' }))
    await waitFor(() => release.mock.calls.length === 1)
  })

  it('publishes only the active terminal snapshot for its session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-context-')); dirs.push(cwd)
    const owner = { id: 40, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell, async (path) => path)
    const first = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    const second = await service.create(owner, { cwd, sessionPath: '/sessions/one.jsonl', shell: testShell, cols: 80, rows: 24 })
    await service.bindSession(owner, first.terminalId, '/sessions/one.jsonl')
    service.setActiveContext(owner, first.terminalId, { label: 'zsh 1', content: '$ first', truncated: false })
    expect(service.readActive('/sessions/one.jsonl')).toMatchObject({ label: 'zsh 1', content: '$ first', cwd })
    service.clearActiveContext(owner, first.terminalId)
    expect(service.readActive('/sessions/one.jsonl')).toBeUndefined()
    service.setActiveContext(owner, first.terminalId, { label: 'zsh 1', content: '$ first', truncated: false })
    service.setActiveContext(owner, second.terminalId, { label: 'zsh 2', content: '$ second', truncated: false })
    expect(service.readActive('/sessions/one.jsonl')).toMatchObject({ label: 'zsh 2', content: '$ second', cwd })
    await service.kill(owner, second.terminalId)
    expect(service.readActive('/sessions/one.jsonl')).toBeUndefined()
    await expect(service.bindSession(owner, first.terminalId, '/sessions/two.jsonl')).rejects.toThrow('another task')
    await service.kill(owner, first.terminalId)
  })
  it('runs configured commands without npm prefix overrides while preserving PREFIX', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gooeypi-project-run-')); dirs.push(cwd)
    const events: Array<{ channel: string; payload: { terminalId?: string; data?: string; exitCode?: number } }> = []
    const owner = {
      id: 47,
      isDestroyed: () => false,
      send: vi.fn((channel: string, payload: { terminalId?: string; data?: string; exitCode?: number }) => { events.push({ channel, payload }) }),
    } as unknown as WebContents
    const prefixKeys = ['npm_config_prefix', 'NPM_CONFIG_PREFIX', 'PREFIX'] as const
    const previousPrefixes = Object.fromEntries(prefixKeys.map((key) => [key, process.env[key]]))
    for (const key of prefixKeys) process.env[key] = '/usr/local'
    try {
      const service = new TerminalService(async () => cwd, () => testShell)
      const command = 'if [ -z "${npm_config_prefix}${NPM_CONFIG_PREFIX}" ] && [ "$PREFIX" = /usr/local ]; then printf runner-ok; else printf env-mismatch; exit 2; fi'
      const created = await service.create(owner, { cwd, shell: testShell, command, cols: 80, rows: 24 })

      await waitFor(() => events.some((event) => event.channel === 'terminal:exit' && event.payload.terminalId === created.terminalId))
      const output = events.filter((event) => event.channel === 'terminal:data' && event.payload.terminalId === created.terminalId).map((event) => event.payload.data ?? '').join('')
      expect(output).toContain('runner-ok')
      expect(output).not.toContain('env-mismatch')
      expect(events).toContainEqual({ channel: 'terminal:exit', payload: expect.objectContaining({ terminalId: created.terminalId, exitCode: 0 }) })
    } finally {
      for (const key of prefixKeys) {
        const previous = previousPrefixes[key]
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    }
  })


  it('kills descendant processes when a terminal closes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-')); dirs.push(cwd)
    const pidFile = join(cwd, 'background.pid')
    const owner = { id: 41, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `/bin/sh -c ${JSON.stringify(`echo "$$" > ${JSON.stringify(pidFile)}; while true; do /bin/sleep 1; done`)}\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(childPid, 0); return false } catch { return true } })
    } finally { try { process.kill(childPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 15_000)

  it('kills dev-server descendants only for terminals bound to the archived session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-session-')); dirs.push(cwd)
    const pidFile = join(cwd, 'dev-server.pid')
    const owner = { id: 47, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell, async (path) => path)
    const archived = await service.create(owner, { cwd, sessionPath: '/sessions/archived.jsonl', shell: testShell, cols: 80, rows: 24 })
    const retained = await service.create(owner, { cwd, sessionPath: '/sessions/retained.jsonl', shell: testShell, cols: 80, rows: 24 })
    service.input(owner, archived.terminalId, `/bin/sh -c ${JSON.stringify(`echo "$$" > ${JSON.stringify(pidFile)}; while true; do /bin/sleep 1; done`)}\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const childPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      await service.killForSession('/sessions/./archived.jsonl')
      await waitFor(() => { try { process.kill(childPid, 0); return false } catch { return true } })
      expect(await service.kill(owner, archived.terminalId)).toBe(false)
      expect(await service.kill(owner, retained.terminalId)).toBe(true)
    } finally { try { process.kill(childPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 15_000)

  it('escalates against a PTY leader that ignores HUP and TERM', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-leader-')); dirs.push(cwd)
    const pidFile = join(cwd, 'leader.pid')
    const owner = { id: 42, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    service.input(owner, created.terminalId, `trap '' HUP TERM; echo $$ > ${JSON.stringify(pidFile)}; while true; do sleep 1; done\r`)
    await waitFor(() => { try { return Number(readFileSync(pidFile, 'utf8').trim()) > 0 } catch { return false } })
    const leaderPid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      expect(await service.kill(owner, created.terminalId)).toBe(true)
      await waitFor(() => { try { process.kill(leaderPid, 0); return false } catch { return true } })
    } finally { try { process.kill(leaderPid, 'SIGKILL') } catch { /* test cleanup */ } }
  }, 10_000)


  it('kills only terminals whose cwd is inside a removed project root', async () => {
    const project = mkdtempSync(join(tmpdir(), 'prime-work-pty-project-')); dirs.push(project)
    const outside = mkdtempSync(join(tmpdir(), 'prime-work-pty-outside-')); dirs.push(outside)
    const owner = { id: 43, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async (cwd) => cwd, () => testShell)
    const projectTerminal = await service.create(owner, { cwd: project, shell: testShell, cols: 80, rows: 24 })
    const outsideTerminal = await service.create(owner, { cwd: outside, shell: testShell, cols: 80, rows: 24 })

    await service.killForProjectRoots([project])

    expect(await service.kill(owner, projectTerminal.terminalId)).toBe(false)
    expect(await service.kill(owner, outsideTerminal.terminalId)).toBe(true)
  })


  it('short-circuits termination without signalling anything when the pty already exited', async () => {
    const service = new TerminalService(async (cwd) => cwd, () => testShell)
    const killSpy = vi.spyOn(process, 'kill')
    const owned = {
      terminal: { pid: process.pid, kill: vi.fn() },
      owner: { isDestroyed: () => true },
      ownerId: 45,
      cwd: '/',
      shell: testShell,
      outputWindowStartedAt: Date.now(),
      outputWindowBytes: 0,
      pendingOutput: '',
      pendingOutputBytes: 0,
      terminating: true,
      exited: true,
    }
    try {
      const started = Date.now()
      await (service as unknown as { terminateProcess(id: string, owned: unknown): Promise<void> }).terminateProcess('gone', owned)
      expect(Date.now() - started).toBeLessThan(400)
      expect(owned.terminal.kill).not.toHaveBeenCalled()
      expect(killSpy).not.toHaveBeenCalled()
    } finally { killSpy.mockRestore() }
  })

  it('makes concurrent app shutdown await an owner teardown already in progress', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-shutdown-')); dirs.push(cwd)
    const owner = { id: 44, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })

    const ownerTeardown = service.killOwner(owner.id)
    let shutdownFinished = false
    const shutdown = service.killAll().then(() => { shutdownFinished = true })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(shutdownFinished).toBe(false)
    await Promise.all([ownerTeardown, shutdown])
    expect(await service.kill(owner, created.terminalId)).toBe(false)
  })

  it('short-circuits kill for a terminal that already exited on its own', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-exited-')); dirs.push(cwd)
    const exits: unknown[] = []
    const owner = {
      id: 45,
      isDestroyed: () => false,
      send: vi.fn((channel: string, payload: unknown) => { if (channel === 'terminal:exit') exits.push(payload) }),
    } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })
    service.input(owner, created.terminalId, 'exit\r')
    await waitFor(() => exits.length > 0)

    // The exit handler already removed the terminal, so kill neither finds it
    // nor runs the HUP/TERM/KILL escalation ladder.
    const started = Date.now()
    expect(await service.kill(owner, created.terminalId)).toBe(false)
    expect(Date.now() - started).toBeLessThan(100)
    expect(exits).toHaveLength(1)
    expect(exits[0]).toMatchObject({ terminalId: created.terminalId })

    // Shutdown after a natural exit has nothing left to escalate either.
    await service.killAll()
  }, 15_000)

  it('deduplicates overlapping kill requests for the same terminal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'prime-work-pty-dedupe-')); dirs.push(cwd)
    const owner = { id: 46, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    const service = new TerminalService(async () => cwd, () => testShell)
    const created = await service.create(owner, { cwd, shell: testShell, cols: 80, rows: 24 })

    // terminate() removes the terminal from the registry synchronously, so a
    // second kill issued while the first escalation ladder is still running
    // short-circuits to false instead of signaling the process tree again.
    const first = service.kill(owner, created.terminalId)
    const second = service.kill(owner, created.terminalId)
    await expect(second).resolves.toBe(false)
    await expect(first).resolves.toBe(true)
  }, 15_000)

  // NOTE(Phase 6 item 6): the win32 termination branch has no
  // killProcessTree/taskkill implementation on this base (Phase 5.2 has not
  // merged); processTree() returns [] on win32 and signalTerminalTree() falls
  // back to terminal.kill(). A mocked-taskkill unit test is deferred until
  // that path exists. The current escalation ladder also snapshots the
  // descendant tree once before SIGHUP and reuses it for SIGTERM/SIGKILL
  // (no re-snapshot before SIGKILL exists to test on this base).
})
