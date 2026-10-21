import { lazy, Suspense, type ComponentProps, type RefObject } from 'react'
import type { TerminalSessionMount } from '@/app/terminal-sessions'
import { TerminalLoadingPanel } from '@/app/loading'
import type { TerminalDrawer as TerminalDrawerComponent, TerminalDrawerHandle } from './TerminalDrawer'

const TerminalDrawer = lazy(() => import('@/components/TerminalDrawer').then((module) => ({ default: module.TerminalDrawer })))
type DrawerProps = ComponentProps<typeof TerminalDrawerComponent>
interface TerminalDrawerStackProps extends Pick<DrawerProps, 'shell' | 'height' | 'minHeight' | 'maxHeight' | 'defaultHeight' | 'onHeightChange' | 'onError' | 'onOpenLink' | 'onReady' | 'onSelectionChange'> {
  terminals: readonly TerminalSessionMount[]
  activeId?: string
  visible: boolean
  drawerRefs: RefObject<Map<string, TerminalDrawerHandle>>
  onClose(id: string): void
  onInitialCommandConsumed(id: string): void
}

export function TerminalDrawerStack({ terminals, activeId, visible, drawerRefs, onClose, onInitialCommandConsumed, onSelectionChange, ...shared }: TerminalDrawerStackProps) {
  return <>{terminals.map((terminal) => {
    const active = visible && terminal.id === activeId
    return <Suspense key={terminal.id} fallback={active ? <TerminalLoadingPanel /> : null}>
      <TerminalDrawer {...shared}
        ref={(handle) => { if (handle) drawerRefs.current.set(terminal.id, handle); else drawerRefs.current.delete(terminal.id) }}
        visible={active} cwd={terminal.cwd} sessionPath={terminal.sessionPath} initialCommand={terminal.initialCommand}
        onClose={() => onClose(terminal.id)} onInitialCommandConsumed={() => onInitialCommandConsumed(terminal.id)}
        onSelectionChange={(selection) => { if (terminal.id === activeId) onSelectionChange?.(selection) }} />
    </Suspense>
  })}</>
}
