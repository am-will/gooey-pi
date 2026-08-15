import { describe, expect, it } from 'vitest'
import { parseMcpCommand } from '../../src/hooks/useWorkspaceActions'

describe('Prime MCP slash command routing', () => {
  it('opens Capabilities for the bare command', () => {
    expect(parseMcpCommand(' /mcp ', 'prime')).toEqual({ type: 'open' })
  })

  it('extracts a bounded MCP login target', () => {
    expect(parseMcpCommand('/mcp login notion', 'prime')).toEqual({ type: 'authenticate', server: 'notion' })
    expect(parseMcpCommand('/mcp   login   team docs', 'prime')).toEqual({ type: 'authenticate', server: 'team docs' })
  })

  it('blocks unsafe login targets instead of forwarding them to the harness', () => {
    expect(parseMcpCommand('/mcp login ../notion', 'prime')).toEqual({ type: 'authenticate' })
    expect(parseMcpCommand('/mcp login __proto__', 'prime')).toEqual({ type: 'authenticate' })
  })

  it('intercepts each harness remote-auth command while leaving local MCP commands alone', () => {
    expect(parseMcpCommand('/mcp reauth docs', 'omp')).toEqual({ type: 'authenticate', server: 'docs' })
    expect(parseMcpCommand('/mcp reauth', 'omp')).toEqual({ type: 'authenticate' })
    expect(parseMcpCommand('/mcp-auth docs', 'pi')).toEqual({ type: 'authenticate', server: 'docs' })
    expect(parseMcpCommand('/mcp-auth ../docs', 'pi')).toEqual({ type: 'authenticate' })
    expect(parseMcpCommand('/mcp list', 'prime')).toBeUndefined()
    expect(parseMcpCommand('/mcp list', 'omp')).toBeUndefined()
    expect(parseMcpCommand('/mcp', 'pi')).toBeUndefined()
  })
})
