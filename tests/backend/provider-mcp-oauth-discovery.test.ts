import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PrimeProviderService, resolveMcpOAuthDiscovery } from '../../electron/main/providers'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

const challenge = (metadataUrl: string) => new Response('', {
  status: 401,
  headers: { 'www-authenticate': `Bearer error="invalid_request", resource_metadata="${metadataUrl}"` },
})

function serviceWithSettings(settings?: string): PrimeProviderService {
  const dir = mkdtempSync(join(tmpdir(), 'gooeypi-provider-mcp-'))
  dirs.push(dir)
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), settings)
  return new PrimeProviderService({ agentDir: dir, authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json') })
}

describe('resolveMcpOAuthDiscovery', () => {
  it('rejects a remote plaintext server before making a discovery request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpOAuthDiscovery('http://mcp.example.test/mcp')).rejects.toThrow(/HTTPS/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the server URL when the challenge fails or advertises no metadata', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer realm="mcp"' } }))
    vi.stubGlobal('fetch', fetchMock)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).resolves.toEqual({ url: 'https://mcp.test/mcp' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('omits scopes when the metadata advertises none it can use', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://mcp.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_servers: ['https://auth.test'],
        scopes_supported: ['projects:read', 7, '', 'x'.repeat(257)],
      }))))

    await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).resolves.toEqual({ url: 'https://auth.test/', scopes: 'projects:read' })

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://mcp.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorization_servers: ['https://auth.test'], scopes_supported: 'projects:read' }))))

    await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).resolves.toEqual({ url: 'https://auth.test/', scopes: undefined })
  })

  it('rejects a metadata document that failed, is not JSON, or names no authorization server', async () => {
    const cases: Array<{ response: Response; message: string }> = [
      { response: new Response('nope', { status: 503 }), message: 'metadata request failed: 503' },
      { response: new Response('not json'), message: 'metadata is not valid JSON' },
      { response: new Response(JSON.stringify(['https://auth.test'])), message: 'has no authorization server' },
      { response: new Response(JSON.stringify({ authorization_servers: [] })), message: 'has no authorization server' },
      { response: new Response(JSON.stringify({ authorization_servers: [7] })), message: 'has no authorization server' },
    ]
    for (const { response, message } of cases) {
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(challenge('https://mcp.test/.well-known/oauth-protected-resource'))
        .mockResolvedValueOnce(response))
      await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).rejects.toThrow(message)
    }
  })

  it('rejects an oversized metadata document by its declared and its streamed size', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://mcp.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(64 * 1024 + 1) } })))
    await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).rejects.toThrow('OAuth metadata response is too large')

    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16 * 1024)) },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://mcp.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(stream)))
    await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).rejects.toThrow('OAuth metadata response is too large')
    expect(cancelled).toBe(true)
  })

  it('rejects a metadata URL that is not a web URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(challenge('file:///etc/passwd')))
    await expect(resolveMcpOAuthDiscovery('https://mcp.test/mcp')).rejects.toThrow('URL scheme is not allowed')
  })

  it('fails closed on cross-origin protected-resource metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(challenge('https://metadata.example.test/.well-known/oauth-protected-resource'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpOAuthDiscovery('https://mcp.example.test/mcp')).rejects.toThrow(/same origin/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects plaintext protected-resource metadata and authorization servers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(challenge('http://mcp.example.test/.well-known/oauth-protected-resource')))
    await expect(resolveMcpOAuthDiscovery('https://mcp.example.test/mcp')).rejects.toThrow(/HTTPS/)

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://mcp.example.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorization_servers: ['http://auth.example.test'] }))))
    await expect(resolveMcpOAuthDiscovery('https://mcp.example.test/mcp')).rejects.toThrow(/HTTPS/)
  })

  it('allows loopback HTTP throughout protected-resource discovery', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(challenge('http://metadata.localhost:4444/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorization_servers: ['http://127.42.7.9:5555'] })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveMcpOAuthDiscovery('http://metadata.localhost:4444/mcp')).resolves.toEqual({
      url: 'http://127.42.7.9:5555/',
      scopes: undefined,
    })
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://metadata.localhost:4444/mcp', expect.objectContaining({ redirect: 'error' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://metadata.localhost:4444/.well-known/oauth-protected-resource', expect.objectContaining({ redirect: 'error' }))
  })
})

