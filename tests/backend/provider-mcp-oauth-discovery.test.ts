import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrimeProviderService } from '../../electron/main/providers'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function service(options: { openExternal?: (url: string) => Promise<void> } = {}): PrimeProviderService {
  const dir = createTempDir('gooeypi-provider-mcp-')
  return new PrimeProviderService({
    authPath: join(dir, 'auth.json'),
    modelsPath: join(dir, 'models.json'),
    ...options,
  })
}

describe('MCP OAuth boundary', () => {
  it('rejects MCP-prefixed ids at the generic boundaries before network or browser launch', async () => {
    const fetchMock = vi.fn()
    const openExternal = vi.fn(async () => undefined)
    vi.stubGlobal('fetch', fetchMock)
    const providerService = service({ openExternal })

    await expect(providerService.startOAuth('mcp:notion')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    await expect(providerService.saveApiKey('mcp:custom-server', 'secret')).rejects.toThrow('Network MCP authentication is managed outside GooeyPi')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('provider login flow bookkeeping', () => {
  it('ignores responses and cancellations for unknown flows', () => {
    const providerService = service()
    expect(providerService.respondOAuth('flow-1', 'prompt-1', 'value')).toBe(false)
    expect(providerService.cancelOAuth('flow-1')).toBe(false)
    expect(() => providerService.respondOAuth('', 'prompt-1', 'value')).toThrow('flowId is too short')
    expect(() => providerService.cancelOAuth(7)).toThrow('flowId must be a string')
    expect(() => providerService.cancelAll()).not.toThrow()
  })
})
