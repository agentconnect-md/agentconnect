export const LOCALES = {
  en: { label: 'English', htmlLang: 'en', dir: 'ltr', cronstrue: 'en', status: 'source' },
  'zh-CN': { label: '简体中文', htmlLang: 'zh-CN', dir: 'ltr', cronstrue: 'zh_CN', status: 'draft' }
} as const

export type Locale = keyof typeof LOCALES

export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'ac-locale'

export const LOCALE_ALIASES: Readonly<Record<string, Locale>> = {
  zh: 'zh-CN',
  'zh-Hans': 'zh-CN',
  'zh-SG': 'zh-CN'
}

export const localeList = Object.keys(LOCALES) as Locale[]

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(LOCALES, value)
}
