import type { WebContents } from 'electron'
import { requireRecord } from '../validation'
import { guardGuestCall } from './guest-call-guard'
import { AGENT_WORLD_ID, elementAtPointScript, pageInfoScript, refPointScript } from './page-scripts'

interface PageInfo {
  url: string
  title: string
  innerWidth: number
  innerHeight: number
}

function parseScriptJson(payload: unknown, label: string): Record<string, unknown> {
  if (typeof payload !== 'string') throw new Error(`The page did not respond to ${label}. It may still be loading; try again.`)
  if (Buffer.byteLength(payload, 'utf8') > 256 * 1024) throw new Error(`The page response exceeded the byte limit for ${label}.`)
  let parsed: unknown
  try { parsed = JSON.parse(payload) } catch { throw new Error(`The page returned malformed data for ${label}.`) }
  return requireRecord(parsed, label)
}


/** Owns bounded reads and point validation for approved browser guests. */
export class GuestPageIO {
  constructor(private readonly actionTimeoutMs: number) {}

  async runPageScript(guest: WebContents, script: string, label: string): Promise<Record<string, unknown>> {
    return parseScriptJson(await guardGuestCall(guest, guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code: script }]), this.actionTimeoutMs), label)
  }
  async pageInfo(guest: WebContents): Promise<PageInfo> {
    const payload = await this.runPageScript(guest, pageInfoScript(), 'page info')
    return {
      url: guest.getURL().slice(0, 2000),
      title: guest.getTitle().slice(0, 300),
      innerWidth: typeof payload.innerWidth === 'number' && Number.isFinite(payload.innerWidth) ? Math.max(0, Math.min(20_000, Math.round(payload.innerWidth))) : 0,
      innerHeight: typeof payload.innerHeight === 'number' && Number.isFinite(payload.innerHeight) ? Math.max(0, Math.min(20_000, Math.round(payload.innerHeight))) : 0,
    }
  }

  async elementAt(guest: WebContents, point: { x: number; y: number }): Promise<Record<string, unknown> | null> {
    try {
      const payload = await this.runPageScript(guest, elementAtPointScript(point.x, point.y), 'element at point')
      return typeof payload.tag === 'string' ? { tag: payload.tag, name: typeof payload.name === 'string' ? payload.name : '' } : null
    } catch { return null }
  }

  async resolvePoint(guest: WebContents, params: Record<string, unknown>, focus: boolean): Promise<{ x: number; y: number }> {
    let x: unknown = params.x
    let y: unknown = params.y
    if (params.ref !== undefined) {
      if (typeof params.ref !== 'number' || !Number.isSafeInteger(params.ref) || params.ref < 0 || params.ref > 999) throw new TypeError('ref must be an element number from browser_read_page')
      const payload = await this.runPageScript(guest, refPointScript(params.ref, focus), 'element ref')
      if (typeof payload.error === 'string') throw new Error(payload.error.slice(0, 300))
      x = payload.x
      y = payload.y
    }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('Provide either ref (from browser_read_page) or x and y coordinates with finite values')
    const point = { x: Math.round(x), y: Math.round(y) }
    const viewport = await this.pageInfo(guest)
    if (point.x < 0 || point.y < 0 || point.x >= viewport.innerWidth || point.y >= viewport.innerHeight) throw new TypeError('x and y must be within the page viewport')
    return point
  }
}
