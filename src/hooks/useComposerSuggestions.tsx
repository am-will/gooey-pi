import { AtSign, Command, MessageCirclePlus, Paperclip } from 'lucide-react'
import { useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent, type RefObject, type SetStateAction } from 'react'
import { useDismissableLayer } from './useDismissableLayer'
import { activeMention, findSessionMentions, mentionLabelKey } from '@/lib/session-mentions'
import { useI18n, type MessageKey } from '@/lib/i18n'
import type { HarnessId, SessionRecord, SkillRecord } from '@/types/api'

interface Options {
  value: string
  setValue: Dispatch<SetStateAction<string>>
  textareaRef: RefObject<HTMLTextAreaElement | null>
  sessions: SessionRecord[]
  enabledSkills: SkillRecord[]
  harness: HarnessId
  onChooseFiles(): void
}

// Command descriptions translate when suggestions render.
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

export function useComposerSuggestions({ value, setValue, textareaRef, sessions, enabledSkills, harness, onChooseFiles }: Options) {
  const { t } = useI18n()
  const [caret, setCaret] = useState<{ value: string; position: number } | null>(null)
  const caretPos = caret?.value === value ? Math.min(caret.position, value.length) : value.length
  const [menu, setMenu] = useState<'add' | 'mention' | 'command' | null>(null)
  const [sessionReferenceIds, setSessionReferenceIds] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const menuId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const acceptedMentionRef = useRef<{ start: number; text: string } | null>(null)
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
  useDismissableLayer(Boolean(menu), (target) => target instanceof Node && Boolean(menuRef.current?.contains(target) || target instanceof Element && target.closest('[data-composer-menu-trigger]')), () => setMenu(null))
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
              { key: 'files', label: t('composer.add.files'), detail: t('composer.add.filesDetail'), icon: <Paperclip size={14} />, choose: () => { setMenu(null); onChooseFiles() } },
              { key: 'mention', label: t('composer.add.mention'), detail: t('composer.add.mentionDetail'), icon: <AtSign size={14} />, choose: () => insert('@') },
            ]
          : []

  useEffect(() => {
    setActiveSuggestion(0)
  }, [menu, value, suggestions.length])
  const chooseSuggestion = (index: number) => suggestions[index]?.choose()

  const handleSuggestionKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === 'Backspace') acceptedMentionRef.current = null
    if (menu && suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      setActiveSuggestion((current) => (event.key === 'ArrowDown' ? (current + 1) % suggestions.length : (current - 1 + suggestions.length) % suggestions.length))
      return true
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.nativeEvent.isComposing && menu && suggestions.length) {
      event.preventDefault()
      chooseSuggestion(activeSuggestion)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMenu(null)
      return true
    }
    return false
  }
  return { menu, setMenu, sessionReferenceIds, activeSuggestion, setActiveSuggestion, menuId, menuRef, suggestions, setCaret, insertAtCaret, handleSuggestionKey }
}
