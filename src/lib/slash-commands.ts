import { parseMcpAuthenticationCommand } from '@/lib/mcp-policy'
import type { HarnessId } from '@/types/api'

export type McpCommand = { type: 'open' } | { type: 'authenticate'; server?: string }

/** Any whitespace, including a Shift+Enter newline, separates /compact from its instructions. */
export function parseCompactCommand(prompt: string): { customInstructions?: string } | undefined {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(prompt.trim())
  if (!match) return undefined
  return match[1] ? { customInstructions: match[1] } : {}
}

export function parseMcpCommand(prompt: string, harness: HarnessId): McpCommand | undefined {
  const value = prompt.trim()
  if (harness === 'prime' && value === '/mcp') return { type: 'open' }
  const authentication = parseMcpAuthenticationCommand(value, harness)
  return authentication
    ? authentication.server ? { type: 'authenticate', server: authentication.server } : { type: 'authenticate' }
    : undefined
}

/** Names a command GooeyPi handles itself instead of sending it to the harness as a prompt. */
export function interceptedCommandName(prompt: string, harness: HarnessId): string | undefined {
  if (!parseCompactCommand(prompt) && !parseMcpCommand(prompt, harness)) return undefined
  return prompt.trim().split(/\s/, 1)[0]
}
