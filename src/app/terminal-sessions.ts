import type { TerminalInitialCommand } from '@/components/TerminalDrawer'

export interface TerminalSessionMount {
  id: string
  workspaceKey: string
  cwd?: string
  sessionPath?: string
  initialCommand?: TerminalInitialCommand
}
