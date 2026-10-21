import { build } from 'esbuild'
import { Worker } from 'node:worker_threads'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureGooeyPiAgentMessageSigning, encodeGooeyPiAgentMessage, loadOrCreateGooeyPiAgentMessageKey, parseGooeyPiAgentMessage } from '../../electron/main/collaboration/message-envelope'

const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gooeypi-message-key-'))
  directories.push(directory)
  return { directory, path: join(directory, 'signing.key') }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('agent-message signing key', () => {
  it.each([0, 31, 33])('quarantines an invalid %i-byte key and publishes a stable replacement', (length) => {
    const { directory, path } = fixture()
    const invalid = Buffer.alloc(length, 7)
    writeFileSync(path, invalid)
    const key = loadOrCreateGooeyPiAgentMessageKey(path)
    expect(key).toHaveLength(32)
    expect(loadOrCreateGooeyPiAgentMessageKey(path)).toEqual(key)
    const quarantines = readdirSync(directory).filter((name) => name.includes('.invalid-'))
    expect(quarantines).toHaveLength(1)
    expect(readFileSync(join(directory, quarantines[0]))).toEqual(invalid)
    expect(readdirSync(directory).some((name) => name.includes('.tmp-'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('quarantines the link without changing its target and tightens existing key permissions', () => {
    const { directory, path } = fixture()
    const target = join(directory, 'target')
    const original = Buffer.alloc(32, 9)
    writeFileSync(target, original, { mode: 0o644 })
    symlinkSync(target, path)
    expect(loadOrCreateGooeyPiAgentMessageKey(path)).toHaveLength(32)
    expect(readFileSync(target)).toEqual(original)
    expect(lstatSync(path).isSymbolicLink()).toBe(false)
    expect(loadOrCreateGooeyPiAgentMessageKey(target)).toEqual(original)
    if (process.platform !== 'win32') expect(lstatSync(target).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves unreadable keys instead of treating access failure as corruption', () => {
    const { directory, path } = fixture()
    const original = Buffer.alloc(32, 3)
    writeFileSync(path, original, { mode: 0o000 })
    try {
      expect(() => loadOrCreateGooeyPiAgentMessageKey(path)).toThrow()
      expect(readdirSync(directory)).toEqual(['signing.key'])
    } finally { chmodSync(path, 0o600) }
    expect(readFileSync(path)).toEqual(original)
  })

  it('publishes exactly one complete key across concurrent real creators', async () => {
    const { directory, path } = fixture()
    const modulePath = join(directory, 'envelope.cjs')
    await build({ entryPoints: ['electron/main/collaboration/message-envelope.ts'], outfile: modulePath, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
    const workers = Array.from({ length: 8 }, () => new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { loadOrCreateGooeyPiAgentMessageKey } = require(workerData.modulePath);
      parentPort.postMessage(loadOrCreateGooeyPiAgentMessageKey(workerData.path).toString('hex'));
    `, { eval: true, workerData: { path, modulePath } }))
    try {
      const keys = await Promise.all(workers.map((worker) => new Promise<string>((resolve, reject) => {
        worker.once('message', resolve); worker.once('error', reject)
      })))
      expect(new Set(keys).size).toBe(1)
      expect(readFileSync(path).toString('hex')).toBe(keys[0])
      expect(readdirSync(directory).filter((name) => name.includes('.invalid-') || name.includes('.tmp-'))).toEqual([])
    } finally { await Promise.all(workers.map((worker) => worker.terminate())) }
  })

  it('requires a 32-byte key and authenticates metadata and message bytes', () => {
    expect(() => configureGooeyPiAgentMessageSigning(Buffer.alloc(31))).toThrow('32 bytes')
    configureGooeyPiAgentMessageSigning(Buffer.alloc(32, 5))
    const encoded = encodeGooeyPiAgentMessage({ fromSessionId: 'child', text: 'Result' })
    expect(parseGooeyPiAgentMessage(encoded)).toEqual({ fromSessionId: 'child', text: 'Result' })
    for (const modified of [encoded.replace('child', 'other'), encoded.replace('Result', 'Tampered'), encoded.replace('gooeypi_session_send', 'session_send'), `prefix${encoded}`]) {
      expect(parseGooeyPiAgentMessage(modified)).toBeUndefined()
    }
  })
})
