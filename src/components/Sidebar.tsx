import {
  Archive,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  Copy,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  ListFilter,
  LoaderCircle,
  MessageCircleQuestion,
  NotebookPen,
  PackageOpen,
  PanelLeftClose,
  Pin,
  MoreHorizontal,
  Search,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import { PROJECT_SORT_MODES, type AppMeta, type AppUpdateState, type HarnessId, type ProjectRecord, type ProjectSortMode, type SessionRecord, type WorkspaceView } from '@/types/api'
import { writeClipboardText } from '@/lib/clipboard'
import { formatRelative } from '@/lib/data'
import { HARNESS_PRODUCT_NAMES, HARNESS_SELECTOR_ORDER, HARNESS_SHORT_NAMES } from '@/lib/harness'
import { sortProjects } from '@/lib/project-order'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { sessionTitleText } from '@/lib/session-title'
import { sessionAttentionSignature, signatureCleared } from '@/app/session-attention'
import { IconButton, Modal, OmpMark, PiMark, PrimeMark, useFocusTrap } from './ui'

const PROJECT_SORT_LABEL_KEYS = { recent: 'projects.sort.recent', alphabetical: 'projects.sort.alphabetical' } as const satisfies Record<ProjectSortMode, MessageKey>

export interface SidebarProps {
  projects: ProjectRecord[]
  sessions: SessionRecord[]
  activeProjectId?: string
  activeSessionId?: string
  activeView: WorkspaceView
  activeHarness?: HarnessId
  harnesses?: AppMeta['harnesses'] | null
  clearedAttention?: Record<string, string>
  updateState?: AppUpdateState
  onUpdateAction?(): void | Promise<void>
  onSelectHarness?(harness: HarnessId): void
  onSelectProject(project: ProjectRecord): void
  onSelectSession(session: SessionRecord): void
  onNavigate(view: WorkspaceView): void
  onNewSession(project?: ProjectRecord): void
  onAddProject(): void
  onRemoveProject(project: ProjectRecord): void
  projectSortMode?: ProjectSortMode
  onSetProjectSortMode?(mode: ProjectSortMode): void
  onTogglePinProject?(project: ProjectRecord): void
  onClose(): void
  onOpenPalette(): void
  onRenameSession(session: SessionRecord, title: string): Promise<void>
  onArchiveSession(session: SessionRecord): Promise<void>
  overlay?: boolean
  platform?: NodeJS.Platform
}

const STATUS_LABEL_KEYS = {
  idle: 'sidebar.status.idle', running: 'sidebar.status.running', waiting: 'sidebar.status.waiting', complete: 'sidebar.status.complete', failed: 'sidebar.status.failed', unknown: 'sidebar.status.unknown',
} as const satisfies Record<SessionRecord['status'], MessageKey>

/** Translator shape for module-level copy helpers that run per render. */
type Translate = ReturnType<typeof useI18n>['t']

export const SIDEBAR_SESSION_LIMIT = 7

export interface SidebarIndexStats {
  projectPaths: number
  sessionScans: number
}

export function indexSidebarSessions(
  projects: ProjectRecord[],
  sessions: SessionRecord[],
  stats?: SidebarIndexStats,
): { activeSessions: SessionRecord[]; sessionsByProject: Map<string, SessionRecord[]> } {
  const activeSessions: SessionRecord[] = []
  const owners = new Map<string, string[]>()
  const sessionsByProject = new Map(projects.map((project) => [project.id, [] as SessionRecord[]]))
  for (const project of projects) for (const path of new Set([project.path, ...project.folders])) {
    if (stats) stats.projectPaths += 1
    const entries = owners.get(path) ?? []
    entries.push(project.id)
    owners.set(path, entries)
  }
  for (const session of sessions) {
    if (stats) stats.sessionScans += 1
    if (session.archived) continue
    activeSessions.push(session)
    for (const projectId of owners.get(session.projectPath) ?? []) sessionsByProject.get(projectId)?.push(session)
  }
  const compareByLastUserMessage = (left: SessionRecord, right: SessionRecord) => {
    const difference = Date.parse(right.lastUserMessageAt ?? right.createdAt) - Date.parse(left.lastUserMessageAt ?? left.createdAt)
    return difference || right.createdAt.localeCompare(left.createdAt) || left.filePath.localeCompare(right.filePath)
  }
  activeSessions.sort(compareByLastUserMessage)
  for (const projectSessions of sessionsByProject.values()) projectSessions.sort(compareByLastUserMessage)
  return { activeSessions, sessionsByProject }
}

export function boundedSidebarSessions(sessions: SessionRecord[]): SessionRecord[] {
  return sessions.slice(0, SIDEBAR_SESSION_LIMIT)
}


function SessionStatusMark({ status, attention }: { status: SessionRecord['status']; attention: boolean }) {
  const { t } = useI18n()
  const label = t(STATUS_LABEL_KEYS[status])
  const title = status === 'failed' && !attention ? t('sidebar.status.failedCleared') : label
  if (status === 'running') return <span className="session-status-mark session-status-mark--running" title={label}><LoaderCircle className="spin" size={13} /></span>
  if (status === 'waiting') return <span className="session-status-mark session-status-mark--waiting" title={label}><MessageCircleQuestion size={12} /></span>
  if (status === 'complete') return <span className="session-status-mark session-status-mark--complete" title={label}><CheckCircle2 size={12} /></span>
  return <span className={`session-status-mark session-status-mark--${status}`} title={title}><span /></span>
}

const HARNESS_MARKS: Record<HarnessId, (props: { size?: number }) => ReactElement> = { omp: OmpMark, prime: PrimeMark, pi: PiMark }

function HarnessMark({ harness, size }: { harness: HarnessId; size: number }) {
  const Mark = HARNESS_MARKS[harness]
  return <Mark size={size} />
}

function updateControlCopy(state: AppUpdateState, t: Translate): { label: string; title: string } {
  // `version` keeps its own leading space so both the "Download 1.2.3" and the
  // bare "Download" forms stay byte-identical to the pre-i18n copy.
  const version = state.version ? ` ${state.version}` : ''
  switch (state.phase) {
    case 'checking': return { label: t('update.checking'), title: t('update.checkingTitle') }
    case 'available': return { label: t('update.download', { version }), title: t('update.downloadTitle', { version }) }
    case 'downloading': return {
      label: state.percent === undefined ? t('update.downloading', { version }) : t('update.downloadingWithPercent', { version, percent: state.percent }),
      title: t('update.downloadingTitle', { version }),
    }
    case 'downloaded': return { label: t('update.restart', { version }), title: t('update.restartTitle', { version }) }
    case 'not-available': return { label: t('update.upToDate'), title: t('update.upToDateTitle') }
    case 'error': return { label: version ? t('update.retryVersion', { version }) : t('update.retry'), title: state.message ?? t('update.failedTitle') }
    case 'unsupported': return { label: t('update.automatic'), title: state.message ?? t('update.automaticTitle') }
    default: return { label: t('update.release'), title: t('update.releaseTitle') }
  }
}

/** Announced without the percentage so progress ticks do not spam assistive tech. */
function updateAnnouncement(state: AppUpdateState, t: Translate): string {
  const version = state.version ? ` ${state.version}` : ''
  switch (state.phase) {
    case 'available': return t('update.announceAvailable', { version })
    case 'downloading': return t('update.announceDownloading', { version })
    case 'downloaded': return t('update.announceReady', { version })
    case 'error': return t('update.announceFailed', { message: state.message ?? t('update.tryAgain') })
    default: return ''
  }
}

function updateConfirmCopy(state: AppUpdateState, t: Translate): { title: string; body: string } {
  if (state.phase === 'downloaded') return {
    title: t('update.confirmRestartTitle'),
    body: t('update.confirmRestartBody'),
  }
  return {
    title: t('update.confirmDownloadTitle'),
    body: t('update.confirmDownloadBody'),
  }
}

function SidebarView({ projects, sessions, activeProjectId, activeSessionId, activeView, activeHarness = 'omp', harnesses, clearedAttention = {}, updateState = { phase: 'unsupported' }, onUpdateAction, onSelectHarness, onSelectProject, onSelectSession, onNavigate, onNewSession, onAddProject, onRemoveProject, projectSortMode = 'recent', onSetProjectSortMode = () => undefined, onTogglePinProject = () => undefined, onClose, onOpenPalette, onRenameSession, onArchiveSession, overlay = false, platform = 'darwin' }: SidebarProps) {
  const { t } = useI18n()
  // Session titles are record data; only the main-process placeholder is
  // presented in the interface language (see `src/lib/session-title.ts`).
  const displayTitle = (title: string): string => sessionTitleText(title, t)
  const [query, setQuery] = useState('')
  const [harnessMenuOpen, setHarnessMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [sessionLimits, setSessionLimits] = useState<Record<string, number>>({})
  const [searchOpen, setSearchOpen] = useState(false)
  const sidebarRef = useFocusTrap<HTMLElement>(overlay, onClose)
  const [projectMenu, setProjectMenu] = useState<string | null>(null)
  const [projectSortMenuOpen, setProjectSortMenuOpen] = useState(false)
  const [sessionMenu, setSessionMenu] = useState<string | null>(null)
  const [sessionMenuStyle, setSessionMenuStyle] = useState<CSSProperties>({})
  const openSessionMenu = (id: string, anchor: HTMLElement) => {
    const bounds = anchor.getBoundingClientRect()
    setSessionMenuStyle({ position: 'fixed', top: Math.max(8, Math.min(bounds.bottom + 3, window.innerHeight - 80)), left: Math.max(8, Math.min(bounds.right - 132, window.innerWidth - 140)), right: 'auto' })
    setSessionMenu((current) => current === id ? null : id)
  }
  const [renameTarget, setRenameTarget] = useState<SessionRecord | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [archiveRunningTarget, setArchiveRunningTarget] = useState<SessionRecord | null>(null)
  const [removeTarget, setRemoveTarget] = useState<ProjectRecord | null>(null)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const { activeSessions, sessionsByProject } = useMemo(() => indexSidebarSessions(projects, sessions), [projects, sessions])
  const needsAttention = (session: SessionRecord) => {
    const signature = sessionAttentionSignature(session)
    return Boolean(signature && !signatureCleared(signature, clearedAttention[session.id], session.unread))
  }
  const unreadCount = activeSessions.reduce((count, session) => count + Number(needsAttention(session)), 0)
  const newSessionShortcut = shortcutLabel(platform, ['Primary', 'N'])
  const sidebarShortcut = shortcutLabel(platform, ['Primary', 'B'])
  const commandsShortcut = shortcutLabel(platform, ['Primary', 'K'])
  const settingsShortcut = shortcutLabel(platform, ['Primary', ','])
  const updateCopy = updateControlCopy(updateState, t)
  const updateConfirm = updateConfirmCopy(updateState, t)
  const updateBusy = updateState.phase === 'checking' || updateState.phase === 'downloading'
  const updateIndeterminate = updateState.phase === 'downloading' && updateState.percent === undefined
  const updateVisible = updateState.phase === 'available' || updateState.phase === 'downloading' || updateState.phase === 'downloaded' || updateState.phase === 'error'
  useEffect(() => {
    if (!harnessMenuOpen) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.brand-switcher')) setHarnessMenuOpen(false) }
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setHarnessMenuOpen(false) } }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', dismissOnEscape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismissOnEscape, true) }
  }, [harnessMenuOpen])
  useEffect(() => {
    if (!projectMenu) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.project-group')) setProjectMenu(null) }
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setProjectMenu(null) } }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', dismissOnEscape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismissOnEscape, true) }
  }, [projectMenu])
  useEffect(() => {
    if (!projectSortMenuOpen) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.sidebar__sort-menu, .sidebar__sort-toggle')) setProjectSortMenuOpen(false) }
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setProjectSortMenuOpen(false) } }
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', dismissOnEscape, true)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismissOnEscape, true) }
  }, [projectSortMenuOpen])
  useEffect(() => {
    if (!sessionMenu) return
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.session-row-wrap')) setSessionMenu(null) }
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setSessionMenu(null) } }
    const dismissOnMove = () => setSessionMenu(null)
    document.addEventListener('pointerdown', dismiss, true); document.addEventListener('keydown', dismissOnEscape, true)
    document.addEventListener('scroll', dismissOnMove, true); window.addEventListener('resize', dismissOnMove)
    return () => { document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismissOnEscape, true); document.removeEventListener('scroll', dismissOnMove, true); window.removeEventListener('resize', dismissOnMove) }
  }, [sessionMenu])
  // Archiving stops a live agent, so running work confirms first. Idle chats
  // archive on a single click because Settings can restore them again.
  const archiveSession = (session: SessionRecord) => {
    if (session.status === 'running' || session.status === 'waiting') setArchiveRunningTarget(session)
    else void onArchiveSession(session)
  }
  const normalized = query.trim().toLowerCase()
  const allCollapsed = projects.length > 0 && projects.every((project) => collapsed[project.id] === true)
  const visibleProjects = useMemo(() => sortProjects(projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized) || (sessionsByProject.get(project.id) ?? []).some((session) => `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized))), projectSortMode), [projects, sessionsByProject, normalized, projectSortMode])

  return (
    <aside ref={sidebarRef} className="sidebar" aria-label={t('sidebar.navigationLabel')} tabIndex={overlay ? -1 : undefined}>
      <div className="sidebar__titlebar drag-region">
        <div className="traffic-light-clearance" aria-hidden="true" />
        <div className="sidebar__brand brand-switcher no-drag">
          <button
            type="button"
            className="brand-switcher__trigger"
            aria-haspopup="menu"
            aria-expanded={harnessMenuOpen}
            aria-label={t('sidebar.harnessSwitcher', { name: HARNESS_PRODUCT_NAMES[activeHarness] })}
            title={t('sidebar.harnessSwitcher', { name: HARNESS_PRODUCT_NAMES[activeHarness] })}
            onClick={() => setHarnessMenuOpen((open) => !open)}
          >
            <HarnessMark harness={activeHarness} size={24} />
            <span className="brand-switcher__name"><strong>{HARNESS_SHORT_NAMES[activeHarness]}</strong><small>{t('sidebar.work')}</small></span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {harnessMenuOpen ? (
            <div className="brand-switcher__menu" role="menu" aria-label={t('sidebar.harnessMenu')}>
              {HARNESS_SELECTOR_ORDER.filter((harness) => Boolean(harnesses?.[harness]?.path)).map((harness) => (
                  <button
                    type="button"
                    key={harness}
                    role="menuitemradio"
                    aria-checked={harness === activeHarness}
                    className={harness === activeHarness ? 'is-active' : ''}
                    onClick={() => { setHarnessMenuOpen(false); if (harness !== activeHarness) onSelectHarness?.(harness) }}
                  >
                    <HarnessMark harness={harness} size={20} />
                    <span className="brand-switcher__option"><strong>{HARNESS_PRODUCT_NAMES[harness]}</strong></span>
                    {harness === activeHarness ? <Check size={13} aria-hidden="true" /> : null}
                  </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="sidebar__title-actions no-drag">
          <IconButton label={t('nav.newSessionShortcut', { shortcut: newSessionShortcut })} onClick={() => onNewSession()}><NotebookPen size={16} /></IconButton>
          <IconButton label={t('nav.hideSidebarShortcut', { shortcut: sidebarShortcut })} onClick={onClose}><PanelLeftClose size={16} /></IconButton>
        </div>
      </div>

      <nav className="sidebar__primary" aria-label={t('nav.primary')}>
        <button type="button" title={t('nav.newSessionShortcut', { shortcut: newSessionShortcut })} onClick={() => onNewSession()}><NotebookPen size={15} /><span>{t('nav.newSession')}</span><kbd>{newSessionShortcut}</kbd></button>
        <button type="button" title={t('common.search')} onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => document.getElementById('session-search')?.focus(), 0) }} className={searchOpen ? 'is-active' : ''}><Search size={15} /><span>{t('common.search')}</span></button>
        {searchOpen ? (
          <div className="sidebar-search">
            <Search size={13} />
            <input id="session-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('sidebar.searchPlaceholder')} aria-label={t('sidebar.searchAria')} />
            {query ? <button type="button" title={t('sidebar.clearSearch')} aria-label={t('sidebar.clearSearch')} onClick={() => setQuery('')}>×</button> : null}
          </div>
        ) : null}
        <button type="button" title={t('nav.projects')} className={activeView === 'projects' ? 'is-active' : ''} onClick={() => onNavigate('projects')}><Folder size={15} /><span>{t('nav.projects')}</span></button>
        <button type="button" title={t('nav.activity')} className={activeView === 'activity' ? 'is-active' : ''} onClick={() => onNavigate('activity')}><Bell size={15} /><span>{t('nav.activity')}</span>{unreadCount ? <span className="nav-count">{unreadCount}</span> : null}</button>
        <button type="button" title={t('nav.scheduled')} className={activeView === 'scheduled' ? 'is-active' : ''} onClick={() => onNavigate('scheduled')}><CalendarClock size={15} /><span>{t('nav.scheduled')}</span></button>
        <button type="button" title={t('nav.capabilities')} className={activeView === 'plugins' ? 'is-active' : ''} onClick={() => onNavigate('plugins')}><PackageOpen size={15} /><span>{t('nav.capabilities')}</span></button>
      </nav>

      <div className="sidebar__scroll scroll-area">
        <div className="sidebar__section-heading"><span>{t('nav.projects')}</span><span className="sidebar__section-heading-actions"><IconButton size="small" label={t(allCollapsed ? 'projects.expandAll' : 'projects.collapseAll')} disabled={Boolean(normalized) || projects.length === 0} onClick={() => { setProjectMenu(null); setSessionMenu(null); setCollapsed(Object.fromEntries(projects.map((project) => [project.id, !allCollapsed]))) }}>{allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}</IconButton><IconButton size="small" className="sidebar__sort-toggle" aria-haspopup="menu" aria-expanded={projectSortMenuOpen} label={t('projects.sort')} onClick={() => setProjectSortMenuOpen((open) => !open)}><ListFilter size={13} /></IconButton><IconButton size="small" label={t('nav.addProject')} onClick={onAddProject}><FolderPlus size={13} /></IconButton>{projectSortMenuOpen ? <div className="sidebar__sort-menu" role="menu" aria-label={t('projects.sort.menu')}>{PROJECT_SORT_MODES.map((mode) => <button key={mode} type="button" role="menuitemradio" aria-checked={projectSortMode === mode} className={projectSortMode === mode ? 'is-active' : ''} onClick={() => { setProjectSortMenuOpen(false); onSetProjectSortMode(mode) }}>{t(PROJECT_SORT_LABEL_KEYS[mode])}{projectSortMode === mode ? <Check size={12} aria-hidden="true" /> : null}</button>)}</div> : null}</span></div>
        {visibleProjects.length === 0 ? <p className="sidebar__empty">{t('sidebar.noMatchingWork')}</p> : null}
        {visibleProjects.map((project) => {
          const projectSessions = (sessionsByProject.get(project.id) ?? []).filter((session) => !normalized || `${session.title} ${session.preview ?? ''}`.toLowerCase().includes(normalized) || project.name.toLowerCase().includes(normalized))
          const isCollapsed = !normalized && (collapsed[project.id] ?? false)
          const sessionLimit = sessionLimits[project.id] ?? SIDEBAR_SESSION_LIMIT
          const running = projectSessions.some((session) => session.status === 'running')
          return (
            <div className="project-group" key={project.id}>
              <div
                className={`project-row ${activeProjectId === project.id && activeView === 'session' ? 'is-selected' : ''}`}
                onContextMenu={(event) => { event.preventDefault(); setProjectMenu(project.id) }}
              >
                <button className="project-row__collapse" type="button" aria-expanded={!isCollapsed} disabled={Boolean(normalized)} aria-label={t(isCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { name: project.name })} title={t(isCollapsed ? 'sidebar.expandProject' : 'sidebar.collapseProject', { name: project.name })} onClick={() => { setProjectMenu(null); setCollapsed((value) => ({ ...value, [project.id]: !isCollapsed })) }}>
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
                <button className="project-row__main" type="button" onClick={() => { setProjectMenu(null); onSelectProject(project) }} title={project.path}>
                  {activeProjectId === project.id ? <FolderOpen size={14} /> : <Folder size={14} />}
                  <span>{project.name}</span>
                  {project.pinned ? <Pin className="project-row__pin" size={11} fill="currentColor" /> : null}
                </button>
                <IconButton size="small" className="project-row__new-session row-action" label={t('nav.newSessionIn', { name: project.name })} onClick={() => { setProjectMenu(null); onNewSession(project) }}><NotebookPen size={13} /></IconButton>
                {running ? <span className="project-working" title={t('sidebar.agentWorking')}><LoaderCircle className="spin" size={13} /></span> : null}
                {projectMenu === project.id ? <div className="project-row__menu" role="menu" aria-label={t('sidebar.projectOptions', { name: project.name })}>{!project.inferred ? <button type="button" role="menuitem" onClick={() => { setProjectMenu(null); onTogglePinProject(project) }}><Pin size={12} /> {t(project.pinned ? 'projects.unpin' : 'projects.pin')}</button> : null}<button type="button" role="menuitem" onClick={() => { setProjectMenu(null); setRemoveTarget(project) }}><Trash2 size={12} /> {t('sidebar.removeProject')}</button></div> : null}
              </div>
              {!isCollapsed ? (
                <div className="session-list">
                  {projectSessions.slice(0, sessionLimit).map((session) => (
                    <div key={session.id} className={`session-row-wrap session-row-wrap--${session.status} ${needsAttention(session) ? 'has-attention' : ''} ${activeSessionId === session.id && activeView === 'session' ? 'is-selected' : ''}`}>
                      <button type="button" title={displayTitle(session.title)} className="session-row" onClick={() => { setSessionMenu(null); onSelectSession(session) }} onContextMenu={(event) => { event.preventDefault(); openSessionMenu(session.id, event.currentTarget) }}>
                        <SessionStatusMark status={session.status} attention={needsAttention(session)} />
                        <span className="session-row__text"><span className="session-row__title">{displayTitle(session.title)}</span><span className="session-row__meta">{session.status === 'running' ? t('sidebar.sessionMeta.working') : session.status === 'waiting' ? t('sidebar.sessionMeta.attention') : session.status === 'complete' ? t('sidebar.status.complete') : formatRelative(session.updatedAt)}</span></span>
                      </button>
                      <IconButton
                        size="small"
                        className="session-row__archive"
                        label={t('sidebar.archiveSession', { title: displayTitle(session.title) })}
                        onClick={() => { setSessionMenu(null); archiveSession(session) }}
                      ><Archive size={13}/></IconButton>
                      <IconButton size="small" className="session-row__more" label={t('sidebar.sessionOptionsFor', { title: displayTitle(session.title) })} onClick={(event) => openSessionMenu(session.id, event.currentTarget)}><MoreHorizontal size={13}/></IconButton>
                      {sessionMenu === session.id ? <div className="session-row__menu" style={sessionMenuStyle} aria-label={t('sidebar.sessionOptions')}><button type="button" onClick={() => { void writeClipboardText(session.id); setSessionMenu(null) }}><Copy size={12}/> {t('sidebar.copySessionUuid')}</button><button type="button" onClick={() => { setRenameTarget(session); setRenameValue(session.title); setSessionMenu(null) }}><SquarePen size={12}/> {t('common.rename')}</button></div> : null}
                    </div>
                  ))}
                  {projectSessions.length > sessionLimit ? <button type="button" className="session-row session-row--empty" onClick={() => setSessionLimits((limits) => ({ ...limits, [project.id]: sessionLimit + SIDEBAR_SESSION_LIMIT }))}>{t('sidebar.moreSessions', { count: projectSessions.length - sessionLimit })}</button> : null}
                  {sessionLimit > SIDEBAR_SESSION_LIMIT ? <button type="button" className="session-row session-row--empty" onClick={() => { setSessionMenu(null); setSessionLimits((limits) => ({ ...limits, [project.id]: SIDEBAR_SESSION_LIMIT })) }}>{t('sidebar.showLess')}</button> : null}
                  {projectSessions.length === 0 ? <button type="button" title={`New session in ${project.name}`} className="session-row session-row--empty" onClick={() => { setProjectMenu(null); onNewSession(project) }}><NotebookPen size={12} /> New session</button> : null}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button type="button" title={t('nav.commands')} onClick={onOpenPalette}><Search size={15} /><span>{t('nav.commands')}</span><kbd>{commandsShortcut}</kbd></button>
        {updateVisible ? (
          <>
            <span className="sr-only" role="status" aria-live="polite">{updateAnnouncement(updateState, t)}</span>
            <button
              type="button"
              className={`sidebar-update sidebar-update--${updateState.phase} ${updateIndeterminate ? 'sidebar-update--indeterminate' : ''}`}
              title={updateCopy.title}
              aria-label={updateCopy.title}
              disabled={updateBusy}
              onClick={() => { if (updateState.phase === 'error') void onUpdateAction?.(); else setConfirmUpdate(true) }}
            >
              <span className="sidebar-update__icon" style={{ '--update-progress': `${updateState.percent ?? 0}%` } as CSSProperties}><Download size={12} /></span>
              <span>{updateCopy.label}</span>
            </button>
          </>
        ) : null}
        <button type="button" title={t('nav.settings')} className={activeView === 'settings' ? 'is-active' : ''} onClick={() => onNavigate('settings')}><Settings size={15} /><span>{t('nav.settings')}</span><kbd>{settingsShortcut}</kbd></button>
      </div>
      {renameTarget ? <Modal title="Rename session" onClose={() => setRenameTarget(null)} footer={<><button type="button" className="button" onClick={() => setRenameTarget(null)}>Cancel</button><button type="button" className="button button--primary" disabled={!renameValue.trim()} onClick={() => { const target = renameTarget; const title = renameValue.trim(); setRenameTarget(null); void onRenameSession(target, title) }}>Rename</button></>}><label className="field"><span>Session name</span><input autoFocus value={renameValue} maxLength={200} onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && renameValue.trim()) { event.preventDefault(); const target = renameTarget; const title = renameValue.trim(); setRenameTarget(null); void onRenameSession(target, title) } }}/></label></Modal> : null}
      {removeTarget ? <Modal title="Remove project" onClose={() => setRemoveTarget(null)} footer={<><button type="button" className="button" onClick={() => setRemoveTarget(null)}>Cancel</button><button type="button" className="button button--danger" onClick={() => { const target = removeTarget; setRemoveTarget(null); onRemoveProject(target) }}>Remove</button></>}><p>Remove “{removeTarget.name}” from {HARNESS_PRODUCT_NAMES[activeHarness]}? The folder and saved sessions will not be deleted.</p></Modal> : null}
      {archiveRunningTarget ? <Modal title={t('archive.running.title')} onClose={() => setArchiveRunningTarget(null)} footer={<><button type="button" className="button" onClick={() => setArchiveRunningTarget(null)}>{t('common.cancel')}</button><button type="button" className="button button--danger" onClick={() => { const target = archiveRunningTarget; setArchiveRunningTarget(null); void onArchiveSession(target) }}>{t('archive.running.confirm')}</button></>}><p>{t('archive.running.body', { title: archiveRunningTarget.title })}</p></Modal> : null}
      {confirmUpdate ? <Modal title={updateConfirm.title} onClose={() => setConfirmUpdate(false)} footer={<><button type="button" className="button" onClick={() => setConfirmUpdate(false)}>No</button><button type="button" className="button button--primary" onClick={() => { setConfirmUpdate(false); void onUpdateAction?.() }}>Yes</button></>}><p>{updateConfirm.body}</p></Modal> : null}
    </aside>
  )
}

export function areSidebarPropsEqual(previous: SidebarProps, next: SidebarProps): boolean {
  return previous.projects === next.projects
    && previous.sessions === next.sessions
    && previous.activeProjectId === next.activeProjectId
    && previous.activeSessionId === next.activeSessionId
    && previous.activeView === next.activeView
    && previous.activeHarness === next.activeHarness
    && previous.harnesses === next.harnesses
    && previous.clearedAttention === next.clearedAttention
    && previous.updateState === next.updateState
    && previous.onUpdateAction === next.onUpdateAction
    && previous.onSelectHarness === next.onSelectHarness
    && previous.onSelectProject === next.onSelectProject
    && previous.onSelectSession === next.onSelectSession
    && previous.onNavigate === next.onNavigate
    && previous.onNewSession === next.onNewSession
    && previous.onAddProject === next.onAddProject
    && previous.onRemoveProject === next.onRemoveProject
    && previous.projectSortMode === next.projectSortMode
    && previous.onSetProjectSortMode === next.onSetProjectSortMode
    && previous.onTogglePinProject === next.onTogglePinProject
    && previous.onClose === next.onClose
    && previous.onOpenPalette === next.onOpenPalette
    && previous.onRenameSession === next.onRenameSession
    && previous.onArchiveSession === next.onArchiveSession
    && previous.overlay === next.overlay
    && previous.platform === next.platform
}

export const Sidebar = memo(SidebarView, areSidebarPropsEqual)
