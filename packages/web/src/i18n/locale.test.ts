import { describe, expect, it } from 'vitest'
import { negotiateLocale } from './locale'

describe('negotiateLocale', () => {
  it('prefers a valid cookie over the request header', () => {
    expect(negotiateLocale('en', 'zh-CN')).toBe('en')
  })

  it('matches exact, alias, script and weighted language tags', () => {
    expect(negotiateLocale(undefined, 'zh-SG')).toBe('zh-CN')
    expect(negotiateLocale(undefined, 'zh-Hans-SG')).toBe('zh-CN')
    expect(negotiateLocale(undefined, 'fr;q=0.8, zh;q=0.9')).toBe('zh-CN')
    expect(negotiateLocale(undefined, 'en-US')).toBe('en')
  })

  it('does not map Traditional Chinese to Simplified Chinese', () => {
    expect(negotiateLocale(undefined, 'zh-TW')).toBe('en')
    expect(negotiateLocale(undefined, 'zh-Hant-HK')).toBe('en')
  })

  it('ignores invalid preferences', () => {
    expect(negotiateLocale('not a locale', 'fr;q=0, *')).toBe('en')
  })
})