describe('MCP credentials', () => {
  it('rejects server names that are not simple identifiers', async () => {
    const providerService = serviceWithSettings()
    for (const server of ['../evil', '__proto__', 'constructor', 'bad name!']) {
      await expect(providerService.logoutMcp(server)).rejects.toThrow('MCP server name contains unsupported characters')
      await expect(providerService.removeMcpCredential(server)).rejects.toThrow('MCP server name contains unsupported characters')
    }
  })

  it('reports an unknown integration when neither the settings file nor the catalog knows the server', async () => {
    await expect(serviceWithSettings().logoutMcp('acme')).rejects.toThrow('Unknown MCP integration: acme')
    await expect(serviceWithSettings(JSON.stringify({ mcpServers: {} })).logoutMcp('acme')).rejects.toThrow('Unknown MCP integration: acme')
    await expect(serviceWithSettings(JSON.stringify({})).logoutMcp('acme')).rejects.toThrow('Unknown MCP integration: acme')
  })

  it('reports unusable Prime Agent settings instead of an unknown integration', async () => {
    await expect(serviceWithSettings('{').logoutMcp('acme')).rejects.toThrow('Prime Agent settings are not valid JSON')
    await expect(serviceWithSettings('[]').logoutMcp('acme')).rejects.toThrow('Prime Agent settings must contain a JSON object')
    await expect(serviceWithSettings(JSON.stringify({ mcpServers: [] })).logoutMcp('acme')).rejects.toThrow('Prime Agent MCP settings must contain a JSON object')
  })

  it('requires a configured server to opt into OAuth over HTTP', async () => {
    await expect(serviceWithSettings(JSON.stringify({ mcpServers: { acme: { type: 'stdio', command: 'acme' } } })).logoutMcp('acme'))
      .rejects.toThrow('MCP server acme is not configured for OAuth')
    await expect(serviceWithSettings(JSON.stringify({ mcpServers: { acme: { type: 'http', url: 'https://acme.test/mcp' } } })).logoutMcp('acme'))
      .rejects.toThrow('MCP server acme is not configured for OAuth')
    await expect(serviceWithSettings(JSON.stringify({ mcpServers: { acme: 'https://acme.test/mcp' } })).logoutMcp('acme'))
      .rejects.toThrow('MCP server acme is not configured for OAuth')
  })

  it('registers a discovered OAuth provider for a configured HTTP server', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(challenge('https://acme.test/.well-known/oauth-protected-resource'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authorization_servers: ['https://auth.acme.test'] }))))
    const providerService = serviceWithSettings(JSON.stringify({ mcpServers: { acme: { type: 'http', url: 'https://acme.test/mcp', oauth: true } } }))
    await expect(providerService.logoutMcp('acme')).resolves.toBeUndefined()
  })

  it('clears a stored credential for a syntactically valid server name', async () => {
    await expect(serviceWithSettings().removeMcpCredential('acme')).resolves.toBeUndefined()
  })
})

describe('provider login flow bookkeeping', () => {
  it('ignores responses and cancellations for unknown flows', () => {
    const providerService = serviceWithSettings()
    expect(providerService.respondOAuth('flow-1', 'prompt-1', 'value')).toBe(false)
    expect(providerService.cancelOAuth('flow-1')).toBe(false)
    expect(() => providerService.respondOAuth('', 'prompt-1', 'value')).toThrow('flowId is too short')
    expect(() => providerService.cancelOAuth(7)).toThrow('flowId must be a string')
    expect(() => providerService.cancelAll()).not.toThrow()
  })
})
