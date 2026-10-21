import type { WebContents } from 'electron'
import type { AgentBrowserPointerEvent } from '../../../src/types/api'
import { delay } from '../lib/async'
import { requireString } from '../validation'
import { guardGuestDeadline } from './guest-call-guard'

interface CdpKey {
  key: string
  code: string
  keyCode: number
  text?: string
}
const PRESS_KEYS: Record<string, CdpKey> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
}
// DevTools protocol modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
const PRESS_MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, meta: 4, shift: 8 }
const GLIDE_MAX_MS = 550
const GLIDE_MIN_MS = 160
const GLIDE_STEP_MS = 28


/** Owns trusted keyboard input and pointer movement in approved guests. */
export class GuestInput {
  constructor(private readonly actionTimeoutMs: number, private readonly onPointer: (event: AgentBrowserPointerEvent) => void) {}

  async pressKey(guest: WebContents, keyValue: unknown, modifiersValue?: unknown): Promise<void> {
    const rawKey = requireString(keyValue, 'key', { min: 1, max: 24, trim: true })
    const key = rawKey.length === 1
      ? { key: rawKey, code: '', keyCode: rawKey.toUpperCase().charCodeAt(0), text: rawKey }
      : Object.hasOwn(PRESS_KEYS, rawKey.toLowerCase()) ? PRESS_KEYS[rawKey.toLowerCase()] : undefined
    if (!key) throw new TypeError(`key must be a single character or one of: ${Object.keys(PRESS_KEYS).join(', ')}`)
    const modifiers: string[] = []
    if (modifiersValue !== undefined) {
      if (!Array.isArray(modifiersValue)) throw new TypeError('modifiers must be an array')
      for (const modifier of modifiersValue.slice(0, 4)) {
        const name = requireString(modifier, 'modifier', { min: 1, max: 12, trim: true }).toLowerCase()
        if (!Object.hasOwn(PRESS_MODIFIER_BITS, name)) throw new TypeError('modifiers may only include shift, control, alt, meta')
        modifiers.push(name)
      }
    }
    await this.sendKey(guest, key, modifiers)
  }

  /**
   * Moves the pointer from its last position to the target as a smooth eased
   * glide of real mouseMove events (so pages get genuine hover states), and
   * emits a pointer event on the same clock so the renderer's synthetic
   * cursor can animate the identical path.
   */
  async glidePointer(tab: { tabId: string; sessionKey: string; pointer: { x: number; y: number } | null }, guest: WebContents, to: { x: number; y: number }, action: AgentBrowserPointerEvent['action']): Promise<void> {
    const from = tab.pointer
    const distance = from ? Math.hypot(to.x - from.x, to.y - from.y) : 0
    const durationMs = from && distance > 2 ? Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, Math.round(distance * 0.9))) : 0
    const event: AgentBrowserPointerEvent = { tabId: tab.tabId, sessionFile: tab.sessionKey, from, to: { ...to }, action, durationMs }
    this.onPointer(event)
    if (from && durationMs > 0) {
      const steps = Math.min(18, Math.max(5, Math.round(durationMs / GLIDE_STEP_MS)))
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps
        const eased = progress * progress * (3 - 2 * progress)
        await this.dispatchInput(guest, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: Math.round(from.x + (to.x - from.x) * eased),
          y: Math.round(from.y + (to.y - from.y) * eased),
        })
        await delay(durationMs / steps)
      }
    } else {
      await this.dispatchInput(guest, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y })
    }
    tab.pointer = { x: to.x, y: to.y }
  }

  /**
   * webContents.sendInputEvent does not reach OOPIF-based webview guests
   * (input routing happens in the embedder); the DevTools protocol Input
   * domain dispatches with real hit-testing, so all synthetic input goes
   * through the debugger instead.
   */
  async dispatchInput(guest: WebContents, method: string, params: Record<string, unknown>): Promise<void> {
    if (!guest.debugger.isAttached()) guest.debugger.attach('1.3')
    await guardGuestDeadline(guest.debugger.sendCommand(method, params), this.actionTimeoutMs)
  }

  private async sendKey(guest: WebContents, key: CdpKey, modifiers: string[]): Promise<void> {
    const bits = modifiers.reduce((mask, name) => mask | (PRESS_MODIFIER_BITS[name] ?? 0), 0)
    const base = { modifiers: bits, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode }
    // A key with text uses keyDown so the page also receives the character;
    // keys without text (arrows, tab) and chorded shortcuts (ctrl/alt/meta
    // held) use rawKeyDown.
    const chorded = (bits & (PRESS_MODIFIER_BITS.alt | PRESS_MODIFIER_BITS.control | PRESS_MODIFIER_BITS.meta)) !== 0
    if (key.text && !chorded) await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: key.text })
    else await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' })
    await this.dispatchInput(guest, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
  }

}
