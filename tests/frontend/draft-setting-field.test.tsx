// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftSettingField } from '../../src/pages/settings/DraftSettingField'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function renderField(onCommit: (value: string) => Promise<boolean | void> | void) {
  act(() => root.render(<DraftSettingField id="field" label="Field" description="Description" committedValue="original" validate={() => ''} onCommit={onCommit} />))
  return host.querySelector('input')!
}
function edit(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function enter(input: HTMLInputElement) { act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) }) }
function blur(input: HTMLInputElement) { act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) }) }

it.each([false, true])('commits a newer blurred draft after the first save settles (unmount=%s)', async (unmount) => {
  const first = deferred()
  const commit = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined)
  const input = renderField(commit)
  edit(input, 'first'); enter(input)
  await act(async () => { await Promise.resolve() })
  edit(input, 'second'); blur(input); blur(input)
  expect(commit).toHaveBeenCalledTimes(1)
  if (unmount) act(() => root.render(null))
  await act(async () => { first.resolve(); await first.promise })
  expect(commit.mock.calls).toEqual([['first'], ['second']])
})
it('does not resave a draft blurred without newer edits', async () => {
  const first = deferred()
  const commit = vi.fn(() => first.promise)
  const input = renderField(commit)
  edit(input, 'first'); enter(input); blur(input)
  await act(async () => { first.resolve(); await first.promise })
  expect(commit).toHaveBeenCalledExactlyOnceWith('first')
})
it('settles a synchronous save error without stranding a pending field', async () => {
  const input = renderField(() => { throw new Error('Save failed') })
  edit(input, 'first')
  await act(async () => enter(input))
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('Save failed')
  expect(host.querySelector('button')?.textContent).toBe('Save')
})


it('preserves a rejected draft and displays explicit failed persistence', async () => {
  const input = renderField(async () => false)
  edit(input, 'unsaved')
  await act(async () => enter(input))
  expect(input.value).toBe('unsaved')
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('The setting could not be saved.')
  expect(host.querySelector('button')?.disabled).toBe(true)
})
