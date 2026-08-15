import type { HarnessId } from '../../../src/types/api'
import { isRecord, requireHttpsOrLoopbackUrl } from '../validation'

/** True when a persisted definition represents the harness's HTTP transport. */
export function isPersistedHttpMcpDefinition(value: unknown, harness: HarnessId): boolean {
  if (!isRecord(value)) return false
  if (harness === 'pi') return Object.hasOwn(value, 'url')
  return value.type === 'http' || (harness === 'omp' && value.type === 'sse')
}

/**
 * Persisted settings are not trusted: they may predate the current policy or
 * have been edited outside GooeyPi. Invalid HTTP URLs fail closed too.
 */
export function isInsecurePersistedMcpDefinition(value: unknown, harness: HarnessId): boolean {
  if (!isPersistedHttpMcpDefinition(value, harness) || !isRecord(value)) return false
  try {
    requireHttpsOrLoopbackUrl(value.url, { label: 'MCP server URL', max: 2_048 })
    return false
  } catch {
    return true
  }
}
