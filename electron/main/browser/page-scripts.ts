/**
 * JavaScript source strings injected into agent-controlled browser guests.
 * Everything these scripts return is untrusted page data: callers must bound
 * and sanitize it before it reaches the agent or the renderer. Dynamic values
 * use JSON.stringify for strings or validated integers. evaluateScript alone
 * intentionally accepts agent-authored JavaScript as a function body.
 */

const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="combobox"], [role="option"], [role="switch"], [contenteditable="true"], [onclick]'

function boundedInt(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  return value
}

/**
 * Collects visible interactive elements, numbers them, and stashes the live
 * element list on the page so later ref-based actions can find them again.
 * Refs are invalidated by navigation (the stored URL no longer matches).
 */
export function readPageScript(mode: 'interactive' | 'text', maxTextChars: number, maxElements: number): string {
  const textLimit = boundedInt(maxTextChars, 0, 200_000, 'maxTextChars')
  const elementLimit = boundedInt(maxElements, 0, 1_000, 'maxElements')
  const includeText = mode === 'text'
  return `(() => {
    const selector = ${JSON.stringify(INTERACTIVE_SELECTOR)}
    const bound = (value, limit) => typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim().slice(0, limit) : ''
    const visible = (el) => {
      if (!el.isConnected) return false
      const rects = el.getClientRects()
      if (!rects.length) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none'
    }
    const name = (el) => {
      const aria = el.getAttribute('aria-label')
      if (aria) return bound(aria, 120)
      if (el.labels && el.labels.length) return bound(el.labels[0].textContent, 120)
      const placeholder = el.getAttribute('placeholder')
      if (placeholder) return bound(placeholder, 120)
      const alt = el.getAttribute('alt')
      if (alt) return bound(alt, 120)
      const text = bound(el.textContent, 120)
      if (text) return text
      const title = el.getAttribute('title')
      if (title) return bound(title, 120)
      return bound(el.getAttribute('name') || el.id || '', 120)
    }
    const refs = []
    const elements = []
    for (const el of document.querySelectorAll(selector)) {
      if (elements.length >= ${elementLimit}) break
      if (!visible(el)) continue
      const ref = refs.length
      refs.push(el)
      const entry = {
        ref,
        tag: el.tagName.toLowerCase(),
        name: name(el),
      }
      const role = el.getAttribute('role')
      if (role) entry.role = bound(role, 32)
      if (entry.tag === 'a') entry.href = bound(el.getAttribute('href') || '', 200)
      if (entry.tag === 'input') {
        entry.inputType = bound(el.getAttribute('type') || 'text', 32).toLowerCase()
        if (entry.inputType !== 'password' && typeof el.value === 'string') entry.value = bound(el.value, 120)
        if (el.checked === true) entry.checked = true
      }
      if (entry.tag === 'select' && typeof el.value === 'string') entry.value = bound(el.value, 120)
      if (el.disabled === true) entry.disabled = true
      elements.push(entry)
    }
    window.__primeWorkAgentRefs = refs
    window.__primeWorkAgentRefsUrl = location.href
    const result = {
      url: String(location.href).slice(0, 2000),
      title: bound(document.title, 300),
      elements,
    }
    if (${includeText}) result.text = (document.body ? document.body.innerText : '').slice(0, ${textLimit})
    return JSON.stringify(result)
  })()`
}

/**
 * Scrolls the referenced element into view and reports its viewport-relative
 * center so the caller can dispatch trusted input events at that point.
 */
export function refPointScript(ref: number, focus: boolean): string {
  const index = boundedInt(ref, 0, 999, 'ref')
  return `(() => {
    const refs = window.__primeWorkAgentRefs
    if (!Array.isArray(refs) || window.__primeWorkAgentRefsUrl !== location.href) return JSON.stringify({ error: 'Element refs are stale. Call browser_read_page again to refresh them.' })
    const el = refs[${index}]
    if (!el || !el.isConnected) return JSON.stringify({ error: 'That element ref no longer exists on the page. Call browser_read_page again.' })
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    ${focus ? 'if (typeof el.focus === "function") el.focus()' : ''}
    const rect = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) })
  })()`
}

export function scrollByScript(deltaX: number, deltaY: number): string {
  const dx = boundedInt(deltaX, -100_000, 100_000, 'deltaX')
  const dy = boundedInt(deltaY, -100_000, 100_000, 'deltaY')
  return `(() => {
    window.scrollBy({ left: ${dx}, top: ${dy}, behavior: 'instant' })
    const root = document.scrollingElement || document.documentElement
    return JSON.stringify({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), scrollHeight: root ? root.scrollHeight : 0, viewportHeight: window.innerHeight })
  })()`
}

/**
 * Places (or moves) a small in-page cursor marker so screenshots show where
 * the agent's pointer currently is; removed again right after capture.
 */
export function cursorMarkerScript(x: number, y: number): string {
  const px = boundedInt(x, 0, 100_000, 'x')
  const py = boundedInt(y, 0, 100_000, 'y')
  return `(() => {
    let marker = document.getElementById('__primeWorkAgentCursorMarker')
    if (!marker) {
      marker = document.createElement('div')
      marker.id = '__primeWorkAgentCursorMarker'
      marker.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border:2.5px solid #fff;border-radius:50%;background:#2488ff;box-shadow:0 0 0 1.5px rgba(0,0,0,.55), 0 0 8px rgba(36,136,255,.9)'
      if (document.documentElement) document.documentElement.appendChild(marker)
    }
    marker.style.left = '${px}px'
    marker.style.top = '${py}px'
    return true
  })()`
}

export function removeCursorMarkerScript(): string {
  return `(() => {
    const marker = document.getElementById('__primeWorkAgentCursorMarker')
    if (marker) marker.remove()
    return true
  })()`
}

/** Describes the element that a click at the given viewport point would hit. */
export function elementAtPointScript(x: number, y: number): string {
  const px = boundedInt(x, 0, 100_000, 'x')
  const py = boundedInt(y, 0, 100_000, 'y')
  return `(() => {
    const el = document.elementFromPoint(${px}, ${py})
    if (!el) return JSON.stringify({})
    const bound = (value) => typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim().slice(0, 120) : ''
    return JSON.stringify({
      tag: el.tagName.toLowerCase(),
      name: bound(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || ''),
    })
  })()`
}

export function pageInfoScript(): string {
  return `(() => JSON.stringify({
    url: String(location.href).slice(0, 2000),
    title: (document.title || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    scrollHeight: (document.scrollingElement || document.documentElement || {}).scrollHeight || 0,
    readyState: document.readyState,
  }))()`
}

/** Runs agent-authored code as an async function body and returns bounded JSON. */
export function evaluateScript(code: string, maxResultChars: number): string {
  const limit = boundedInt(maxResultChars, 1, 100_000, 'maxResultChars')
  return `(async () => {
    try {
      const value = await (async () => {
${code}
      })()
      let rendered
      try { rendered = JSON.stringify(value) } catch { rendered = undefined }
      if (rendered === undefined) rendered = String(value)
      return JSON.stringify({ ok: true, value: rendered.slice(0, ${limit}) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: String(error).slice(0, 2000) })
    }
  })()`
}
