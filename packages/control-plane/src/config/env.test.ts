import { describe, it, expect } from 'vitest'
import { corsWebOrigin, resolveWebAppUrl } from './env.js'

describe('corsWebOrigin', () => {
  it('returns a single concrete origin verbatim', () => {
    expect(corsWebOrigin('https://app.example.com')).toBe('https://app.example.com')
  })

  it('takes the first concrete origin from a comma-separated list', () => {
    expect(corsWebOrigin('https://app.example.com, https://preview.example.com')).toBe('https://app.example.com')
  })

  it('skips the wildcard and non-http entries, falling to the first usable origin', () => {
    expect(corsWebOrigin('*')).toBeUndefined()
    expect(corsWebOrigin('*, https://app.example.com')).toBe('https://app.example.com')
    expect(corsWebOrigin('not a url, https://app.example.com')).toBe('https://app.example.com')
  })

  it('is undefined for unset / empty / no-usable-origin values', () => {
    expect(corsWebOrigin(undefined)).toBeUndefined()
    expect(corsWebOrigin('')).toBeUndefined()
    expect(corsWebOrigin('   ')).toBeUndefined()
    expect(corsWebOrigin('ftp://x')).toBeUndefined()
  })
})

describe('resolveWebAppUrl', () => {
  const CP = 'https://api.example.com'
  const WEB = 'https://app.example.com'

  it('prefers an explicit PUBLIC_WEB_URL over everything', () => {
    expect(resolveWebAppUrl({ PUBLIC_WEB_URL: WEB, CORS_ORIGIN: 'https://other', PUBLIC_CP_URL: CP })).toBe(WEB)
  })

  it('falls back to a concrete CORS_ORIGIN when PUBLIC_WEB_URL is unset (the two-origin deploy)', () => {
    // A split-origin setup may already identify the browser origin through CORS.
    expect(resolveWebAppUrl({ CORS_ORIGIN: WEB, PUBLIC_CP_URL: CP })).toBe(WEB)
  })

  it('falls through to PUBLIC_CP_URL when CORS_ORIGIN names no concrete origin', () => {
    expect(resolveWebAppUrl({ CORS_ORIGIN: '*', PUBLIC_CP_URL: CP })).toBe(CP)
    expect(resolveWebAppUrl({ PUBLIC_CP_URL: CP })).toBe(CP)
  })

  it('is undefined when nothing is configured (daemon uses local config or its local default)', () => {
    expect(resolveWebAppUrl({})).toBeUndefined()
    expect(resolveWebAppUrl({ CORS_ORIGIN: '*' })).toBeUndefined()
  })
})
