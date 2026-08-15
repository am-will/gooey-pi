import { isAbsolute } from 'node:path'

export const EXPECTED_PACKAGED_RENDERER_URL = 'prime-work://app/index.html'
export const PACKAGED_SMOKE_ARGUMENT = '--gooeypi-packaged-smoke'
export const PACKAGED_SMOKE_USER_DATA_ARGUMENT = '--gooeypi-packaged-smoke-user-data='
export const PACKAGED_SMOKE_READY_FILE = 'packaged-smoke-ready.json'
export const PACKAGED_SMOKE_READY_EVENT = 'gooeypi-packaged-smoke-ready'
export const MAX_PACKAGED_SMOKE_READY_BYTES = 4 * 1024

const RENDERER_READY_EVENT = 'gooeypi:renderer-ready'
const RENDERER_READY_ATTRIBUTE = 'gooeypiRendererReady'

export interface PackagedSmokeRequest {
  enabled: boolean
  userDataPath?: string
}

export interface PackagedSmokeResult {
  event: typeof PACKAGED_SMOKE_READY_EVENT
  url: string
  preload: true
  renderer: true
}

interface PackagedSmokeRenderer {
  getURL(): string
  executeJavaScript(source: string): Promise<unknown>
}

function sameRendererUrl(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual)
    const expectedUrl = new URL(expected)
    actualUrl.hash = ''
    expectedUrl.hash = ''
    return actualUrl.href === expectedUrl.href
  } catch { return false }
}

export function parsePackagedSmokeRequest(argv: readonly string[]): PackagedSmokeRequest {
  const enabled = argv.includes(PACKAGED_SMOKE_ARGUMENT)
  const userDataArguments = argv.filter((argument) => argument.startsWith(PACKAGED_SMOKE_USER_DATA_ARGUMENT))
  if (!enabled && userDataArguments.length === 0) return { enabled: false }
  if (!enabled || userDataArguments.length !== 1) throw new Error('Packaged smoke mode requires exactly one isolated user-data directory')
  const userDataPath = userDataArguments[0].slice(PACKAGED_SMOKE_USER_DATA_ARGUMENT.length)
  if (!userDataPath || userDataPath.trim() !== userDataPath || /[\0\r\n]/.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new Error('Packaged smoke user-data directory must be an absolute single-line path')
  }
  return { enabled: true, userDataPath }
}

export function assertPackagedSmokeProbe(value: unknown, expectedUrl: string): PackagedSmokeResult {
  if (typeof value !== 'object' || value === null) throw new Error('Packaged renderer returned an invalid readiness probe')
  const probe = value as Record<string, unknown>
  if (typeof probe.url !== 'string' || !sameRendererUrl(probe.url, expectedUrl)) throw new Error(`Packaged renderer reported an unexpected renderer URL: ${String(probe.url)}`)
  if (probe.preload !== true) throw new Error('Packaged renderer preload bridge is not ready')
  if (probe.renderer !== true) throw new Error('Packaged renderer did not report ready')
  return { event: PACKAGED_SMOKE_READY_EVENT, url: expectedUrl, preload: true, renderer: true }
}

export function serializePackagedSmokeResult(result: PackagedSmokeResult): string {
  const source = `${JSON.stringify(result)}\n`
  if (Buffer.byteLength(source, 'utf8') > MAX_PACKAGED_SMOKE_READY_BYTES) throw new Error('Packaged smoke readiness marker exceeds its byte limit')
  return source
}

const PACKAGED_SMOKE_PROBE = `(() => new Promise((resolve) => {
  const rendererReady = () => document.documentElement.dataset.${RENDERER_READY_ATTRIBUTE} === 'true'
  const snapshot = async () => {
    let preload = false
    if (typeof window.prime?.app?.getMeta === 'function') {
      try {
        await window.prime.app.getMeta()
        preload = true
      } catch {}
    }
    resolve({ url: window.location.href, preload, renderer: rendererReady() })
  }
  if (rendererReady()) return void snapshot()
  window.addEventListener('${RENDERER_READY_EVENT}', () => void snapshot(), { once: true })
}))()`

export async function waitForPackagedSmokeRenderer(
  renderer: PackagedSmokeRenderer,
  expectedUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<PackagedSmokeResult> {
  const timeoutMs = options.timeoutMs ?? 20_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Packaged renderer timeout must be between 1 and 60000 ms')
  if (!sameRendererUrl(renderer.getURL(), expectedUrl)) throw new Error(`Packaged smoke mode reached an untrusted renderer URL: ${renderer.getURL()}`)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Packaged renderer did not report ready within ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    const probe = await Promise.race([renderer.executeJavaScript(PACKAGED_SMOKE_PROBE), timeout])
    if (!sameRendererUrl(renderer.getURL(), expectedUrl)) throw new Error(`Packaged smoke mode navigated to an untrusted renderer URL: ${renderer.getURL()}`)
    return assertPackagedSmokeProbe(probe, expectedUrl)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
