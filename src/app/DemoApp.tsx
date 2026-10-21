import { WorkspaceApp } from '@/App'
import * as demo from '@/lib/demo-workspace'

export default function DemoApp() {
  return <WorkspaceApp bridge={null} demo={demo} />
}
