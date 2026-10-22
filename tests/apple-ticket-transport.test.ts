import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPLE_TICKET_RULE, cleanupAppleTicketTransport, setupAppleTicketTransport } from '../scripts/release/apple-ticket-transport.mjs'

const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' }
const anchor = 'com.apple/000.gooeypi-notary-12345-2'
const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-ticket-transport-'))
  directories.push(directory)
  const stateFile = join(directory, 'state.json')
  const run = vi.fn((args: string[], _input?: string) => ({ status: 0, stdout: args[0] === '-sr' ? 'anchor "com.apple/*" all\n' : '', stderr: args[0] === '-E' ? 'pf enabled\nToken : 98765\n' : '' }))
  return { env, stateFile, run }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('job-scoped Apple ticket transport', () => {
  it.each([{ GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'Linux' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_RUN_ID: '../unsafe' }, { GITHUB_RUN_ATTEMPT: '1\n2' }, { GITHUB_RUN_ID: '' }])(
    'rejects unsupported execution before any PF calls: %j',
    (override) => {
      const options = fixture()
      expect(() => setupAppleTicketTransport({ ...options, env: { ...env, ...override } })).toThrow()
      expect(() => cleanupAppleTicketTransport({ ...options, env: { ...env, ...override } })).toThrow()
      expect(options.run).not.toHaveBeenCalled()
    },
  )

  it('preserves root/other anchors and releases only the owned enable reference', () => {
    const options = fixture()
    expect(setupAppleTicketTransport(options)).toEqual({ anchor, token: '98765' })
    expect(options.run.mock.calls).toEqual([[['-sr'], undefined], [['-a', 'com.apple', '-s', 'Anchors'], undefined], [['-a', anchor, '-f', '-'], APPLE_TICKET_RULE], [['-E']]])
    expect(JSON.parse(readFileSync(options.stateFile, 'utf8')).enableOutput).toContain('Token : 98765')
    cleanupAppleTicketTransport(options)
    expect(options.run.mock.calls.slice(-2)).toEqual([
      [['-a', anchor, '-F', 'rules'], undefined],
      [['-X', '98765'], undefined],
    ])
    expect(existsSync(options.stateFile)).toBe(false)
    const count = options.run.mock.calls.length
    cleanupAppleTicketTransport(options)
    expect(options.run).toHaveBeenCalledTimes(count)
  })

  it('refuses an absent live wildcard without changing rules', () => {
    const options = fixture()
    options.run.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    expect(() => setupAppleTicketTransport(options)).toThrow('Live PF root lacks')
    expect(options.run.mock.calls).toEqual([[['-sr'], undefined]])
    expect(existsSync(options.stateFile)).toBe(false)
  })

  it.each([anchor, anchor.slice('com.apple/'.length)])('refuses an occupied anchor even without rules: %s', (name) => {
    const options = fixture()
    options.run.mockImplementation((args) => ({ status: 0, stdout: args[0] === '-sr' ? 'anchor "com.apple/*" all' : name, stderr: '' }))
    expect(() => setupAppleTicketTransport(options)).toThrow('already occupied')
    expect(options.run).toHaveBeenCalledTimes(2)
  })

  it('refuses existing state before loading or enabling anything', () => {
    const options = fixture()
    writeFileSync(options.stateFile, 'prior state')
    expect(() => setupAppleTicketTransport(options)).toThrow()
    expect(readFileSync(options.stateFile, 'utf8')).toBe('prior state')
    expect(options.run).toHaveBeenCalledTimes(2)
  })

  it('rolls back only its own anchor when loading fails', () => {
    const options = fixture()
    const initial = options.run.getMockImplementation()!
    options.run.mockImplementation((args, input) => (args.includes('-f') ? { status: 1, stdout: '', stderr: 'bad rule' } : initial(args, input)))
    expect(() => setupAppleTicketTransport(options)).toThrow('bad rule')
    expect(options.run.mock.calls.at(-1)?.[0]).toEqual(['-a', anchor, '-F', 'rules'])
    expect(options.run.mock.calls.some(([args]) => args.includes('-E') || args.includes('-X'))).toBe(false)
    expect(existsSync(options.stateFile)).toBe(false)
  })

  it('retains raw enable output and releases a returned token even on unsuccessful enable', () => {
    const options = fixture()
    const initial = options.run.getMockImplementation()!
    options.run.mockImplementation((args, input) => (args[0] === '-E' ? { status: 1, stdout: 'Token : 9988', stderr: 'failed after enabling' } : initial(args, input)))
    expect(() => setupAppleTicketTransport(options)).toThrow('PF enable failed')
    expect(options.run.mock.calls.at(-1)?.[0]).toEqual(['-X', '9988'])
    expect(existsSync(options.stateFile)).toBe(false)
  })

  it.each(['enabled without token', 'Token : 11\nToken : 22'])('fails closed with recoverable raw evidence when ownership is unknowable: %s', (text) => {
    const options = fixture()
    const initial = options.run.getMockImplementation()!
    options.run.mockImplementation((args, input) => (args[0] === '-E' ? { status: 0, stdout: text, stderr: '' } : initial(args, input)))
    expect(() => setupAppleTicketTransport(options)).toThrow('setup and rollback failed')
    expect(options.run.mock.calls.at(-1)?.[0]).toEqual(['-a', anchor, '-F', 'rules'])
    expect(options.run.mock.calls.some(([args]) => args.includes('-X'))).toBe(false)
    expect(JSON.parse(readFileSync(options.stateFile, 'utf8')).enableOutput).toContain(text)
  })

  it('attempts reference release even when scoped rule cleanup fails, without releasing twice on retry', () => {
    const options = fixture()
    setupAppleTicketTransport(options)
    const initial = options.run.getMockImplementation()!
    options.run.mockImplementation((args, input) => (args.includes('-F') ? { status: 1, stdout: '', stderr: 'flush failed' } : initial(args, input)))
    expect(() => cleanupAppleTicketTransport(options)).toThrow('cleanup failed')
    expect(options.run.mock.calls.at(-1)?.[0]).toEqual(['-X', '98765'])
    options.run.mockImplementation(initial)
    cleanupAppleTicketTransport(options)
    expect(options.run.mock.calls.filter(([args]) => args.includes('-X'))).toHaveLength(1)
    expect(existsSync(options.stateFile)).toBe(false)
  })

  it('keeps failed token release retryable and rejects another run state without calls', () => {
    const options = fixture()
    setupAppleTicketTransport(options)
    const initial = options.run.getMockImplementation()!
    options.run.mockImplementation((args, input) => (args.includes('-X') ? { status: 1, stdout: '', stderr: 'release failed' } : initial(args, input)))
    expect(() => cleanupAppleTicketTransport(options)).toThrow('cleanup failed')
    expect(existsSync(options.stateFile)).toBe(true)
    options.run.mockClear()
    expect(() => cleanupAppleTicketTransport({ ...options, env: { ...env, GITHUB_RUN_ID: '999' } })).toThrow('another job')
    expect(options.run).not.toHaveBeenCalled()
  })
})
