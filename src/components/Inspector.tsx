import { PanelRightClose } from 'lucide-react'
import { useMemo } from 'react'
import type { BrowserAnnotationsApi } from '@/hooks/useBrowserAnnotations'
import type { StampedPointerEvent } from '@/hooks/useAgentBrowserTabs'
import { useSubagents } from '@/hooks/useSubagents'
import type { AgentBrowserTabRecord, AutomationScheduleRecord, GitStatus, InspectorTab, NativeHeartbeatRecord, PrimeWorkApi, ProjectRecord, RuntimeInfo, TranscriptMessage } from '@/types/api'
import type { AgentSlotRect } from './AgentBrowserLayer'
import { BrowserPanel } from './inspector/BrowserPanel'
import { ChangesPanel } from './inspector/ChangesPanel'
import { FilesPanel } from './inspector/FilesPanel'
import { SubagentsPanel } from './inspector/SubagentsPanel'
import { SummaryPanel } from './inspector/SummaryPanel'
import { IconButton, useFocusTrap } from './ui'

interface InspectorProps {
  platform?: NodeJS.Platform
  activeTab: InspectorTab
  onTabChange(tab: InspectorTab): void
  onClose(): void
  /** Active harness agent name ("Prime Agent" / "OMP"). */
  agentName?: string
  /** Short harness name for working copy ("Prime" / "OMP"). */
  shortName?: string
  project?: ProjectRecord
  cwd?: string
  runtime?: RuntimeInfo | null
  messages: TranscriptMessage[]
  git: GitStatus
  automations: AutomationScheduleRecord[]
  heartbeats: NativeHeartbeatRecord[]
  onOpenAutomation(id: string): void
  browserHome: string
  browserAnnotations: BrowserAnnotationsApi
  agentBrowserTabs: AgentBrowserTabRecord[]
  activeAgentTabId: string | null
  agentPreviewSelected: boolean
  onSelectAgentTab(tabId: string): void
  onCloseAgentTab(tabId: string): void
  onShowBrowserPreview(): void
  onAgentSlotRect(rect: AgentSlotRect | null): void
  agentSessionKey?: string
  onPreviewContext(webContentsId: number | null, sessionFile: string | null): void
  previewPointerEvent: StampedPointerEvent | null
  onNavigateAgentTab(tabId: string, action: 'back' | 'forward' | 'reload'): void
  onRefreshGit(): Promise<void> | void
  onOpenExternal(url: string): void
  onRevealPath(path: string): void
  overlay?: boolean
  /** Renderer bridge; the Subagents tab uses it for the roster RPC. */
  bridge?: PrimeWorkApi | null
}

interface InspectorTabDescriptor { id: InspectorTab; label: string }

const BASE_TABS: readonly InspectorTabDescriptor[] = [{ id: 'summary', label: 'Summary' }, { id: 'changes', label: 'Changes' }, { id: 'browser', label: 'Browser' }, { id: 'files', label: 'Files' }]

const SUBAGENTS_TAB: InspectorTabDescriptor = { id: 'subagents', label: 'Subagents' }

/**
 * Tabs the active runtime can actually render.
 *
 * Every other tab is unconditional, so this is the first inspector tab whose
 * presence depends on the harness. A runtime that cannot answer the roster
 * query hides the tab rather than showing an empty one.
 */
export function inspectorTabsFor(runtime?: RuntimeInfo | null): InspectorTabDescriptor[] {
  return runtime?.subagentInspectionSupported === true ? [...BASE_TABS, SUBAGENTS_TAB] : [...BASE_TABS]
}

/**
 * Resolves the tab to render. `defaultInspectorTab` is persisted and may name
 * a capability tab, so a stored 'subagents' has to fall back rather than
 * render a panel the harness cannot feed; switching OMP to pi hits this.
 */
export function resolveInspectorTab(activeTab: InspectorTab, tabs: readonly InspectorTabDescriptor[]): InspectorTab {
  return tabs.some((tab) => tab.id === activeTab) ? activeTab : 'summary'
}

