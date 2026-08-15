import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ExtensionUiQuestion, ExtensionUiRequest } from '@/lib/extension-ui'
import { shortcutLabel } from '@/lib/platform-shortcuts'
import { Modal } from './ui'

const OTHER_OPTION = 'Other (type your own answer)'

export type ExtensionUiResponse =
  | { cancelled: true }
  | { value: string }
  | { confirmed: boolean }
  | { values: Record<string, string> }

interface ExtensionUiModalProps {
  request: ExtensionUiRequest
  onRespond(response: ExtensionUiResponse): void
  platform?: NodeJS.Platform
}

function questionnaireAnswer(
  question: ExtensionUiQuestion,
  selectedIndex: number,
  contexts: Record<string, string>,
) {
  const selected = question.options[selectedIndex]
  const typed = contexts[question.id]?.trim()
  if (selected === OTHER_OPTION) {
    if (!typed) return undefined
    return {
      answer: typed,
      answerSource: 'freeform' as const,
    }
  }
  return {
    answer: selected,
    answerSource: 'option' as const,
    ...(typed ? { context: typed } : {}),
  }
}

export function ExtensionUiModal({ request, onRespond, platform = 'darwin' }: ExtensionUiModalProps) {
  const prefill = request.method === 'editor' ? request.prefill : undefined
  const questionnaireTimeout = request.method === 'questionnaire' ? request.timeout : undefined
  const [value, setValue] = useState(prefill ?? '')
  const [selected, setSelected] = useState(0)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<string, number>>({})
  const [answeredByQuestion, setAnsweredByQuestion] = useState<Record<string, boolean>>({})
  const [contexts, setContexts] = useState<Record<string, string>>({})
  const [remainingMs, setRemainingMs] = useState<number | undefined>(questionnaireTimeout)
  const contextInputRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const questionnaireRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setValue(prefill ?? '')
    setSelected(0)
  }, [prefill, request.id, request.method])

  useEffect(() => {
    if (request.method !== 'questionnaire') return
    setQuestionIndex((current) => Math.min(current, request.questions.length))
    setSelectedByQuestion((current) => {
      const next = { ...current }
      for (const question of request.questions) if (next[question.id] === undefined) next[question.id] = 0
      return next
    })
  }, [request.method, request.id, request.method === 'questionnaire' ? request.questions.length : 0])

  useEffect(() => {
    if (request.method !== 'questionnaire') return
    setQuestionIndex(0)
    setSelectedByQuestion(Object.fromEntries(request.questions.map((question) => [question.id, 0])))
    setAnsweredByQuestion({})
    setContexts({})
  }, [request.id])

  useEffect(() => {
    if (request.method !== 'questionnaire' || !request.complete) return
    const container = questionnaireRef.current
    if (!container || container.contains(document.activeElement)) return
    const focusTarget = container.querySelector<HTMLElement>('.extension-question__options button')
      ?? container.querySelector<HTMLElement>('.extension-questionnaire__progress button.is-active')
    focusTarget?.focus()
  }, [request.id, request.method === 'questionnaire' ? request.complete : false, questionIndex])

  useEffect(() => {
    if (questionnaireTimeout === undefined) {
      setRemainingMs(undefined)
      return
    }
    const deadline = Date.now() + questionnaireTimeout
    const updateRemaining = () => setRemainingMs(Math.max(0, deadline - Date.now()))
    updateRemaining()
    const timer = window.setInterval(updateRemaining, 1_000)
    return () => window.clearInterval(timer)
  }, [questionnaireTimeout, request.id])

  const cancel = () => onRespond({ cancelled: true })

  const questionnaire = request.method === 'questionnaire' ? request : undefined
  const activeQuestion = questionnaire && questionIndex < questionnaire.questions.length
    ? questionnaire.questions[questionIndex]
    : undefined
  const activeSelected = activeQuestion ? selectedByQuestion[activeQuestion.id] ?? 0 : 0
  const allAnswered = Boolean(questionnaire?.complete && questionnaire.questions.length > 0 && questionnaire.questions.every((question) => answeredByQuestion[question.id]))

  const selectQuestionOption = (index: number) => {
    if (!activeQuestion) return
    const bounded = Math.max(0, Math.min(activeQuestion.options.length - 1, index))
    setSelectedByQuestion((current) => ({ ...current, [activeQuestion.id]: bounded }))
    setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: false }))
  }

  const navigateQuestion = (index: number) => {
    if (!questionnaire) return
    if (activeQuestion) {
      const answer = questionnaireAnswer(activeQuestion, activeSelected, contexts)
      setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: Boolean(answer) }))
    }
    setQuestionIndex(Math.max(0, Math.min(questionnaire.questions.length, index)))
  }

  const commitQuestion = (index = activeSelected) => {
    if (!activeQuestion) return
    const bounded = Math.max(0, Math.min(activeQuestion.options.length - 1, index))
    setSelectedByQuestion((current) => ({ ...current, [activeQuestion.id]: bounded }))
    const answer = questionnaireAnswer(activeQuestion, bounded, contexts)
    if (!answer) {
      setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: false }))
      contextInputRefs.current[activeQuestion.id]?.focus()
      return
    }
    setAnsweredByQuestion((current) => ({ ...current, [activeQuestion.id]: true }))
    setQuestionIndex((current) => Math.min(current + 1, questionnaire?.questions.length ?? current + 1))
  }

  const submitQuestionnaire = () => {
    if (!questionnaire || !allAnswered) return
    const values: Record<string, string> = {}
    for (const question of questionnaire.questions) {
      const answer = questionnaireAnswer(question, selectedByQuestion[question.id] ?? 0, contexts)
      if (!answer) return
      values[question.id] = JSON.stringify(answer)
    }
    onRespond({ values })
  }

  const handleQuestionnaireKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!questionnaire?.complete) return
    const isTextInput = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement
    const modifiedArrow = event.ctrlKey || event.metaKey
    // Question navigation is bound to explicit keys only. Tab is intentionally
    // not handled here so the focus trap can reach the footer buttons, and bare
    // arrow keys keep their native caret behavior inside text fields.
    if (event.key === 'PageUp' || (modifiedArrow && event.key === 'ArrowLeft')) {
      event.preventDefault()
      navigateQuestion(questionIndex - 1)
      return
    }
    if (event.key === 'PageDown' || (modifiedArrow && event.key === 'ArrowRight')) {
      event.preventDefault()
      navigateQuestion(questionIndex + 1)
      return
    }
    if (questionIndex === questionnaire.questions.length) {
      if (event.key === 'Enter') {
        event.preventDefault()
        submitQuestionnaire()
      }
      return
    }
    if (!activeQuestion) return
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const delta = event.key === 'ArrowUp' ? -1 : 1
      selectQuestionOption(activeSelected + delta)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      commitQuestion()
      return
    }
    // Let text fields receive printable characters, including digits. Number
    // shortcuts apply when the question itself has focus, while a clicked
    // context field should behave like a normal text input.
    if (isTextInput && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) return
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      if (index < activeQuestion.options.length) {
        event.preventDefault()
        selectQuestionOption(index)
      }
    }
    // Other printable keys are never hijacked: a focused button keeps its
    // native key handling and typing context happens in the context field.
  }

  return (
    <Modal title={request.title} onClose={cancel} footer={(
      <>
        <button type="button" className="button" onClick={cancel}>Cancel</button>
        {request.method === 'confirm' ? <button type="button" className="button button--primary" onClick={() => onRespond({ confirmed: true })}>Confirm</button> : null}
        {request.method === 'input' || request.method === 'editor' ? <button type="button" className="button button--primary" disabled={!value.trim()} onClick={() => onRespond({ value })}>Continue</button> : null}
        {request.method === 'questionnaire' ? <button type="button" className="button button--primary" disabled={!allAnswered} onClick={submitQuestionnaire}>Submit answers</button> : null}
      </>
    )}>
      {request.method === 'questionnaire' ? (
        <div ref={questionnaireRef} className="extension-questionnaire" onKeyDown={handleQuestionnaireKeyDown}>
          {!request.complete ? <p className="modal-intro">Preparing questions…</p> : null}
          {request.complete ? (
            <>
              {remainingMs !== undefined ? (
                <div className="extension-questionnaire__timer" role="timer" aria-live="polite">
                  <span>Time remaining</span>
                  <strong aria-label={`${Math.max(0, Math.ceil(remainingMs / 1_000))} seconds remaining`}>
                    {Math.max(0, Math.ceil(remainingMs / 1_000))}s
                  </strong>
                </div>
              ) : null}
              <div className="extension-questionnaire__progress" aria-label="Question progress">
                {request.questions.map((question, index) => (
                  <button type="button" key={question.id} aria-current={questionIndex === index ? 'step' : undefined} className={questionIndex === index ? 'is-active' : ''} onClick={() => navigateQuestion(index)}>
                    {answeredByQuestion[question.id] ? '✓' : '○'} {index + 1}
                  </button>
                ))}
                <button type="button" aria-current={questionIndex === request.questions.length ? 'step' : undefined} className={questionIndex === request.questions.length ? 'is-active' : ''} onClick={() => navigateQuestion(request.questions.length)}>✓ Submit</button>
              </div>
              {activeQuestion ? (
                <div className="extension-questionnaire__question">
                  <p className="modal-intro">Question {questionIndex + 1} of {request.questions.length}</p>
                  <h3>{activeQuestion.title}</h3>
                  <div className="extension-question__options" role="listbox" aria-label={activeQuestion.title}>
                    {activeQuestion.options.map((option, index) => {
                      const isSelected = activeSelected === index
                      return <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={isSelected ? 'is-selected' : ''}
                        key={`${option}-${index}`}
                        onClick={() => commitQuestion(index)}
                      >
                        <span className="extension-question__option-index">{index + 1}</span>
                        <span>{option}</span>
                      </button>
                    })}
                  </div>
                  <label className="field extension-questionnaire__context">
                    <span>Type to add context</span>
                    <input
                      ref={(element) => { contextInputRefs.current[activeQuestion.id] = element }}
                      value={contexts[activeQuestion.id] ?? ''}
                      placeholder="Type to add context"
                      aria-label="Additional context"
                      onChange={(event) => {
                        setContexts((values) => ({ ...values, [activeQuestion.id]: event.target.value }))
                        setAnsweredByQuestion((values) => ({ ...values, [activeQuestion.id]: false }))
                      }}
                    />
                  </label>
                  <p className="extension-questionnaire__hint">{shortcutLabel(platform, ['Primary', 'ArrowLeft'])} / {shortcutLabel(platform, ['Primary', 'ArrowRight'])} or PgUp/PgDn questions · ↑ ↓ choices · 1–9 select · Enter continue</p>
                </div>
              ) : (
                <div className="extension-questionnaire__submit" role="listbox" aria-label="Submit answers">
                  {request.questions.map((question) => {
                    const answer = questionnaireAnswer(question, selectedByQuestion[question.id] ?? 0, contexts)
                    return <p key={question.id}><strong>{question.index + 1}.</strong> {answer?.answer ?? 'Not answered'}</p>
                  })}
                </div>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {request.method === 'select' ? (
        <div className="extension-question">
          <p className="modal-intro">Choose an option to let Prime continue.</p>
          <div className="extension-question__options" role="listbox" aria-label={request.title}>
            {request.options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={selected === index}
                className={selected === index ? 'is-selected' : ''}
                key={`${option}-${index}`}
                onClick={() => { setSelected(index); onRespond({ value: option }) }}
                onFocus={() => setSelected(index)}
              >
                <span className="extension-question__option-index">{index + 1}</span>
                <span>{option}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {request.method === 'confirm' ? <p className="modal-intro extension-question__message">{request.message}</p> : null}
      {request.method === 'input' ? <label className="field extension-question__field"><span>Response</span><input autoFocus value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && value.trim()) { event.preventDefault(); onRespond({ value }) } }} /></label> : null}
      {request.method === 'editor' ? <label className="field extension-question__field"><span>Response</span><textarea autoFocus rows={7} value={value} onChange={(event) => setValue(event.target.value)} /></label> : null}
    </Modal>
  )
}
