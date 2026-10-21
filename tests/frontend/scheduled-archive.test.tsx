// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { archivableScheduleSessions } from '../../src/lib/schedule-archive'
import { ScheduledPage } from '../../src/pages/ScheduledPage'
import type { AutomationScheduleRecord, ScheduleRunRecord, SessionRecord } from '../../src/types/api'

const execution = { model: 'auto', thinking: 'auto', speed: 'normal' } as const
const date = '2026-10-20T12:00:00.000Z'
const run: ScheduleRunRecord = { id: 'run', taskId: 'task', taskRevision: 2, trigger: 'manual', scheduledFor: date, queuedAt: date, status: 'succeeded', execution, sessionFile: '/run.jsonl' }
const task: AutomationScheduleRecord = { schemaVersion: 1, id: 'task', harness: 'prime', revision: 2, title: 'Task', prompt: 'Do work', target: { kind: 'project', projectId: 'project' }, timing: { kind: 'once', at: date }, execution, status: 'completed', createdBy: 'user', createdAt: date, updatedAt: date, runs: [run] }
const chat: SessionRecord = { id: 'chat', harness: 'prime', filePath: '/run.jsonl', projectPath: '/project', title: 'Run chat', createdAt: date, updatedAt: date, status: 'complete', depth: 0 }

describe('archive finished scheduled chats', () => {
  it('requires successful new-chat runs from the current target revision and a settled visible session', () => {
    expect(archivableScheduleSessions(task, [chat])).toEqual([chat])
    expect(archivableScheduleSessions({ ...task, target: { kind: 'session', projectId: 'project', sessionId: 'chat' } }, [chat])).toEqual([])
    for (const changedRun of [{ ...run, taskRevision: 1 }, { ...run, status: 'failed' as const }, { ...run, status: 'running' as const }]) {
      expect(archivableScheduleSessions({ ...task, runs: [changedRun] }, [chat])).toEqual([])
    }
    for (const changedChat of [{ ...chat, archived: true }, { ...chat, status: 'running' as const }, { ...chat, status: 'waiting' as const }, { ...chat, harness: 'pi' as const }]) {
      expect(archivableScheduleSessions(task, [changedChat])).toEqual([])
    }
    expect(archivableScheduleSessions({ ...task, runs: [run, { ...run, id: 'duplicate' }] }, [chat])).toEqual([chat])
  })

  it('confirms the eligible count and invokes one batch action, then shows archived history', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const archive = vi.fn(async () => undefined)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const noop = async () => undefined
    const render = (sessions: SessionRecord[]) => root.render(<ScheduledPage harness="prime" schedules={[task]} selectedScheduleId="task" nativeHeartbeats={[]} projects={[]} sessions={sessions} models={[]} lastSelectedModel="" onCreate={noop} onUpdate={noop} onPause={noop} onResume={noop} onDelete={noop} onRunNow={noop} onPreview={async (timing) => ({ timing, occurrences: [] })} onOpenSession={() => undefined} onManageHeartbeat={noop} onArchiveSessions={archive} />)
    try {
      await act(async () => render([chat]))
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.includes('Archive finished (1)'))!
      await act(async () => button.click())
      expect(archive).not.toHaveBeenCalled()
      expect(document.body.querySelector('.modal')?.textContent).toContain('Archive 1 finished run chat?')
      await act(async () => document.body.querySelector<HTMLButtonElement>('.modal__footer button')!.click())
      expect(archive).not.toHaveBeenCalled()
      await act(async () => button.click())
      await act(async () => document.body.querySelector<HTMLButtonElement>('.modal__footer .button--danger')!.click())
      expect(archive).toHaveBeenCalledExactlyOnceWith([chat])
      expect(confirm).not.toHaveBeenCalled()
      await act(async () => render([{ ...chat, archived: true }]))
      expect(host.textContent).toContain('Archived')
      expect(host.textContent).not.toContain('Archive finished')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      confirm.mockRestore()
    }
  })
})

it('rechecks archive eligibility after confirmation instead of archiving a newly running chat', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const archive = vi.fn(async () => undefined)
  const noop = async () => undefined
  const render = (sessions: SessionRecord[]) => root.render(<ScheduledPage harness="prime" schedules={[task]} selectedScheduleId="task" nativeHeartbeats={[]} projects={[]} sessions={sessions} models={[]} lastSelectedModel="" onCreate={noop} onUpdate={noop} onPause={noop} onResume={noop} onDelete={noop} onRunNow={noop} onPreview={async (timing) => ({ timing, occurrences: [] })} onOpenSession={() => undefined} onManageHeartbeat={noop} onArchiveSessions={archive} />)
  try {
    await act(async () => render([chat]))
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Archive finished'))!.click())
    await act(async () => render([{ ...chat, status: 'running' }]))
    await act(async () => document.querySelector<HTMLButtonElement>('.modal__footer .button--danger')!.click())
    expect(archive).not.toHaveBeenCalled()
  } finally { await act(async () => root.unmount()); host.remove() }
})
