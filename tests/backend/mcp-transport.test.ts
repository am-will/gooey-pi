import { describe, expect, it } from 'vitest'
import { validateMcpConnection } from '../../electron/main/plugins/mcp'

describe('MCP transport policy', () => {
  it('rejects remote plaintext HTTP for every harness and authentication mode', () => {
    for (const harness of ['prime', 'omp', 'pi'] as const) {
      for (const auth of ['none', 'bearer', 'oauth'] as const) {
        expect(() => validateMcpConnection({
          name: 'remote-mcp',
          scope: 'user',
          type: 'http',
          url: 'http://mcp.example.test/service',
          auth,
          ...(auth === 'bearer' ? { bearerTokenEnvVar: 'MCP_TOKEN' } : {}),
        }, harness), `${harness}/${auth}`).toThrow(/HTTPS/)
      }
    }
  })

  it('accepts HTTPS and loopback HTTP for every harness', () => {
    const allowed = [
      'https://mcp.example.test/service',
      'http://localhost:3000/service',
      'http://tools.localhost:3000/service',
      'http://127.0.0.1:3000/service',
      'http://127.42.7.9:3000/service',
      'http://[::1]:3000/service',
    ]
    for (const harness of ['prime', 'omp', 'pi'] as const) {
      for (const url of allowed) {
        const connection = validateMcpConnection({ name: 'safe-mcp', scope: 'user', type: 'http', url }, harness)
        expect(connection, `${harness}/${url}`).toMatchObject({ type: 'http', url: new URL(url).toString() })
      }
    }
  })

  it('does not mistake loopback-looking public hostnames for loopback', () => {
    for (const url of [
      'http://localhost.example.test/service',
      'http://127.0.0.1.example.test/service',
      'http://128.0.0.1/service',
    ]) {
      expect(() => validateMcpConnection({ name: 'lookalike', scope: 'user', type: 'http', url }, 'prime'), url).toThrow(/HTTPS/)
    }
  })
})
