// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionUiModal } from '../../src/components/ExtensionUiModal'
import type { ExtensionUiRequest } from '../../src/lib/extension-ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const request: ExtensionUiRequest = {
  method: 'questionnaire',
  id: 'group-1',
  title: 'Project setup',
  total: 2,
  complete: true,
  questions: [
    { id: 'q1', title: 'Pick a framework', options: ['React', 'Vue'], index: 0 },
    { id: 'q2', title: 'Pick a language', options: ['TypeScript', 'JavaScript'], index: 1 },
  ],
}

function questionnaireElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.extension-questionnaire')
  if (!element) throw new Error('questionnaire not rendered')
  return element
}

function currentQuestionTitle(): string {
  return document.querySelector('.extension-questionnaire__question h3')?.textContent ?? ''
}

function pressKey(target: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  act(() => { target.dispatchEvent(event) })
  return event
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  button.focus()
  await act(async () => { button.click() })
}

describe('extension questionnaire keyboard handling', () => {
  it('leaves Tab to the focus trap instead of hijacking it for question navigation', async () => {
    await act(async () => { root.render(<ExtensionUiModal request={request} onRespond={vi.fn()} />) })
    const optionButton = questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!
    pressKey(optionButton, { key: 'Tab' })
    expect(currentQuestionTitle()).toBe('Pick a framework')
  })

  it('navigates questions with explicit keys only', async () => {
    await act(async () => { root.render(<ExtensionUiModal request={request} onRespond={vi.fn()} />) })
    const optionButton = questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!
    pressKey(optionButton, { key: 'ArrowRight' })
    expect(currentQuestionTitle()).toBe('Pick a framework')
    pressKey(optionButton, { key: 'ArrowRight', ctrlKey: true })
    expect(currentQuestionTitle()).toBe('Pick a language')
    const nextOption = questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!
    pressKey(nextOption, { key: 'ArrowLeft', ctrlKey: true })
    expect(currentQuestionTitle()).toBe('Pick a framework')
    pressKey(questionnaireElement(), { key: 'PageDown' })
    expect(currentQuestionTitle()).toBe('Pick a language')
    pressKey(questionnaireElement(), { key: 'PageUp' })
    expect(currentQuestionTitle()).toBe('Pick a framework')
  })

  it('keeps navigation focused after the final option auto-advances to the submit summary', async () => {
    await act(async () => { root.render(<ExtensionUiModal request={request} onRespond={vi.fn()} />) })
    await clickButton(questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!)
    expect(currentQuestionTitle()).toBe('Pick a language')

    await clickButton(questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!)
    expect(currentQuestionTitle()).toBe('')
    const summaryProgress = questionnaireElement().querySelector<HTMLButtonElement>('.extension-questionnaire__progress button:last-child')!
    expect(document.activeElement).toBe(summaryProgress)
    expect(summaryProgress.getAttribute('aria-current')).toBe('step')

    pressKey(document.activeElement as HTMLElement, { key: 'ArrowLeft', ctrlKey: true })
    expect(currentQuestionTitle()).toBe('Pick a language')

    await clickButton(summaryProgress)
    expect(currentQuestionTitle()).toBe('')
    pressKey(document.activeElement as HTMLElement, { key: 'PageUp' })
    expect(currentQuestionTitle()).toBe('Pick a language')
  })

  it('keeps caret movement in the context field when pressing bare arrow keys', async () => {
    await act(async () => { root.render(<ExtensionUiModal request={request} onRespond={vi.fn()} />) })
    const contextInput = questionnaireElement().querySelector<HTMLInputElement>('.extension-questionnaire__context input')!
    const event = pressKey(contextInput, { key: 'ArrowLeft' })
    expect(event.defaultPrevented).toBe(false)
    expect(currentQuestionTitle()).toBe('Pick a framework')
  })

  it('does not hijack printable keys when a button has focus', async () => {
    await act(async () => { root.render(<ExtensionUiModal request={request} onRespond={vi.fn()} />) })
    const optionButton = questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button')!
    const event = pressKey(optionButton, { key: 'a' })
    expect(event.defaultPrevented).toBe(false)
    const contextInput = questionnaireElement().querySelector<HTMLInputElement>('.extension-questionnaire__context input')!
    expect(contextInput.value).toBe('')
    // Digit shortcuts still select options from a focused button.
    pressKey(optionButton, { key: '2' })
    const selected = questionnaireElement().querySelector<HTMLButtonElement>('.extension-question__options button.is-selected')!
    expect(selected.textContent).toContain('Vue')
  })
})
