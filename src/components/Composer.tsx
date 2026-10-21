import { rpcRequestFrameBytes, RPC_WRITE_FRAME_LIMIT_BYTES } from '@/lib/rpc-frame'
import { ArrowUp, AtSign, ChevronDown, Clock3, Command, Edit3, Gauge, ImageIcon, LoaderCircle, MessageCirclePlus, Mic, Paperclip, Plus, Square, SquareTerminal, Trash2, X, Zap } from 'lucide-react'
import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type {
  BrowserAnnotation,
  CheckoutAction,
  CheckoutCatalog,
  HarnessId,
  MessageEnterAction,
  PrimeContextUsage,
  PrimeModelDescriptor,
  PrimeProviderDescriptor,
  PrimeThinkingLevel,
  SessionUsage,
  PrimeWorkApi,
  PromptDeliveryIntent,
  PromptImage,
  QueuedPrompt,
  SessionRecord,
  SkillRecord,
  TerminalPromptContext,
  TerminalSelectionContext,
  VoiceTranscriptionProvider,
} from '@/types/api'
import { composePrompt } from '@/lib/composer-prompt'
import { activeMention, findSessionMentions, mentionLabelKey } from '@/lib/session-mentions'
import { clearComposerDraft, readComposerDraft, restoreComposerDraft, saveComposerDraft } from '@/lib/composer-draft'
import { contextDialLabel } from '@/lib/format-cost'
import { useI18n, type MessageKey } from '@/lib/i18n'
import { messageActionForKey } from '@/lib/message-shortcuts'
import { useComposerImages } from '@/hooks/useComposerImages'
import { useDictation } from '@/hooks/useDictation'
import { IconButton, SelectControl } from './ui'
import { ExecutingModelChip, type ExecutingModelChipProps } from './ExecutingModelChip'
import { ModelPicker } from './ModelPicker'
import { CheckoutPicker } from './CheckoutPicker'

interface ComposerProps {
  busy: boolean
  submitting?: boolean
  loading?: boolean
  disabled?: boolean
  model: string
  effort: PrimeThinkingLevel
  modelsByProvider: ReadonlyMap<string, PrimeModelDescriptor[]>
  providers: PrimeProviderDescriptor[]
  reasoningLevels: PrimeThinkingLevel[]
  fast: boolean
  fastSupported: boolean
  fastAvailable: boolean
  /** Active harness agent name for tooltips ("Prime Agent" / "OMP"). */
  agentName?: string
  /** Active harness short name for inline copy ("Prime" / "OMP"). */
  shortName?: string
  harness?: HarnessId
  imageInputSupported: boolean
  /** Primary action for Enter; Ctrl/Cmd+Enter selects the opposite action. */
  messageEnterAction?: MessageEnterAction
  contextUsage?: PrimeContextUsage
  executingModel?: ExecutingModelChipProps['executingModel']
  sessionUsage?: SessionUsage
  voice?: PrimeWorkApi['voice'] | null
  transcriptionProvider?: VoiceTranscriptionProvider
  skills: SkillRecord[]
  /** Other sidebar sessions in the active project, available as @title references. */
  sessions?: SessionRecord[]
  /** Browser annotations auto-attach as a composer attachment while any exist. */
  annotations?: BrowserAnnotation[]
  /** The active terminal is visible as context; selected text expands this attachment. */
  terminalSelection?: TerminalSelectionContext
  /** Reads the active xterm buffer only at submit time, avoiding output-driven renderer updates. */
  getTerminalContext?(): TerminalPromptContext | undefined
  /** Messages accepted by Prime but waiting for a turn boundary. */
  queuedMessages?: QueuedPrompt[]
  /** Messages held inside the harness when it exposes only a count, not previews. */
  harnessQueuedMessageCount?: number
  onDeleteQueuedMessage?(message: QueuedPrompt): void
  onEditQueuedMessage?(message: QueuedPrompt): void
  /** Each bump submits the current draft immediately (Ctrl/Cmd+Enter from the annotation popover). */
  sendSignal?: number
  onModelChange(value: string): void
  onEffortChange(value: PrimeThinkingLevel): void
  onFastChange(value: boolean): void
  checkoutCatalog?: CheckoutCatalog
  /** Branch/worktree name shown before or without the linked-worktree catalog. */
  checkoutLabel?: string
  checkoutsLoading?: boolean
  onExecuteCheckout?(action: CheckoutAction): Promise<void> | void
  onSend(prompt: string, images: PromptImage[], intent: PromptDeliveryIntent): Promise<void> | void
  onStop(): Promise<void> | void
  onRemoveAnnotation?(id: string): void
  /** Called after a send that included the annotations, and by the attachment's remove control. */
  onClearAnnotations?(): void
  onClearTerminalSelection?(): void
  /** Stable per-workspace key; without it the composer keeps no draft of its own. */
  draftKey?: string
}

