import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

export type JsonObject = Record<string, unknown>

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function requireRecord(value: unknown, label = 'value'): JsonObject {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  return value
}

export function requireString(value: unknown, label: string, options: { min?: number; max?: number; trim?: boolean } = {}): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (value.includes('\0')) throw new TypeError(`${label} contains a NUL byte`)
  const result = options.trim ? value.trim() : value
  if (result.length < (options.min ?? 0)) throw new TypeError(`${label} is too short`)
  if (result.length > (options.max ?? 64 * 1024)) throw new TypeError(`${label} is too long`)
  return result
}

export function requireId(value: unknown, label = 'id'): string {
  const id = requireString(value, label, { min: 1, max: 256, trim: true })
  if (!/^[A-Za-z0-9_.:@-]+$/.test(id)) throw new TypeError(`${label} contains invalid characters`)
  return id
}

export function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

export function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`)
  }
  return value as number
}

export function rejectUnknownKeys(value: JsonObject, allowed: readonly string[], label = 'value'): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unknown) throw new TypeError(`${label}.${unknown} is not supported`)
}

export function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function requireExistingDirectory(value: unknown, label = 'path'): Promise<string> {
  const input = requireString(value, label, { min: 1, max: 4096 })
  if (!isAbsolute(input)) throw new TypeError(`${label} must be absolute`)
  const path = await realpath(input)
  const stat = await lstat(path)
  if (!stat.isDirectory()) throw new TypeError(`${label} must be a directory`)
  return path
}

export async function requireExistingPath(value: unknown, label = 'path'): Promise<string> {
  const input = requireString(value, label, { min: 1, max: 4096 })
  if (!isAbsolute(input)) throw new TypeError(`${label} must be absolute`)
  return realpath(input)
}

export function requireWebUrl(value: unknown, options: { mailto?: boolean; max?: number } = {}): string {
  const raw = requireString(value, 'url', { min: 1, max: options.max ?? 8192, trim: true })
  let parsed: URL
  try { parsed = new URL(raw) } catch { throw new TypeError('Invalid URL') }
  const allowed = options.mailto ? ['http:', 'https:', 'mailto:'] : ['http:', 'https:']
  if (!allowed.includes(parsed.protocol)) throw new TypeError('URL scheme is not allowed')
  if (parsed.username || parsed.password) {
    throw new TypeError('URLs containing credentials are not allowed')
  }
  return parsed.toString()
}

export function isLoopbackHostname(value: string): boolean {
  const host = value.toLowerCase()
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/** Private-network (RFC1918/ULA) or loopback hosts: the safe scope for plaintext-HTTP voice traffic. */
export function isPrivateOrLoopbackHostname(value: string): boolean {
  const host = value.toLowerCase()
  if (isLoopbackHostname(host)) return true
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host
  if (bare === '::1' || bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const first = Number(ipv4[1])
    const second = Number(ipv4[2])
    return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
  }
  return false
}

export function requireSelfHostedVoiceUrl(value: unknown): string {
  const normalized = requireWebUrl(value, { max: 2_048 })
  const parsed = new URL(normalized)
  if (parsed.search || parsed.hash) throw new TypeError('Self-hosted voice URL cannot contain a query or fragment')
  if (parsed.protocol === 'http:' && !isPrivateOrLoopbackHostname(parsed.hostname)) throw new TypeError('Self-hosted voice HTTP is allowed on this computer or private network addresses (10.x, 172.16-31.x, 192.168.x); use HTTPS for public hosts')
  return parsed.toString()
}

export function requireGitPath(value: unknown, label = 'path'): string {
  const input = requireString(value, label, { min: 1, max: 4096 })
  if (isAbsolute(input)) throw new TypeError(`${label} must be a relative path`)
  const parts = input.split(/[\\/]/)
  if (parts.some((part) => part === '' || part === '.' || part === '..')) throw new TypeError(`${label} contains an invalid segment`)
  return input
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function stripAnsi(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ANSI escape introducer is a control character by definition
  return input.replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}
