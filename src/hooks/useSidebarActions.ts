import { useRef } from 'react'
import type { SidebarProps } from '@/components/Sidebar'

type SidebarActions = Pick<SidebarProps,
  | 'onSelectProject'
  | 'onSelectSession'
  | 'onNavigate'
  | 'onNewSession'
  | 'onAddProject'
  | 'onRemoveProject'
  | 'onSetProjectSortMode'
  | 'onTogglePinProject'
  | 'onClose'
  | 'onOpenPalette'
  | 'onRenameSession'
  | 'onArchiveSession'
>

export interface SidebarActionProxy {
  readonly callbacks: SidebarActions
  update(actions: SidebarActions): void
}

/** Stable callback identities which always dispatch to the latest App render. */
export function createSidebarActionProxy(initialActions: SidebarActions): SidebarActionProxy {
  let current = initialActions
  return {
    callbacks: {
      onSelectProject: (project) => current.onSelectProject(project),
      onSelectSession: (session) => current.onSelectSession(session),
      onNavigate: (view) => current.onNavigate(view),
      onNewSession: (project) => current.onNewSession(project),
      onAddProject: () => current.onAddProject(),
      onRemoveProject: (project) => current.onRemoveProject(project),
      onSetProjectSortMode: (mode) => current.onSetProjectSortMode?.(mode),
      onTogglePinProject: (project) => current.onTogglePinProject?.(project),
      onClose: () => current.onClose(),
      onOpenPalette: () => current.onOpenPalette(),
      onRenameSession: (session, title) => current.onRenameSession(session, title),
      onArchiveSession: (session) => current.onArchiveSession(session),
    },
    update(actions) { current = actions },
  }
}

export function useSidebarActions(actions: SidebarActions): SidebarActions {
  const proxyRef = useRef<SidebarActionProxy | null>(null)
  if (proxyRef.current === null) proxyRef.current = createSidebarActionProxy(actions)
  else proxyRef.current.update(actions)
  return proxyRef.current.callbacks
}
