import { parseMcpAuthenticationCommand } from '@/lib/mcp-policy'
import type { HarnessId } from '@/types/api'

export type McpCommand = { type: 'open' } | { type: 'authenticate'; server?: string }

export function parseCompactCommand(prompt: string): { customInstructions?: string } | undefined {
  const trimmed = prompt.trim()
  if (trimmed === '/compact') return {}
  if (trimmed.startsWith('/compact ')) {
    const customInstructions = trimmed.slice(9).trim()
    return customInstructions ? { customInstructions } : {}
  }
  return undefined
}

export function parseMcpCommand(prompt: string, harness: HarnessId): McpCommand | undefined {
  const value = prompt.trim()
  if (harness === 'prime' && value === '/mcp') return { type: 'open' }
  const authentication = parseMcpAuthenticationCommand(value, harness)
  return authentication
    ? authentication.server ? { type: 'authenticate', server: authentication.server } : { type: 'authenticate' }
    : undefined
}
