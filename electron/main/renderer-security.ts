import { Menu, protocol, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, win32 as win32Path } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BROWSER_PARTITION } from '../../src/types/api'
import { isAllowedBrowserUrl } from '../../src/lib/browser-url'
import { isTrustedRendererUrl } from './ipc'
import { PACKAGED_RENDERER_URL } from './packaged-smoke'

// One policy for every surface that serves renderer content: the app protocol
// response headers and the packaged browser-session header rewrite.
export const RENDERER_CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

const rendererContentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
}

export function registerRendererProtocol(rendererRoot: string): void {
  protocol.handle('prime-work', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'app' || url.username || url.password || url.search || url.hash) return new Response('Not found', { status: 404 })
      const decoded = decodeURIComponent(url.pathname)
      const candidate = resolveRendererAssetPath(rendererRoot, decoded)
      if (!candidate) return new Response('Not found', { status: 404 })
      const body = await readFile(candidate)
      return new Response(body, { headers: {
        'Content-Type': rendererContentTypes[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
        'Content-Security-Policy': RENDERER_CONTENT_SECURITY_POLICY,
        'X-Content-Type-Options': 'nosniff',
      } })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

/** Resolves a renderer URL path without relying on a platform-specific separator. */
export function resolveRendererAssetPath(rendererRoot: string, decodedPath: string): string | null {
  if (!decodedPath.startsWith('/') || decodedPath.includes('\0') || decodedPath.includes('\\')) return null
  const pathApi = /^[A-Za-z]:[\\/]/.test(rendererRoot) ? win32Path : { resolve, relative, isAbsolute }
  const candidate = pathApi.resolve(rendererRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`)
  const relativePath = pathApi.relative(rendererRoot, candidate)
  if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) return null
  return candidate
}

export function resolveRendererUrl(options: { isPackaged: boolean; rendererRoot: string; developmentUrl?: string }): string {
  const developmentUrl = !options.isPackaged ? options.developmentUrl : undefined
  if (!developmentUrl) return options.isPackaged ? PACKAGED_RENDERER_URL : pathToFileURL(join(options.rendererRoot, 'index.html')).href
  const parsed = new URL(developmentUrl)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('ELECTRON_RENDERER_URL must use an uncredentialed loopback HTTP(S) origin')
  }
  return parsed.href
}


export function hardenRenderer(window: BrowserWindow, trustedUrl: () => string, hooks: { approveGuest?(contents: WebContents): void; cancelDownloads?(ownerId: number): void } = {}): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('context-menu', (_event, params) => {
    const contents = window.webContents
    const template: MenuItemConstructorOptions[] = []
    if (params.isEditable) {
      if (params.misspelledWord) {
        for (const suggestion of params.dictionarySuggestions.slice(0, 5)) template.push({
          label: suggestion,
          click: () => { if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion) },
        })
        template.push({ label: 'Add to Dictionary', click: () => {
          if (!contents.isDestroyed()) contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        } }, { type: 'separator' })
      }
      template.push(
        { role: 'undo', enabled: params.editFlags.canUndo }, { role: 'redo', enabled: params.editFlags.canRedo }, { type: 'separator' },
        { role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' },
      )
    } else if (params.selectionText) template.push({ role: 'copy', enabled: params.editFlags.canCopy })
    if (params.mediaType === 'image' && params.hasImageContents) {
      if (template.length) template.push({ type: 'separator' })
      template.push({
        label: 'Copy Image',
        click: () => { if (!window.isDestroyed() && !contents.isDestroyed()) contents.copyImageAt(params.x, params.y) },
      })
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window })
  })
  window.webContents.on('will-attach-webview', (event, preferences, params) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.nodeIntegrationInSubFrames = false
    preferences.contextIsolation = true
    preferences.sandbox = true
    preferences.webSecurity = true
    preferences.allowRunningInsecureContent = false
    // A guest page must never be able to attach a nested guest of its own.
    preferences.webviewTag = false
    const partition = typeof params.partition === 'string' ? params.partition : ''
    if (partition !== BROWSER_PARTITION || !isAllowedBrowserUrl(params.src)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (!isAllowedBrowserUrl(target)) event.preventDefault() })
    contents.on('will-redirect', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.on('will-frame-navigate', (event) => { if (!isAllowedBrowserUrl(event.url)) event.preventDefault() })
    contents.once('destroyed', () => hooks.cancelDownloads?.(contents.id))
    // Guests reaching this point passed the will-attach-webview partition and
    // URL gates above, which makes them eligible for agent control.
    hooks.approveGuest?.(contents)
  })
  window.webContents.on('will-navigate', (event, target) => {
    const current = window.webContents.getURL()
    if (target !== current) event.preventDefault()
  })
  // Server redirects and sub-frame navigations bypass will-navigate; hold them
  // to the same trusted-renderer predicate the IPC gate uses.
  window.webContents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => {
    if (!isTrustedRendererUrl(event.url, trustedUrl())) event.preventDefault()
  })
}

