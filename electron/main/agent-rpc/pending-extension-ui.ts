import { performance } from 'node:perf_hooks'
import { parseExtensionUiCancel, parseExtensionUiRequest, type ExtensionUiQuestionnaireMeta } from '../../../src/lib/extension-ui'
import type { ExtensionUiQuestionnaireProgress } from '../../../src/types/api'
import type { RpcObject } from './types'

interface PendingDialog { frame: RpcObject; questionnaire?: ExtensionUiQuestionnaireMeta; timer?: NodeJS.Timeout; expiresAt?: number }
interface QuestionnaireGroup { total: number; arrived: Map<number, string>; settled: Set<number> }
const MAX_PENDING = 16
const MAX_CLOSED_GROUPS = 64

/** Retains bounded unanswered dialogs plus group membership across partial replies. */
export class PendingExtensionUi {
  private readonly pending = new Map<string, PendingDialog>()
  private readonly questionnaires = new Map<string, QuestionnaireGroup>()
  private readonly closedGroups = new Set<string>()
  constructor(private readonly now: () => number = () => performance.now()) {}

  track(frame: RpcObject): void {
    const cancelled = parseExtensionUiCancel(frame)
    if (cancelled) { this.resolve(cancelled, true); return }
    const request = parseExtensionUiRequest(frame)
    if (!request) return
    const questionnaire = request.method === 'select' ? request.questionnaire : undefined
    const previous = this.pending.get(request.id)?.questionnaire
    if (previous && (previous.groupId !== questionnaire?.groupId || previous.index !== questionnaire?.index)) return
    if (questionnaire) {
      const { groupId, index, total } = questionnaire
      if (this.closedGroups.has(groupId)) return
      let group = this.questionnaires.get(groupId)
      if (group && (group.total !== total || group.settled.has(index) || group.arrived.has(index) && group.arrived.get(index) !== request.id)) return
      for (const [otherId, other] of this.questionnaires) {
        for (const [otherIndex, id] of other.arrived) {
          if (id === request.id && (otherId !== groupId || otherIndex !== index)) return
        }
      }
      if (!group) {
        group = { total, arrived: new Map(), settled: new Set() }
        this.questionnaires.set(groupId, group)
        while (this.questionnaires.size > MAX_PENDING) {
          const oldest = this.questionnaires.keys().next().value
          if (oldest !== undefined) this.closeGroup(oldest)
        }
      }
      group.arrived.set(index, request.id)
    }
    this.remove(request.id)
    const retained: RpcObject = { type: 'extension_ui_request', ...request }
    // Preserve the validated native marker; replay keeps the harness total unchanged.
    if (request.method === 'select' && Array.isArray(frame.options)) retained.options = [...frame.options]
    const timeout = 'timeout' in request ? request.timeout : undefined
    const entry: PendingDialog = { frame: retained, questionnaire }
    if (timeout !== undefined) {
      entry.expiresAt = this.now() + timeout
      entry.timer = setTimeout(() => this.resolve(request.id, true), timeout)
      entry.timer.unref()
    }
    this.pending.set(request.id, entry)
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value
      if (oldest !== undefined) this.resolve(oldest, true)
    }
  }

  resolve(id: unknown, cancelled = false): void {
    if (typeof id !== 'string') return
    const entry = this.remove(id)
    const metadata = entry?.questionnaire
    if (!metadata) return
    if (cancelled) { this.closeGroup(metadata.groupId); return }
    const group = this.questionnaires.get(metadata.groupId)
    if (!group) return
    group.settled.add(metadata.index)
    if (group.settled.size === group.total) this.closeGroup(metadata.groupId)
  }

  clear(): void {
    for (const groupId of this.questionnaires.keys()) this.closeGroup(groupId)
    for (const id of this.pending.keys()) this.remove(id)
  }

  /** A session change starts a new group-id domain; aborts retain late-frame tombstones. */
  reset(): void { this.clear(); this.closedGroups.clear() }

  list(): RpcObject[] { return this.snapshot().pendingExtensionUi }

  progress(): ExtensionUiQuestionnaireProgress[] { return this.snapshot().pendingExtensionUiGroups }

  snapshot(): { pendingExtensionUi: RpcObject[]; pendingExtensionUiGroups: ExtensionUiQuestionnaireProgress[] } {
    const now = this.now()
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) this.resolve(id, true)
    }
    const pendingExtensionUi = [...this.pending.values()].map((entry) => ({
      ...entry.frame,
      ...(Array.isArray(entry.frame.options) ? { options: [...entry.frame.options] } : {}),
      ...(entry.expiresAt === undefined ? {} : { timeout: Math.ceil(entry.expiresAt - now) }),
    }))
    const pendingExtensionUiGroups = [...this.questionnaires].map(([groupId, group]) => ({
      groupId, total: group.total,
      arrived: [...group.arrived.keys()].sort((left, right) => left - right),
      settled: [...group.settled].sort((left, right) => left - right),
    }))
    return { pendingExtensionUi, pendingExtensionUiGroups }
  }

  private remove(id: string): PendingDialog | undefined {
    const entry = this.pending.get(id)
    if (entry?.timer) clearTimeout(entry.timer)
    this.pending.delete(id)
    return entry
  }

  private closeGroup(groupId: string): void {
    this.questionnaires.delete(groupId)
    for (const [id, entry] of this.pending) if (entry.questionnaire?.groupId === groupId) this.remove(id)
    this.closedGroups.add(groupId)
    while (this.closedGroups.size > MAX_CLOSED_GROUPS) {
      const oldest = this.closedGroups.values().next().value
      if (oldest !== undefined) this.closedGroups.delete(oldest)
    }
  }
}
