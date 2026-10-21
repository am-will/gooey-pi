import type { CSSProperties, ReactNode } from 'react'
import type { usePanelLayout } from '@/hooks/usePanelLayout'
import { useComposerDockHeight } from '@/hooks/useComposerDockHeight'

/** The conversation and its one companion pane share a responsive workspace. */
export function SessionWorkspace({ layout, childPane, children }: {
  layout: Pick<ReturnType<typeof usePanelLayout>, 'workspaceRowRef' | 'inspectorWidth' | 'terminalHeight'>
  childPane: ReactNode
  children: ReactNode
}) {
  return <div ref={layout.workspaceRowRef} className="session-workspace" style={{ '--inspector-width': `${layout.inspectorWidth}px`, '--terminal-height': `${layout.terminalHeight}px` } as CSSProperties}>
    {children}{childPane}
  </div>
}

/** The dock publishes its own measured clearance when mounted or resized. */
export function ConversationDock({ children }: { children: ReactNode }) {
  const dockRef = useComposerDockHeight()
  return <div ref={dockRef} className="conversation-bottom-dock">{children}</div>
}