export function Inspector({ activeTab: requestedTab, onTabChange, onClose, agentName, shortName, project, cwd, runtime, messages, git, automations, heartbeats, onOpenAutomation, browserHome, browserAnnotations, agentBrowserTabs, activeAgentTabId, agentPreviewSelected, onSelectAgentTab, onCloseAgentTab, onShowBrowserPreview, onAgentSlotRect, agentSessionKey, onPreviewContext, previewPointerEvent, onNavigateAgentTab, onRefreshGit, onOpenExternal, onRevealPath, overlay = false, platform = 'darwin', bridge = null }: InspectorProps) {
  const inspectorRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const tabs = useMemo(() => inspectorTabsFor(runtime), [runtime])
  const activeTab = resolveInspectorTab(requestedTab, tabs)
  // The subscription follows the visible tab, not the session: a closed panel
  // must cost the harness nothing.
  const subagents = useSubagents({ bridge, runtime: runtime ?? null, active: activeTab === 'subagents' })
  const moveTab = (current: number, key: string) => {
    let next = current
    if (key === 'ArrowRight') next = (current + 1) % tabs.length
    else if (key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length
    else if (key === 'Home') next = 0
    else if (key === 'End') next = tabs.length - 1
    else return
    const tab = tabs[next]
    onTabChange(tab.id)
    requestAnimationFrame(() => document.getElementById(`inspector-tab-${tab.id}`)?.focus())
  }
  return <aside ref={inspectorRef} className="inspector" aria-label="Session inspector" tabIndex={overlay ? -1 : undefined}>
    <div className="inspector__tabs" role="tablist" aria-label="Inspector views">
      {tabs.map((tab, index) => <button id={`inspector-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`inspector-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1} className={activeTab === tab.id ? 'is-active' : ''} key={tab.id} onKeyDown={(event) => { if (['ArrowRight','ArrowLeft','Home','End'].includes(event.key)) { event.preventDefault(); moveTab(index, event.key) } }} onClick={() => onTabChange(tab.id)}>{tab.label}{tab.id === 'changes' && git.files.length ? <span>{git.files.length}</span> : null}</button>)}
      <span className="inspector__tab-spacer"/>
      <IconButton label="Close inspector" onClick={onClose}><PanelRightClose size={15}/></IconButton>
    </div>
    <div id={`inspector-panel-${activeTab}`} className="inspector__body" role="tabpanel" aria-labelledby={`inspector-tab-${activeTab}`} tabIndex={0}>
      {activeTab === 'summary' ? <SummaryPanel agentName={agentName} shortName={shortName} project={project} runtime={runtime} messages={messages} git={git} automations={automations} heartbeats={heartbeats} onOpenAutomation={onOpenAutomation}/> : null}
      {activeTab === 'changes' ? <ChangesPanel key={cwd ?? 'no-workspace'} cwd={cwd} git={git} onRefreshGit={onRefreshGit}/> : null}
      {activeTab === 'browser' ? <BrowserPanel platform={platform} home={browserHome} onOpenExternal={onOpenExternal} annotations={browserAnnotations} agentTabs={agentBrowserTabs} activeAgentTabId={activeAgentTabId} previewSelected={agentPreviewSelected} onSelectAgentTab={onSelectAgentTab} onCloseAgentTab={onCloseAgentTab} onShowPreview={onShowBrowserPreview} onAgentSlotRect={onAgentSlotRect} agentSessionKey={agentSessionKey} onPreviewContext={onPreviewContext} previewPointerEvent={previewPointerEvent} onNavigateAgentTab={onNavigateAgentTab}/> : null}
      {activeTab === 'files' ? <FilesPanel project={project} git={git} onReveal={onRevealPath}/> : null}
      {activeTab === 'subagents' ? <SubagentsPanel shortName={shortName} subagents={subagents.subagents} mode={subagents.mode} error={subagents.error}/> : null}
    </div>
  </aside>
}
