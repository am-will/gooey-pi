import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react'
import type { LocalePreference } from '@/types/api'

type Message = string | { one: string; other: string }
type MessageValues = Record<string, string | number>

const englishCatalog = {
  'common.reload': 'Reload GooeyPi',
  'nav.projects': 'Projects',
  'nav.activity': 'Activity',
  'nav.scheduled': 'Scheduled',
  'nav.capabilities': 'Capabilities',
  'nav.settings': 'Settings',
  'projects.sort': 'Sort projects',
  'projects.sort.menu': 'Project sort order',
  'projects.sort.recent': 'Recent activity',
  'projects.sort.alphabetical': 'Alphabetical',
  'projects.pin': 'Pin project',
  'projects.unpin': 'Unpin project',
  'settings.sections': 'Settings sections',
  'settings.general': 'General',
  'settings.appearance': 'Appearance',
  'settings.harness': 'Harness',
  'settings.providers': 'Providers',
  'settings.voice': 'Voice',
  'settings.pets': 'Pets',
  'settings.browser': 'Browser',
  'settings.terminal': 'Terminal',
  'settings.privacy': 'Privacy',
  'settings.about': 'About',
  'appearance.title': 'Appearance',
  'appearance.description': 'Keep the workspace comfortable in any environment.',
  'appearance.theme.title': 'Theme',
  'appearance.theme.system': 'System',
  'appearance.theme.light': 'Light',
  'appearance.theme.dark': 'Dark',
  'appearance.language.title': 'Language',
  'appearance.language.label': 'Interface language',
  'appearance.language.description': 'Choose the language used in GooeyPi.',
  'appearance.language.system': 'System default',
  'appearance.language.english': 'English',
  'appearance.language.chinese': 'Simplified Chinese',
  'appearance.language.available': { one: '{count} language available', other: '{count} languages available' },
  'appearance.text.title': 'Text size',
  'appearance.text.label': 'Interface text',
  'appearance.text.description': 'Increase readability while keeping the workspace proportions intact.',
  'appearance.text.aria': 'Interface text size',
  'appearance.text.smaller': 'Smaller',
  'appearance.text.default': 'Default',
  'appearance.text.larger': 'Larger',
  'appearance.motion.title': 'Motion',
  'appearance.motion.reduce': 'Reduce interface motion',
  'appearance.motion.description': 'Minimize panel transitions and animated status indicators.',
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof englishCatalog
export type ResolvedLocale = 'en' | 'zh-CN'

const simplifiedChineseCatalog: Partial<Record<MessageKey, Message>> = {
  'nav.projects': '项目',
  'nav.activity': '动态',
  'nav.scheduled': '定时任务',
  'nav.capabilities': '功能',
  'nav.settings': '设置',
  'projects.sort': '项目排序',
  'projects.sort.menu': '项目排序方式',
  'projects.sort.recent': '最近活动',
  'projects.sort.alphabetical': '按字母顺序',
  'projects.pin': '置顶项目',
  'projects.unpin': '取消置顶',
  'settings.sections': '设置分类',
  'settings.general': '常规',
  'settings.appearance': '外观',
  'settings.harness': '运行环境',
  'settings.providers': '服务商',
  'settings.voice': '语音',
  'settings.pets': '宠物',
  'settings.browser': '浏览器',
  'settings.terminal': '终端',
  'settings.privacy': '隐私',
  'settings.about': '关于',
  'appearance.title': '外观',
  'appearance.description': '在任何环境中都能舒适地使用工作区。',
  'appearance.theme.title': '主题',
  'appearance.theme.system': '跟随系统',
  'appearance.theme.light': '浅色',
  'appearance.theme.dark': '深色',
  'appearance.language.title': '语言',
  'appearance.language.label': '界面语言',
  'appearance.language.description': '选择 GooeyPi 界面所使用的语言。',
  'appearance.language.system': '跟随系统',
  'appearance.language.english': '英语',
  'appearance.language.chinese': '简体中文',
  'appearance.language.available': { one: '支持 {count} 种语言', other: '支持 {count} 种语言' },
  'appearance.text.title': '文本大小',
  'appearance.text.label': '界面文本',
  'appearance.text.description': '提高可读性，同时保持工作区比例不变。',
  'appearance.text.aria': '界面文本大小',
  'appearance.text.smaller': '较小',
  'appearance.text.default': '默认',
  'appearance.text.larger': '较大',
  'appearance.motion.title': '动效',
  'appearance.motion.reduce': '减少界面动效',
  'appearance.motion.description': '尽量减少面板过渡和动态状态指示。',
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages.length ? navigator.languages : [navigator.language]
}

export function resolveLocale(preference: LocalePreference, languages: readonly string[] = browserLanguages()): ResolvedLocale {
  if (preference !== 'system') return preference
  for (const language of languages) {
    const normalized = language.toLowerCase()
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-sg' || normalized === 'zh-hans' || normalized.startsWith('zh-hans-')) return 'zh-CN'
  }
  return 'en'
}

export function translate(locale: ResolvedLocale, key: MessageKey, values: MessageValues = {}): string {
  const translated = locale === 'zh-CN' ? simplifiedChineseCatalog[key] : undefined
  const message = translated ?? englishCatalog[key]
  const template = typeof message === 'string'
    ? message
    : message[new Intl.PluralRules(locale).select(Number(values.count)) === 'one' ? 'one' : 'other']
  return Object.entries(values).reduce((result, [name, value]) => result.split(`{${name}}`).join(String(value)), template)
}

interface I18nContextValue {
  locale: ResolvedLocale
  t(key: MessageKey, values?: MessageValues): string
}

const I18nContext = createContext<I18nContextValue>({ locale: 'en', t: (key, values) => translate('en', key, values) })

export function I18nProvider({ preference, children }: { preference: LocalePreference; children: ReactNode }) {
  const locale = resolveLocale(preference)
  const value = useMemo<I18nContextValue>(() => ({ locale, t: (key, values) => translate(locale, key, values) }), [locale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
