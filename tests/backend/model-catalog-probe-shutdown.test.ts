import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { stopChildProcesses } from '../../electron/main/process-utils'
import { PiModelCatalogService } from '../../electron/main/providers-pi'
import { waitUntil } from '../helpers/wait'

it('terminates an active model probe through shared process shutdown tracking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gooeypi-probe-shutdown-'))
  const pidPath = join(root, 'probe.pid')
  const executable = join(root, 'pi.cjs')
  writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('test'); process.exit(0) }
process.stdin.once('data', () => {
  require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))
  setInterval(() => {}, 1000)
})
`)
  chmodSync(executable, 0o755)
  try {
    const catalog = new PiModelCatalogService(executable, { timeoutMs: 10_000 }).catalog()
    const rejected = expect(catalog).rejects.toThrow()
    await waitUntil(() => existsSync(pidPath))
    const pid = Number(readFileSync(pidPath, 'utf8'))
    await stopChildProcesses()
    await rejected
    await waitUntil(() => { try { process.kill(pid, 0); return false } catch { return true } })
  } finally { await stopChildProcesses(); rmSync(root, { recursive: true, force: true }) }
})
