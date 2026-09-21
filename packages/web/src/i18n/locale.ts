import { DEFAULT_LOCALE, isLocale, LOCALE_ALIASES, type Locale } from './config'

function canonicalize(value: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(value)[0]
  } catch {
    return undefined
  }
}

function resolveTag(value: string): Locale | undefined {
  const tag = canonicalize(value)
  if (!tag) return undefined
  if (isLocale(tag)) return tag

  const parsed = new Intl.Locale(tag)
  const candidates = [
    tag,
    parsed.script ? `${parsed.language}-${parsed.script}` : undefined,
    // A declared script must not reach the other one through a region alias:
    // `zh-Hant-SG` is Traditional, while `zh-SG` is Simplified.
    parsed.script || !parsed.region ? undefined : `${parsed.language}-${parsed.region}`
  ]
  for (const candidate of candidates) {
    if (candidate && LOCALE_ALIASES[candidate]) return LOCALE_ALIASES[candidate]
  }

  return isLocale(parsed.language) ? parsed.language : undefined
}

export function negotiateLocale(cookieLocale?: string | null, acceptLanguage?: string | null): Locale {
  const explicit = cookieLocale && resolveTag(cookieLocale)
  if (explicit) return explicit

  const requested = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.find((param) => param.trim().startsWith('q='))?.split('=')[1]
      return { tag, quality: q === undefined ? 1 : Number(q) }
    })
    .filter(({ tag, quality }) => tag && tag !== '*' && Number.isFinite(quality) && quality > 0)
    .sort((a, b) => b.quality - a.quality)

  for (const { tag } of requested) {
    const locale = resolveTag(tag)
    if (locale) return locale
  }
  return DEFAULT_LOCALE
}
