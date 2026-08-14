import { describe, expect, it } from 'vitest'
import { parseExtensionUiRequest } from '../../src/lib/extension-ui'
import { pendingExtensionUiForRuntime, type PendingExtensionUi } from '../../src/hooks/useExtensionUi'

describe('extension UI request parsing', () => {
  it('accepts a bounded multiple-choice request', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta'],
      timeout: 30_000,
    })
  })

  it('unwraps a grouped ask_user question marker for the questionnaire UI', () => {
    expect(parseExtensionUiRequest({
      type: 'extension_ui_request',
      id: 'question-1',
      method: 'select',
      title: 'Choose a release channel',
      options: ['__prime_ask_user__group-1:0:2', 'Stable', 'Beta', 'Other (type your own answer)'],
    })).toEqual({
      method: 'select',
      id: 'question-1',
      title: 'Choose a release channel',
      options: ['Stable', 'Beta', 'Other (type your own answer)'],
      questionnaire: { groupId: 'group-1', index: 0, total: 2 },
    })
  })

  it('rejects malformed or oversized options', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: [] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['ok', 42] })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['x'.repeat(501)] })).toBeUndefined()
  })

  it('supports confirm and text input requests', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'confirm-1', method: 'confirm', title: 'Continue?', message: 'This will deploy.' })).toMatchObject({ method: 'confirm', id: 'confirm-1', title: 'Continue?', message: 'This will deploy.' })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'input-1', method: 'input', title: 'Name', placeholder: 'Project name' })).toMatchObject({ method: 'input', id: 'input-1', title: 'Name', placeholder: 'Project name' })
  })

  it('rejects requests that are not extension UI requests or lack an id, title, or method', () => {
    expect(parseExtensionUiRequest({ type: 'message_end', id: 'x', method: 'input', title: 'Name' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', method: 'input', title: 'Name' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: '   ' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', title: 'Name', method: 7 })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', title: 'Name', method: 'progress' })).toBeUndefined()
  })

  it('drops out-of-range timeouts instead of the whole request', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: 0 })).toEqual({ method: 'input', id: 'x', title: 'Name', placeholder: undefined, timeout: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: 25 * 60 * 60 * 1_000 })).toMatchObject({ timeout: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', timeout: '30000' })).toMatchObject({ timeout: undefined })
  })

  it('treats an unusable questionnaire marker as a plain option', () => {
    const request = (marker: string) => parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: [marker, 'Stable'] })
    expect(request('__prime_ask_user__group-1:0')).toMatchObject({ options: ['__prime_ask_user__group-1:0', 'Stable'] })
    expect(request('__prime_ask_user__:0:2')).toMatchObject({ options: ['__prime_ask_user__:0:2', 'Stable'] })
    expect(request('__prime_ask_user__group 1:0:2')).toMatchObject({ options: ['__prime_ask_user__group 1:0:2', 'Stable'] })
    expect(request('__prime_ask_user__group-1:1:1')).toMatchObject({ options: ['__prime_ask_user__group-1:1:1', 'Stable'] })
    expect(request('__prime_ask_user__group-1:0:6')).toMatchObject({ options: ['__prime_ask_user__group-1:0:6', 'Stable'] })
    expect(request('__prime_ask_user__group-1:0.5:2')).toMatchObject({ options: ['__prime_ask_user__group-1:0.5:2', 'Stable'] })
  })

  it('rejects a questionnaire marker with no visible options left', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'select', title: 'Pick', options: ['__prime_ask_user__group-1:0:2'] })).toBeUndefined()
  })

  it('rejects a confirm request without a message and an input request with an unusable placeholder', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'confirm', title: 'Continue?' })).toBeUndefined()
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'x', method: 'input', title: 'Name', placeholder: 42 })).toBeUndefined()
  })

  it('accepts an editor request with a bounded prefill', () => {
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan', prefill: 'step one' })).toEqual({ method: 'editor', id: 'editor-1', title: 'Edit the plan', prefill: 'step one' })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan' })).toEqual({ method: 'editor', id: 'editor-1', title: 'Edit the plan', prefill: undefined })
    expect(parseExtensionUiRequest({ type: 'extension_ui_request', id: 'editor-1', method: 'editor', title: 'Edit the plan', prefill: 'x'.repeat(32_001) })).toBeUndefined()
  })
})


describe('pending extension UI ownership', () => {
  it('retains background requests until their runtime becomes active', () => {
    const foreground: PendingExtensionUi = {
      runtimeId: 'runtime-a',
      request: { method: 'confirm', id: 'foreground', title: 'Continue?', message: 'Proceed' },
    }
    const background: PendingExtensionUi = {
      runtimeId: 'runtime-b',
      request: { method: 'input', id: 'background', title: 'Answer' },
    }
    const pending = new Map([
      [foreground.runtimeId, foreground],
      [background.runtimeId, background],
    ])

    expect(pendingExtensionUiForRuntime(pending, 'runtime-a')).toBe(foreground)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-b')).toBe(background)
    expect(pendingExtensionUiForRuntime(pending, 'runtime-missing')).toBeNull()
    expect(pendingExtensionUiForRuntime(pending)).toBeNull()
  })
})
