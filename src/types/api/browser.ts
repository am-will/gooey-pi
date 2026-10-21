/**
 * Session partition shared by the in-app browser webviews. The renderer's
 * webview attribute must match the main process's will-attach-webview gate
 * exactly, or webview attach is silently blocked.
 */
export const BROWSER_PARTITION = 'persist:prime-work-browser'
export const PREVIEW_TAB_ID = 'preview'
export interface BrowserAnnotationRect {
  x: number
  y: number
  width: number
  height: number
}
/** Element info captured from the embedded browser page. Every field is untrusted page data: bounded on capture, rendered as plain text only. */
export interface BrowserAnnotationElement {
  selector: string
  tagName: string
  id: string
  classes: string[]
  text: string
  href?: string
  src?: string
  rect: BrowserAnnotationRect
}
export interface BrowserAnnotation {
  id: string
  comment: string
  element: BrowserAnnotationElement
  pageUrl: string
  pageTitle: string
  /** True once the page navigated away after capture: the live marker is gone but the captured info remains valid. */
  stale: boolean
  createdAt: number
}
/** One agent-controlled browser tab. The registry lives in the main process; the renderer hosts the webview guests and mirrors this state. */
export interface AgentBrowserTabRecord {
  tabId: string
  /** Canonical session file path of the thread this tab belongs to. */
  sessionFile: string
  url: string
  title: string
  /** Whether a live webview guest is currently bound to this tab. */
  attached: boolean
  /** Whether this is the session's currently targeted tab. */
  active: boolean
  canGoBack: boolean
  canGoForward: boolean
}
export interface AgentBrowserState {
  tabs: AgentBrowserTabRecord[]
}
/** Emitted for every agent browser action, so the UI can surface the Browser panel while the agent works. */
export interface AgentBrowserActivityEvent {
  sessionFile: string
  tabId: string
}
/** Emitted when the agent moves the pointer in a tab, so the UI can animate a synthetic cursor along the same path on the same clock. */
export interface AgentBrowserPointerEvent {
  tabId: string
  sessionFile: string
  /** Previous pointer position, or null when the cursor first appears in a tab. */
  from: { x: number; y: number } | null
  to: { x: number; y: number }
  action: 'move' | 'click' | 'scroll'
  /** How long the glide takes; 0 means the cursor appears in place. */
  durationMs: number
}