// Slash-command and reasoning copy is display text only: these tables hold
// MessageKeys so translation happens inside the component at render time.
const commands: ReadonlyArray<{ command: string; detail: MessageKey }> = [
  { command: '/review', detail: 'composer.command.review' },
  { command: '/plan', detail: 'composer.command.plan' },
  { command: '/compact', detail: 'composer.command.compact' },
  { command: '/status', detail: 'composer.command.status' },
]

const primeCommands: ReadonlyArray<{ command: string; detail: MessageKey }> = [
  ...commands,
  { command: '/mcp', detail: 'composer.command.mcp' },
]

const reasoningLabels: Record<PrimeThinkingLevel, MessageKey> = {
  off: 'composer.effort.off',
  minimal: 'composer.effort.minimal',
  low: 'composer.effort.low',
  medium: 'composer.effort.medium',
  high: 'composer.effort.high',
  xhigh: 'composer.effort.xhigh',
  max: 'composer.effort.max',
}

const EMPTY_ANNOTATIONS: BrowserAnnotation[] = []
const noop = () => undefined

export const Composer = memo(function Composer({
  busy,
  submitting = false,
  loading = false,
  disabled,
  model,
  effort,
  modelsByProvider,
  providers,
  reasoningLevels,
  fast,
  fastSupported,
  fastAvailable,
  agentName = 'Prime Agent',
  shortName = 'Prime',
  harness = 'prime',
  imageInputSupported,
  messageEnterAction = 'queue',
  contextUsage,
  executingModel,
  sessionUsage,
  voice,
  transcriptionProvider = 'openai-live',
  skills,
  sessions = [],
  annotations = EMPTY_ANNOTATIONS,
  terminalSelection,
  getTerminalContext,
  queuedMessages = [],
  harnessQueuedMessageCount = 0,
  onDeleteQueuedMessage,
  onEditQueuedMessage,
  sendSignal = 0,
  onModelChange,
  onEffortChange,
  onFastChange,
  checkoutCatalog,
  checkoutLabel,
  checkoutsLoading = false,
  onExecuteCheckout,
  onSend,
  onStop,
  onRemoveAnnotation = noop,
  onClearAnnotations = noop,
  onClearTerminalSelection = noop,
  draftKey,
}: ComposerProps) {
  const { t } = useI18n()
  const [value, setValue] = useState(() => readComposerDraft(draftKey ?? 'default')?.text ?? '')
  const [caret, setCaret] = useState<{ value: string; position: number } | null>(null)
  const caretPos = caret?.value === value ? Math.min(caret.position, value.length) : value.length
  const [menu, setMenu] = useState<'add' | 'mention' | 'command' | null>(null)
  const [sessionReferenceIds, setSessionReferenceIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [annotationsOpen, setAnnotationsOpen] = useState(false)
  const [terminalSelectionOpen, setTerminalSelectionOpen] = useState(false)
  const imageAttachments = useComposerImages({ shortName })
  const { images, imagesRef, unsupportedFiles, unsupportedFilesRef, error: attachmentError, setError: setAttachmentError, processing: processingImages } = imageAttachments
  const dictation = useDictation(voice, transcriptionProvider, setAttachmentError)
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const acceptedMentionRef = useRef<{ start: number; text: string } | null>(null)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageStatusId = useId()
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const mountedRef = useRef(true)
  const restoredDraftRef = useRef(false)
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills])

  useEffect(() => {
    if (!draftKey || restoredDraftRef.current) return
    restoredDraftRef.current = true
    const draft = readComposerDraft(draftKey)
    if (!draft) return
    if (draft.model && draft.model !== model) onModelChange(draft.model)
    if (draft.effort && draft.effort !== effort) onEffortChange(draft.effort as PrimeThinkingLevel)
    if (draft.fast !== undefined && draft.fast !== fast) onFastChange(draft.fast)
  }, [draftKey, effort, fast, model, onEffortChange, onFastChange, onModelChange])

  useEffect(() => {
    if (draftKey) saveComposerDraft(draftKey, { text: value, model, effort, fast })
  }, [draftKey, effort, fast, model, value])

  useEffect(() => {
    const mentionMatch = activeMention(value, caretPos)
    const mentionStart = mentionMatch?.start ?? -1
    const acceptedMention = acceptedMentionRef.current
    const suppressAcceptedMention = Boolean(
      mentionMatch
      && acceptedMention
      && mentionStart === acceptedMention.start
      && value.slice(acceptedMention.start, acceptedMention.start + acceptedMention.text.length) === acceptedMention.text,
    )
    if (acceptedMention && value.slice(acceptedMention.start, acceptedMention.start + acceptedMention.text.length) !== acceptedMention.text) acceptedMentionRef.current = null
    setMenu(value.startsWith('/') && !value.includes(' ') ? 'command' : mentionMatch && !suppressAcceptedMention ? 'mention' : null)
  }, [caretPos, value])
  useEffect(() => {
    setSessionReferenceIds((current) => {
      if (!current.size) return current
      const mentionedTitles = new Set(findSessionMentions(value, sessions, current).map(({ session }) => mentionLabelKey(session.title)))
      const next = new Map([...current].filter(([title]) => mentionedTitles.has(title)))
      return next.size === current.size ? current : next
    })
  }, [sessions, value])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (annotations.length === 0) setAnnotationsOpen(false)
  }, [annotations.length])
  useEffect(() => {
    if (!terminalSelection?.text) setTerminalSelectionOpen(false)
  }, [terminalSelection?.text])

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Node) || menuRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-composer-menu-trigger]')) return
      setMenu(null)
    }
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onEscape)
    }
  }, [menu])


  // Ctrl/Cmd+Enter in the annotation popover bumps sendSignal to submit the
  // draft (with the just-saved annotation) without switching focus here.
  const lastSendSignalRef = useRef(sendSignal)
  useEffect(() => {
    if (sendSignal === lastSendSignalRef.current) return
    lastSendSignalRef.current = sendSignal
    void submit()
  }, [sendSignal])

  const submit = async (intent: PromptDeliveryIntent = 'queue', valueOverride?: string) => {
    const currentImages = imagesRef.current
    const currentUnsupportedFiles = unsupportedFilesRef.current
    const currentAnnotations = annotationsRef.current
    const currentTerminalContext = terminalSelection?.text ? getTerminalContext?.() : undefined
    const hasTerminalSelection = Boolean(currentTerminalContext?.text)
    const draftValue = valueOverride ?? value
    // These bracket labels become the message payload sent to the harness, not
    // UI chrome, so they stay English and outside the i18n catalog.
    const prompt = draftValue.trim() || (currentImages.length > 0
      ? (currentImages.length === 1 ? '[Attached image]' : '[Attached images]')
      : currentUnsupportedFiles.length > 0 ? (currentUnsupportedFiles.length === 1 ? '[Attached file]' : '[Attached files]')
        : currentAnnotations.length > 0 ? '[Page annotations]' : '[Terminal selection]')
    if ((!draftValue.trim() && currentImages.length === 0 && currentUnsupportedFiles.length === 0 && currentAnnotations.length === 0 && !hasTerminalSelection) || loading || disabled || (intent !== 'steer' && !busy && (submitting || submittingRef.current))) return
    if (imageAttachments.hasPending()) {
      setAttachmentError(t('composer.error.waitForProcessing'))
      return
    }
    if (currentUnsupportedFiles.length > 0) {
      const first = currentUnsupportedFiles[0]
      const remainder = currentUnsupportedFiles.length - 1
      setAttachmentError(remainder
        ? t('composer.error.unsupportedMore', { name: first.name, count: remainder })
        : t('composer.error.unsupportedSingle', { name: first.name }))
      return
    }
    if (currentImages.length > 0 && !imageInputSupported) {
      setAttachmentError(t('composer.error.imagesUnsupported'))
      return
    }
    const submittedImages = currentImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    const composed = composePrompt(prompt, harness, { sessions, sessionReferenceIds, skills: enabledSkills, annotations: currentAnnotations, terminalContext: currentTerminalContext })
    if ('error' in composed) { setAttachmentError(composed.error); return }
    const promptWithContext = composed.prompt
    if (rpcRequestFrameBytes({ type: intent === 'steer' ? 'steer' : 'follow_up', message: promptWithContext, ...(submittedImages.length ? { images: submittedImages } : {}) }) > RPC_WRITE_FRAME_LIMIT_BYTES) {
      setAttachmentError(t('composer.error.tooLarge'))
      return
    }
    submittingRef.current = true
    const submittedValue = draftValue
    const submittedComposerImages = currentImages
    setValue('')
    imageAttachments.clear()
    setAttachmentError('')
    setMenu(null)
    try {
      await onSend(promptWithContext, submittedImages, intent)
      if (draftKey) clearComposerDraft(draftKey)
      // The annotations were delivered: clear the attachment and page markers.
      if (currentAnnotations.length > 0) onClearAnnotations()
    } catch {
      if (mountedRef.current) {
        setValue((current) => current || submittedValue)
        const restoration = imageAttachments.restoreWithinLimits(submittedComposerImages)
        if (restoration.omitted > 0) {
          // `restored` is a pre-translated clause so English keeps its exact
          // wording while Japanese can place it as a parenthetical.
          const restored = restoration.restored > 0 ? t('composer.error.restoredImages', { count: restoration.restored }) : ''
          setAttachmentError(t('composer.error.restoreOmitted', { count: restoration.omitted, restored }))
        } else if (submittedComposerImages.length > 0) {
          setAttachmentError(t('composer.error.restoreDraftAndImages'))
        } else {
          setAttachmentError(t('composer.error.restoreDraft'))
        }
      } else if (draftKey) {
        // The user switched away mid-send; the next composer for this draft restores it.
        restoreComposerDraft(draftKey, { text: submittedValue, model, effort, fast })
      }
    } finally {
      submittingRef.current = false
      if (mountedRef.current && wrapRef.current?.contains(document.activeElement)) textareaRef.current?.focus()
    }
  }

  const finishDictation = async (send: boolean) => {
    const transcript = await dictation.finish()
    if (!transcript) return
    const next = value.trimEnd() ? `${value.trimEnd()} ${transcript}` : transcript
    setValue(next)
    if (send) await submit('queue', next)
    else requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const insertAtCaret = (textarea: HTMLTextAreaElement, text: string) => {
    const start = textarea.selectionStart ?? textarea.value.length
    const end = textarea.selectionEnd ?? textarea.value.length
    textarea.setRangeText(text, start, end, 'end')
    setValue(textarea.value)
    setCaret({ value: textarea.value, position: textarea.selectionStart })
  }
  const insert = (text: string) => {
    const textarea = textareaRef.current
    if (textarea) insertAtCaret(textarea, text)
    else setValue((current) => `${current}${text}`)
    setMenu(null)
    textarea?.focus()
  }
  const insertMention = (label: string, session?: SessionRecord) => {
    const textarea = textareaRef.current
    const match = activeMention(value, caretPos)
    if (!match) { insert(`@${label} `); return }
    const start = match.start + 1
    const mentionStart = start - 1
    const acceptedText = `@${label} `
    if (textarea) {
      textarea.setRangeText(`${label} `, start, caretPos, 'end')
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(textarea.value)
      setCaret({ value: textarea.value, position: textarea.selectionStart })
    } else {
      acceptedMentionRef.current = { start: mentionStart, text: acceptedText }
      setValue(`${value.slice(0, start)}${label} ${value.slice(caretPos)}`)
    }
    if (session) {
      const key = mentionLabelKey(session.title)
      setSessionReferenceIds((current) => new Map(current).set(key, session.id))
    }
    setMenu(null)
    textarea?.focus()
  }

  const mentionQuery = activeMention(value, caretPos)?.query.toLocaleLowerCase().trim() ?? ''

  const suggestions =
    menu === 'command'
      ? (harness === 'prime' ? primeCommands : commands)
          .filter((item) => item.command.startsWith(value))
          .map((item) => ({
            key: item.command,
            label: item.command,
            detail: t(item.detail),
            icon: <Command size={14} />,
            choose: () => {
              setValue(`${item.command} `)
              setMenu(null)
              textareaRef.current?.focus()
            },
          }))
      : menu === 'mention'
        ? [
            ...sessions.filter((session) => session.title.toLocaleLowerCase().includes(mentionQuery)).slice(0, 6).map((session) => ({
              key: `session:${session.harness}:${session.id}`,
              label: `@${session.title}`,
              detail: t('composer.suggestion.session', { harness: session.harness.toUpperCase(), status: session.status }),
              icon: <MessageCirclePlus size={14} />,
              choose: () => insertMention(session.title, session),
            })),
            ...enabledSkills.filter((skill) => skill.name.toLocaleLowerCase().includes(mentionQuery)).slice(0, 6).map((skill) => ({
              key: `skill:${skill.id}`,
              label: `@${skill.name}`,
              detail: skill.description,
              icon: <AtSign size={14} />,
              choose: () => insertMention(skill.name),
            })),
          ].slice(0, 8)
        : menu === 'add'
          ? [
              { key: 'files', label: t('composer.add.files'), detail: t('composer.add.filesDetail'), icon: <Paperclip size={14} />, choose: () => { setMenu(null); fileInputRef.current?.click() } },
              { key: 'mention', label: t('composer.add.mention'), detail: t('composer.add.mentionDetail'), icon: <AtSign size={14} />, choose: () => insert('@') },
            ]
          : []

  useEffect(() => {
    setActiveSuggestion(0)
  }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()
  const contextPercent = contextUsage?.percent === null || contextUsage?.percent === undefined ? null : Math.min(100, Math.max(0, contextUsage.percent))
  const contextLabel = contextDialLabel(contextUsage, sessionUsage)
  const contextDisplayPercent = contextPercent === null ? null : Math.min(99, Math.round(contextPercent))
  const contextStyle = { '--context-percent': `${contextPercent ?? 0}%` } as CSSProperties
  const sendQueuedMessageImmediately = async (queued: QueuedPrompt) => {
    onDeleteQueuedMessage?.(queued)
    try {
      await onSend(queued.text, [], 'steer')
    } catch {
      if (!mountedRef.current) {
        if (draftKey) { const draft = readComposerDraft(draftKey); saveComposerDraft(draftKey, { ...draft, text: draft?.text.trim() ? `${draft.text.trimEnd()}\n\n${queued.text}` : queued.text }) }
        return
      }
      setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${queued.text}` : queued.text)
      setAttachmentError(t('composer.error.queuedRestore'))
    }
  }

  return (
    <div ref={wrapRef} className="composer-wrap" data-draft-scope={draftKey ?? 'default'}>
      {queuedMessages.length || harnessQueuedMessageCount ? (
        <section className="composer-queue" aria-label={t('composer.queue.label')} aria-live="polite">
          <div className="composer-queue__header">
            <span><Clock3 size={13} />{t('composer.queue.label')}</span>
            <strong>{queuedMessages.length + harnessQueuedMessageCount}</strong>
          </div>
          <div className="composer-queue__list">
            {queuedMessages.map((queued) => (
              <div className="composer-queue__item" key={queued.id}>
                <span className="composer-queue__text">{queued.text}</span>
                <span className="composer-queue__actions">
                  <button type="button" className="composer-queue__action" aria-label={t('composer.queue.sendNowDetail', { text: queued.text })} title={t('composer.queue.sendNow')} onClick={() => { void sendQueuedMessageImmediately(queued) }}><ArrowUp size={13} /></button>
                  <button type="button" className="composer-queue__action" aria-label={t('composer.queue.editDetail', { text: queued.text })} title={t('composer.queue.edit')} onClick={() => { onEditQueuedMessage?.(queued); setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${queued.text}` : queued.text); requestAnimationFrame(() => textareaRef.current?.focus()) }}><Edit3 size={13} /></button>
                  <button type="button" className="composer-queue__action composer-queue__action--delete" aria-label={t('composer.queue.deleteDetail', { text: queued.text })} title={t('composer.queue.delete')} onClick={() => onDeleteQueuedMessage?.(queued)}><Trash2 size={13} /></button>
                </span>
              </div>
            ))}
            {harnessQueuedMessageCount ? (
              <div className="composer-queue__item composer-queue__item--harness">
                <span className="composer-queue__text">{t('composer.queue.harnessHolding', { agent: agentName, count: harnessQueuedMessageCount })}</span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      <div
        className={`composer ${busy || submitting ? 'composer--busy' : ''} ${imageAttachments.dragging ? 'composer--image-dragging' : ''}`}
        {...imageAttachments.dragHandlers}
      >
        {imageAttachments.dragging ? <div className="composer-drop-feedback" aria-hidden="true"><Paperclip size={18} />{t('composer.drop')}</div> : null}
        <div className="composer-input">
          <textarea
            ref={textareaRef}
            value={value}
            disabled={disabled || loading}
            rows={2}
            placeholder={disabled ? t('composer.placeholder.noProject') : loading ? t('composer.placeholder.loading') : submitting ? t('composer.placeholder.starting', { name: shortName }) : t('composer.placeholder.ask', { name: shortName })}
            aria-label={t('composer.input.aria', { name: shortName })}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(menu && suggestions.length)}
            aria-controls={menu ? menuId : undefined}
            aria-activedescendant={menu && suggestions.length ? `${menuId}-option-${activeSuggestion}` : undefined}
            onChange={(event) => { setValue(event.target.value); setCaret({ value: event.target.value, position: event.target.selectionStart }) }}
            onSelect={(event) => setCaret({ value: event.currentTarget.value, position: event.currentTarget.selectionStart })}
            onPaste={(event) => {
              const files = [...event.clipboardData.items]
                .filter((item) => item.kind === 'file')
                .flatMap((item) => {
                  const file = item.getAsFile()
                  return file ? [file] : []
                })
              if (!files.length) return
              const pastedText = event.clipboardData.getData('text/plain')
              event.preventDefault()
              if (pastedText) insertAtCaret(event.currentTarget, pastedText)
              void imageAttachments.ingest(files)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace') acceptedMentionRef.current = null
              if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                setActiveSuggestion((current) => (event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length))
                return
              }
              if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && menu && suggestions.length) {
                event.preventDefault()
                chooseSuggestion(activeSuggestion)
                return
              }
              const intent = messageActionForKey(
                {
                  key: event.key,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  altKey: event.altKey,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                },
                messageEnterAction,
              )
              if (intent) {
                event.preventDefault()
                void submit(intent)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setMenu(null)
              }
            }}
          />
        </div>
        {menu && suggestions.length ? (
          <div ref={menuRef} id={menuId} className="composer-menu" role="listbox" aria-label={menu === 'command' ? t('composer.menu.commands') : menu === 'mention' ? t('composer.menu.mentions') : t('composer.addContext')}>
            {suggestions.map((suggestion, index) => (
              <button
                id={`${menuId}-option-${index}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={activeSuggestion === index}
                className={activeSuggestion === index ? 'is-active' : ''}
                key={suggestion.key}
                onMouseEnter={() => setActiveSuggestion(index)}
                onClick={suggestion.choose}
              >
                {suggestion.icon}
                <span>
                  <strong>{suggestion.label}</strong>
                  <small>{suggestion.detail}</small>
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {annotationsOpen && annotations.length ? (
          <div className="composer-annotations" role="region" aria-label={t('composer.annotations.region')}>
            {annotations.map((annotation, index) => {
              return (
                <div className="composer-annotation" key={annotation.id}>
                  <span className="composer-annotation__badge" aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className="composer-annotation__body">
                    <p>{annotation.comment}</p>
                    {annotation.stale ? <small>{t('composer.annotations.stale')}</small> : null}
                  </div>
                  <button type="button" aria-label={t('composer.annotations.remove', { index: index + 1 })} onClick={() => onRemoveAnnotation(annotation.id)}>
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}
        {terminalSelectionOpen && terminalSelection?.text ? (
          <div className="composer-terminal-selection" role="region" aria-label={t('composer.terminal.region')}>
            <div>
              <SquareTerminal size={14} aria-hidden="true" />
              <strong>{terminalSelection.label}</strong>
              {terminalSelection.truncated ? <small>{t('composer.terminal.truncated')}</small> : null}
            </div>
            <pre>{terminalSelection.text}</pre>
          </div>
        ) : null}
        {images.length || unsupportedFiles.length || annotations.length || terminalSelection?.text ? (
          <div className="composer-attachments" aria-label={t('composer.attachments.label')}>
            {annotations.length ? (
              <div className="composer-attachment composer-attachment--annotations" title={t('composer.annotations.title', { count: annotations.length })}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={annotationsOpen}
                  aria-label={t('composer.annotations.inspect', { count: annotations.length })}
                  onClick={() => setAnnotationsOpen((open) => !open)}
                >
                  <MessageCirclePlus size={13} />
                  <span>{annotations.length}</span>
                  <ChevronDown size={11} className={annotationsOpen ? 'is-open' : ''} />
                </button>
                <button
                  type="button"
                  className="composer-attachment__clear"
                  aria-label={t('composer.annotations.clear')}
                  onClick={() => {
                    setAnnotationsOpen(false)
                    onClearAnnotations()
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            ) : null}
            {terminalSelection?.text ? (
              <div className="composer-attachment composer-attachment--terminal has-selection" title={t('composer.terminal.title', { source: terminalSelection.label })}>
                <button
                  type="button"
                  className="composer-attachment__expand"
                  aria-expanded={terminalSelectionOpen}
                  aria-label={t('composer.terminal.inspect', { source: terminalSelection.label })}
                  onClick={() => setTerminalSelectionOpen((open) => !open)}
                >
                  <SquareTerminal size={13} />
                  <span>{terminalSelection.label}</span>
                  <small>{t('composer.terminal.selected')}</small><ChevronDown size={11} className={terminalSelectionOpen ? 'is-open' : ''} />
                </button>
                <button type="button" className="composer-attachment__clear" aria-label={t('composer.terminal.clear')} onClick={onClearTerminalSelection}><X size={12} /></button>
              </div>
            ) : null}
            {images.map((image) => (
              <div className="composer-attachment" key={image.id}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                <span>
                  <ImageIcon size={12} />
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={t('composer.attachment.remove', { name: image.name })}
                  onClick={() => imageAttachments.remove(image.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {unsupportedFiles.map((file) => (
              <div className="composer-attachment" key={file.id}>
                <span>
                  <Paperclip size={12} />
                  {file.name}
                </span>
                <button
                  type="button"
                  aria-label={t('composer.attachment.remove', { name: file.name })}
                  onClick={() => imageAttachments.remove(file.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {attachmentError ? (
          <p className="composer-attachment-error" role="alert">
            {attachmentError}
          </p>
        ) : null}
        <p id={imageStatusId} className="sr-only" role="status" aria-live="polite">
          {imageAttachments.dragging ? t('composer.status.drop') : processingImages ? t('composer.status.adding') : images.length + unsupportedFiles.length ? t('composer.status.filesAttached', { count: images.length + unsupportedFiles.length }) : ''}
        </p>
        <div className="composer__footer">
          <div className="composer__controls">
            <IconButton
              label={t('composer.addContext')}
              data-composer-menu-trigger
              aria-expanded={menu === 'add'}
              aria-controls={menu === 'add' ? menuId : undefined}
              onClick={() => {
                setMenu((current) => (current === 'add' ? null : 'add'))
                requestAnimationFrame(() => textareaRef.current?.focus())
              }}
            >
              <Plus size={17} />
            </IconButton>
            <input
              ref={fileInputRef}
              className="sr-only"
              type="file"
              multiple
              tabIndex={-1}
              aria-label={t('composer.chooseFiles')}
              aria-describedby={imageStatusId}
              disabled={disabled || loading || submitting}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                event.currentTarget.value = ''
                void imageAttachments.ingest(files)
              }}
            />
            <ModelPicker value={model} modelsByProvider={modelsByProvider} providers={providers} onChange={onModelChange} />
            <ExecutingModelChip executingModel={executingModel} />
            <SelectControl label={t('composer.effort.label')} compact icon={<Gauge size={12} />} value={effort} onChange={(event) => onEffortChange(event.target.value as PrimeThinkingLevel)}>
              {reasoningLevels.map((level) => (
                <option key={level} value={level}>
                  {t(reasoningLabels[level])}
                </option>
              ))}
            </SelectControl>
            {fastSupported ? (
              <button
                type="button"
                className={`fast-mode-toggle ${fast ? 'is-active' : ''}`}
                aria-pressed={fast}
                disabled={!fastAvailable}
                title={fastAvailable ? t('composer.fast.tooltipAvailable', { name: agentName }) : t('composer.fast.tooltipUnavailable', { name: agentName })}
                onClick={() => onFastChange(!fast)}
              >
                <Zap size={12} fill={fast ? 'currentColor' : 'none'} /> <span className="fast-mode-toggle__label">{t('composer.fast.label')}</span>
              </button>
            ) : null}
            <CheckoutPicker catalog={checkoutCatalog} fallbackLabel={checkoutLabel} loading={checkoutsLoading} onExecute={onExecuteCheckout} />
          </div>
          <div className="composer__actions">
            {dictation.state === 'connecting' || dictation.state === 'recording' ? <button type="button" className="context-usage-dial context-usage-dial--cancel" aria-label={t('dictation.cancel')} title={t('dictation.cancel')} onClick={dictation.cancel}><X size={14} /></button> : <span
              className={`context-usage-dial ${contextPercent === null ? 'is-unavailable' : contextPercent >= 95 ? 'is-critical' : contextPercent >= 80 ? 'is-warning' : ''}`}
              role="meter"
              tabIndex={0}
              aria-label={t('composer.context.usage')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent === null ? undefined : Math.round(contextPercent)}
              aria-valuetext={contextLabel}
              title={contextLabel}
              data-tooltip={contextLabel}
              style={contextStyle}
            >
              <span>{contextDisplayPercent ?? '—'}</span>
            </span>}
            <button
              type="button"
              className={`dictation-button ${dictation.state === 'recording' ? 'is-recording' : ''}`}
              aria-label={dictation.state === 'recording' ? t('dictation.action.stop') : dictation.state === 'connecting' ? t('dictation.action.connecting') : dictation.state === 'transcribing' ? t('dictation.action.transcribing') : t('dictation.action.start')}
              disabled={!voice || loading || disabled || submitting || dictation.state === 'connecting' || dictation.state === 'transcribing'}
              onClick={() => { if (dictation.state === 'recording') void finishDictation(false); else void dictation.start() }}
            >
              {dictation.state === 'recording' ? <Square size={10} fill="currentColor" /> : dictation.state === 'connecting' || dictation.state === 'transcribing' ? <LoaderCircle className="is-spinning" size={15} /> : <Mic size={15} />}
            </button>
            {dictation.state === 'recording' ? (
              <button type="button" className="send-button" aria-label={t('composer.send.transcribe')} onClick={() => void finishDictation(true)}><ArrowUp size={17} /></button>
            ) : busy ? (
              <button type="button" className="send-button send-button--stop" aria-label={t('composer.stop', { name: shortName })} onClick={() => void onStop()}>
                <Square size={10} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="send-button"
                aria-label={t('composer.send')}
                disabled={(!value.trim() && images.length === 0 && unsupportedFiles.length === 0 && annotations.length === 0 && !terminalSelection?.text) || processingImages || submitting || loading || disabled}
                onClick={() => void submit()}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="composer-note">{t('composer.note', { name: shortName })}</p>
    </div>
  )
})
