import {
  AudioWaveform,
  GitBranch,
  PanelLeft,
  PanelRight,
  Terminal,
} from 'lucide-react'
import type { ApplicationMenuName, ProjectRecord, WorkspaceView } from '@/types/api'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { BrowserGlobe, IconButton } from './ui'
import { ProjectRunControl, type ProjectScriptKind } from './ProjectRunControl'
import type { MouseEvent } from 'react'

const viewTitles: Record<Exclude<WorkspaceView, 'session'>, MessageKey> = {
  projects: 'nav.projects', activity: 'nav.activity', scheduled: 'nav.scheduled', plugins: 'nav.capabilities', settings: 'nav.settings',
}

const windowsMenus: ReadonlyArray<{ name: ApplicationMenuName; label: string }> = [
  { name: 'file', label: 'File' },
  { name: 'edit', label: 'Edit' },
  { name: 'view', label: 'View' },
  { name: 'window', label: 'Window' },
  { name: 'help', label: 'Help' },
]

function openApplicationMenu(menu: ApplicationMenuName, event: MouseEvent<HTMLButtonElement>): void {
  const rect = event.currentTarget.getBoundingClientRect()
  void window.prime?.app.popupMenu?.(menu, rect.left, rect.bottom).catch(() => undefined)
}

interface TitleToolbarProps {
  project?: ProjectRecord
  gitBranch?: string
  view: WorkspaceView
  /** Active harness product name; the session view's fallback title. */
  productName?: string
  sidebarOpen: boolean
  inspectorOpen: boolean
  terminalOpen: boolean
  onToggleSidebar(): void
  onToggleInspector(): void
  onToggleTerminal(): void
  onOpenBrowser(): void
  voiceOpen?: boolean
  onToggleVoice?(): void
  activeProjectScriptKind?: ProjectScriptKind
  onRunProjectScript?(kind: ProjectScriptKind): Promise<void> | void
  onStopProjectScript?(): void
  onSaveProjectScripts?(scripts: { setup: string; run: string }): Promise<void>
  platform?: NodeJS.Platform
}

export function TitleToolbar({ project, gitBranch, view, productName = 'Prime Work', sidebarOpen, inspectorOpen, terminalOpen, voiceOpen = false, activeProjectScriptKind, onToggleSidebar, onToggleInspector, onToggleTerminal, onOpenBrowser, onToggleVoice, onRunProjectScript, onStopProjectScript, onSaveProjectScripts, platform = 'darwin' }: TitleToolbarProps) {
  const { t } = useI18n()
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  const terminalShortcut = shortcutLabel(platform, ['Primary', 'J'])
  const browserShortcut = shortcutLabel(platform, ['Primary', 'Shift', 'B'])
  return (
    <header className="title-toolbar drag-region">
      {!sidebarOpen && platform === 'darwin' ? <div className="traffic-light-clearance traffic-light-clearance--toolbar" aria-hidden="true" /> : null}
      {platform === 'win32' ? <nav className="windows-app-menu" aria-label="Application menu">
        {windowsMenus.map(({ name, label }) => <button key={name} type="button" className="windows-app-menu__button" onClick={(event) => openApplicationMenu(name, event)}>{label}</button>)}
      </nav> : null}
      <div className="title-toolbar__nav no-drag">
        {!sidebarOpen ? <IconButton label={`Show sidebar (${sidebarShortcut})`} onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
      </div>
      <div className="title-toolbar__identity">
        <strong>{project?.name ?? (view === 'session' ? productName : t(viewTitles[view]))}</strong>
        {(gitBranch ?? project?.gitBranch) && view === 'session' ? <span className="branch-pill"><GitBranch size={12} />{gitBranch ?? project?.gitBranch}</span> : null}
      </div>
      <div className="title-toolbar__actions no-drag">
        {view === 'session' && project && onRunProjectScript && onStopProjectScript && onSaveProjectScripts
          ? <ProjectRunControl project={project} activeKind={activeProjectScriptKind} onRun={onRunProjectScript} onStop={onStopProjectScript} onSave={onSaveProjectScripts} />
          : null}
        {view === 'session' && onToggleVoice ? <IconButton className={voiceOpen ? 'is-active voice-toggle--active' : ''} label={voiceOpen ? 'Close realtime voice' : 'Open realtime voice'} onClick={onToggleVoice}><AudioWaveform size={17} /></IconButton> : null}
        {view === 'session' ? <IconButton className={terminalOpen ? 'is-active' : ''} label={`Toggle terminal (${terminalShortcut})`} onClick={onToggleTerminal}><Terminal size={17} /></IconButton> : null}
        {view === 'session' ? <IconButton label={`Open browser (${browserShortcut})`} onClick={onOpenBrowser}><BrowserGlobe size={18} /></IconButton> : null}
        {view === 'session' ? <IconButton className={inspectorOpen ? 'is-active' : ''} label="Toggle inspector" onClick={onToggleInspector}><PanelRight size={16} /></IconButton> : null}
        {view !== 'session' && sidebarOpen ? <IconButton label={`Hide sidebar (${sidebarShortcut})`} onClick={onToggleSidebar}><PanelLeft size={16} /></IconButton> : null}
      </div>
    </header>
  )
}
