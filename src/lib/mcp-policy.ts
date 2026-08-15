import type { HarnessId } from '../types/api'

/**
 * GooeyPi does not own the network transport or OAuth discovery performed by
 * Prime, OMP, or Pi. Keep network MCP management outside the app instead of
 * implying that selected app-side validation can secure an upstream runtime.
 */
export const NETWORK_MCP_UNAVAILABLE_DETAIL = 'Network MCP servers are managed outside GooeyPi. GooeyPi does not create, enable, disable, or authenticate HTTP/SSE servers; use the harness directly. Externally configured definitions are read-only here except explicit definition removal. Authorization is never inspected or changed by GooeyPi.'

export const NETWORK_MCP_AUTH_UNAVAILABLE = 'Network MCP authentication is managed outside GooeyPi. Use the harness directly; GooeyPi does not inspect or change MCP credentials.'

export const PRIME_MCP_MANAGEMENT_UNAVAILABLE_DETAIL = 'Prime Agent MCP servers are managed outside GooeyPi. GooeyPi only manages local stdio MCP definitions for OMP and Pi; Prime definitions may only be removed here, and Prime authorization must be managed directly in Prime Agent.'

export const PI_MCP_ADAPTER_REQUIRED_DETAIL = 'Pi core does not include MCP. Install GooeyPi\'s supported adapter first: pi install npm:pi-mcp-adapter'

export const LOCAL_MCP_STATE_UNAVAILABLE_DETAIL = 'This local MCP definition uses a key GooeyPi cannot safely enable or disable. Its state is managed outside GooeyPi; use the harness directly. Bounded exact-definition removal remains available when supported.'

/** Exact MCP map keys above this limit stay visible but are not app-removable. */
export const MAX_MCP_DEFINITION_KEY_LENGTH = 1_024

const UNSAFE_MCP_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export interface McpAuthenticationCommand {
  server?: string
}

function parsedAuthenticationCommand(match: RegExpMatchArray | null): McpAuthenticationCommand | undefined {
  if (!match) return undefined
  const server = match[1]?.trim()
  if (!server || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(server) || UNSAFE_MCP_KEYS.has(server)) return {}
  return { server }
}

/** Recognizes the authentication command exposed by each harness without executing it. */
export function parseMcpAuthenticationCommand(prompt: string, harness: HarnessId): McpAuthenticationCommand | undefined {
  const value = prompt.trim()
  if (harness === 'prime') return parsedAuthenticationCommand(value.match(/^\/mcp\s+login(?:\s+([\s\S]*))?$/i))
  if (harness === 'omp') return parsedAuthenticationCommand(value.match(/^\/mcp\s+reauth(?:\s+([\s\S]*))?$/i))
  return parsedAuthenticationCommand(value.match(/^\/mcp-auth(?:\s+([\s\S]*))?$/i))
}

/** Authentication is harness-owned, so no app-managed delivery path may forward these commands. */
export function assertNoMcpAuthenticationCommand(prompt: string, harness: HarnessId): void {
  if (parseMcpAuthenticationCommand(prompt, harness)) throw new TypeError(NETWORK_MCP_AUTH_UNAVAILABLE)
}

export function isAppManageableLocalMcpKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 64
    && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
    && !UNSAFE_MCP_KEYS.has(value)
}

export function isNetworkMcpDefinition(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.type === 'http' || record.type === 'sse' || Object.hasOwn(record, 'url')
}
