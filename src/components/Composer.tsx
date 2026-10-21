import { ComposerQueue } from './composer/ComposerQueue'
import { ComposerAttachments } from './composer/ComposerAttachments'
import { useComposerSuggestions } from '@/hooks/useComposerSuggestions'
import { HARNESS_AGENT_NAMES, HARNESS_SHORT_NAMES } from '@/lib/harness'
import { THINKING_LEVEL_KEYS } from '@/lib/thinking-levels'
import { rpcRequestFrameBytes, RPC_WRITE_FRAME_LIMIT_BYTES } from '@/lib/rpc-frame'
import { ArrowUp, Gauge, LoaderCircle, Mic, Paperclip, Plus, Square, X, Zap } from 'lucide-react'
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
import { clearComposerDraft, readComposerDraft, restoreComposerDraft, saveComposerDraft } from '@/lib/composer-draft'
import { contextDialLabel } from '@/lib/format-cost'
import { useI18n } from '@/lib/i18n'
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
  const agentName = HARNESS_AGENT_NAMES[harness]
  const shortName = HARNESS_SHORT_NAMES[harness]
  const [value, setValue] = useState(() => readComposerDraft(draftKey ?? 'default')?.text ?? '')
  const imageAttachments = useComposerImages({ shortName })
  const { images, imagesRef, unsupportedFiles, unsupportedFilesRef, error: attachmentError, setError: setAttachmentError, processing: processingImages } = imageAttachments
  const dictation = useDictation(voice, transcriptionProvider, setAttachmentError)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageStatusId = useId()
  const annotationsRef = useRef(annotations)
  annotationsRef.current = annotations
  const mountedRef = useRef(true)
  const restoredDraftRef = useRef(false)
  const enabledSkills = useMemo(() => skills.filter((skill) => skill.enabled), [skills])
  const { menu, setMenu, sessionReferenceIds, activeSuggestion, setActiveSuggestion, menuId, menuRef, suggestions, setCaret, insertAtCaret, handleSuggestionKey } = useComposerSuggestions({ value, setValue, textareaRef, sessions, enabledSkills, harness, onChooseFiles: () => fileInputRef.current?.click() })

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
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])





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
      <ComposerQueue queuedMessages={queuedMessages} harnessQueuedMessageCount={harnessQueuedMessageCount} agentName={agentName} onSendNow={sendQueuedMessageImmediately} onEdit={(queued) => { onEditQueuedMessage?.(queued); setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${queued.text}` : queued.text); requestAnimationFrame(() => textareaRef.current?.focus()) }} onDelete={onDeleteQueuedMessage} />
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
              if (handleSuggestionKey(event)) return
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
        <ComposerAttachments annotations={annotations} terminalSelection={terminalSelection} images={images} unsupportedFiles={unsupportedFiles} onRemoveAnnotation={onRemoveAnnotation} onClearAnnotations={onClearAnnotations} onClearTerminalSelection={onClearTerminalSelection} onRemoveFile={imageAttachments.remove} />
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
                  {t(THINKING_LEVEL_KEYS[level])}
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
