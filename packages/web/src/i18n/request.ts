import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import english from '../../messages/en.json'
import { LOCALE_COOKIE, localeList, type Locale } from './config'
import { negotiateLocale } from './locale'

type Messages = typeof english
type MessageRecord = Record<string, unknown>

const loaders = Object.fromEntries(
  localeList.map((locale) => [locale, () => import(`../../messages/${locale}.json`).then((module) => module.default)])
) as Record<Locale, () => Promise<Messages>>

function mergeRecords(source: MessageRecord, translated: MessageRecord): MessageRecord {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === 'object' && value !== null
        ? mergeRecords(value as MessageRecord, (translated[key] ?? {}) as MessageRecord)
        : (translated[key] ?? value)
    ])
  )
}

function mergeMessages(source: Messages, translated: Partial<Messages>): Messages {
  return mergeRecords(source, translated as MessageRecord) as Messages
}

function englishFallback(path: string): string | undefined {
  let value: unknown = english
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return typeof value === 'string' ? value : undefined
}

export default getRequestConfig(async () => {
  const locale = negotiateLocale((await cookies()).get(LOCALE_COOKIE)?.value, (await headers()).get('accept-language'))
  const messages = mergeMessages(english, await loaders[locale]())

  return {
    locale,
    messages,
    onError(error) {
      if (process.env.NODE_ENV === 'test') throw error
      if (process.env.NODE_ENV !== 'production') console.error(error)
    },
    getMessageFallback({ key, namespace }) {
      const path = namespace ? `${namespace}.${key}` : key
      return englishFallback(path) ?? path
    }
  }
})

export { mergeMessages }
