// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RUST_PRIME_HEARTBEAT_PAUSE_DETAIL } from '../../src/lib/prime-compat'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import type { NativeHeartbeatRecord, PrimeImplementation } from '../../src/types/api'

const heartbeat = (id: string, status: NativeHeartbeatRecord['status']): NativeHeartbeatRecord => ({
  id, source: 'heartbeat', status, prompt: `check ${id}`, schedule: '*/5 * * * *',
  sessionId: `session-${id}`, sessionFile: `/sessions/${id}.jsonl`, activeSessionId: `active-${id}`,
})
const HEARTBEATS = [heartbeat('active-job', 'active'), heartbeat('paused-job', 'paused')]
const noop = async () => undefined

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function renderPage(primeImplementation: PrimeImplementation | undefined) {
  const onManageHeartbeat = vi.fn(async () => undefined)
  await act(async () => {
    root.render(<ScheduledPage
      harness="prime" primeImplementation={primeImplementation} schedules={[]} nativeHeartbeats={HEARTBEATS} projects={[]} sessions={[]} models={[]} lastSelectedModel=""
      onCreate={noop} onUpdate={noop} onPause={noop} onResume={noop} onDelete={noop} onRunNow={noop}
      onPreview={async (timing) => ({ timing, occurrences: [] })} onOpenSession={() => undefined} onManageHeartbeat={onManageHeartbeat}
    />)
  })
  return onManageHeartbeat
}

function heartbeatButton(id: string, label: string): HTMLButtonElement {
  const row = [...container.querySelectorAll('.native-heartbeat')].find((item) => item.textContent?.includes(`check ${id}`))
  const match = [...(row?.querySelectorAll('button') ?? [])].find((item) => item.textContent === label)
  if (!match) throw new Error(`No ${label} button for ${id}`)
  return match
}

async function click(element: HTMLElement) {
  await act(async () => { element.click() })
}

describe('native heartbeat actions', () => {
  it('disables Pause and Resume on Rust Prime with the reason, and keeps Stop', async () => {
    const onManageHeartbeat = await renderPage('rust')

    for (const [id, label] of [['active-job', 'Pause'], ['paused-job', 'Resume']] as const) {
      const button = heartbeatButton(id, label)
      expect(button.disabled).toBe(true)
      expect(button.title).toBe(RUST_PRIME_HEARTBEAT_PAUSE_DETAIL)
    }
    expect(container.querySelector('.native-heartbeats__note')?.textContent).toBe(RUST_PRIME_HEARTBEAT_PAUSE_DETAIL)

    const stop = heartbeatButton('active-job', 'Stop')
    expect(stop.disabled).toBe(false)
    await click(stop)
    expect(onManageHeartbeat).not.toHaveBeenCalled()
    await click(document.body.querySelector<HTMLButtonElement>('.modal__footer button')!)
    expect(onManageHeartbeat).not.toHaveBeenCalled()
    await click(stop)
    await click(document.body.querySelector<HTMLButtonElement>('.modal__footer .button--danger')!)
    expect(onManageHeartbeat).toHaveBeenCalledWith('active-job', 'stop')
  })

  it.each([['typescript'], [undefined]] as const)('keeps Pause and Resume on %s Prime', async (implementation) => {
    const onManageHeartbeat = await renderPage(implementation)

    expect(container.querySelector('.native-heartbeats__note')).toBeNull()
    const pause = heartbeatButton('active-job', 'Pause')
    expect(pause.disabled).toBe(false)
    expect(pause.title).toBe('')
    await click(pause)
    expect(onManageHeartbeat).toHaveBeenCalledWith('active-job', 'pause')
    await click(heartbeatButton('paused-job', 'Resume'))
    expect(onManageHeartbeat).toHaveBeenCalledWith('paused-job', 'resume')
  })
})
