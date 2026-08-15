import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import { canonicalSessionPath } from '../session-paths'
import type { TerminalService } from '../terminal'
import type { AgentBrowserService } from './agent-service'

export interface AgentBrowserBridgeOptions {
  service: AgentBrowserService
  terminals: Pick<TerminalService, 'readActive'>
  extensionPath: string
  skillPath: string
}

export class AgentBrowserBridge extends CapabilityBridge {
  // Browser driving is chattier than scheduling: a single agent turn can
  // issue dozens of read/act/verify calls.
  protected readonly rateLimit = 240
  protected readonly rateLimitError = 'Browser API rate limit exceeded; slow down and retry shortly'

  constructor(private readonly options: AgentBrowserBridgeOptions) { super() }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      PRIME_WORK_BROWSER_URL: url,
      PRIME_WORK_BROWSER_TOKEN: token,
      PRIME_WORK_BROWSER_EXTENSION_PATH: this.options.extensionPath,
      PRIME_WORK_BROWSER_SKILL_PATH: this.options.skillPath,
    }
  }

  /**
   * Runtimes started without --resume only learn their session file at
   * handshake; the manager reports it here so the claim gains its session
   * scope. An existing scope is never overwritten.
   */
  bindSession(token: string | undefined, sessionFile: string | undefined): void {
    if (!token || !sessionFile) return
    const claim = this.claimForToken(token)
    if (claim && !claim.sessionPath) claim.sessionPath = sessionFile
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    if (!claim.sessionPath) throw new Error('Browser control is not available yet for this thread; try again in a moment')
    return this.call(method, params, canonicalSessionPath(claim.sessionPath))
  }

  private call(method: string, params: Record<string, unknown>, sessionKey: string): Promise<unknown> {
    const service = this.options.service
    if (method === 'terminal.read') {
      const active = this.options.terminals.readActive(sessionKey)
      if (!active) throw new Error('No active terminal is open for this task')
      return Promise.resolve(active)
    }
    if (method === 'tabs.list') return service.listTabs(sessionKey)
    if (method === 'tabs.open') return service.openTab(sessionKey, params)
    if (method === 'tabs.close') return service.closeTabScoped(sessionKey, params)
    if (method === 'tabs.select') return service.selectTabScoped(sessionKey, params)
    if (method === 'navigate') return service.navigate(sessionKey, params)
    if (method === 'screenshot') return service.screenshot(sessionKey, params)
    if (method === 'click') return service.click(sessionKey, params)
    if (method === 'type') return service.type(sessionKey, params)
    if (method === 'press_key') return service.pressKey(sessionKey, params)
    if (method === 'scroll') return service.scroll(sessionKey, params)
    if (method === 'read_page') return service.readPage(sessionKey, params)
    if (method === 'evaluate') return service.evaluate(sessionKey, params)
    throw new TypeError(`Unsupported browser method ${method}`)
  }
}
