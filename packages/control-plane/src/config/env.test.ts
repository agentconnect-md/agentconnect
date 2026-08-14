import { describe, it, expect } from 'vitest'
import { corsWebOrigin, loadBootstrapConfig, loadConfig, resolveWebAppUrl } from './env.js'

describe('loadBootstrapConfig', () => {
  it('does not parse DB-owned runtime fields before the deployment row can be read', () => {
    expect(
      loadBootstrapConfig({
        DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
        OIDC_ISSUER: 'not-a-url',
        GITHUB_APP_ID: 'not-a-number',
        WAITLIST_MODE: 'not-a-boolean'
      })
    ).toMatchObject({
      DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
      SECRET_CIPHER: 'none'
    })
  })
})

describe('loadConfig', () => {
  it('derives login topology without enabling an unconfigured Management API', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
      API_KEY_PEPPER: 'a'.repeat(32),
      LOGTO_ENDPOINT: 'https://tenant.example.com/'
    })

    expect(config.OIDC_ISSUER).toBe('https://tenant.example.com/oidc')
    expect(config.LOGTO_MGMT_ENDPOINT).toBeUndefined()
  })

  it('derives the Management API endpoint when its credentials are configured', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
      API_KEY_PEPPER: 'a'.repeat(32),
      LOGTO_ENDPOINT: 'https://tenant.example.com/',
      LOGTO_MGMT_APP_ID: 'client-id',
      LOGTO_MGMT_APP_SECRET: 'client-secret'
    })

    expect(config.LOGTO_MGMT_ENDPOINT).toBe('https://tenant.example.com')
  })
})

describe('session-access cache knobs (session-access-cold-visit.md §2.3)', () => {
  const base = {
    DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
    API_KEY_PEPPER: 'a'.repeat(32)
  }

  it('defaults land when unset', () => {
    const config = loadConfig(base)
    expect(config.SESSION_ACCESS_RECHECK_SEC).toBe(120)
    expect(config.SESSION_ACCESS_PUBLIC_TTL_SEC).toBe(3600)
    expect(config.SESSION_ACCESS_IDENTITY_TTL_SEC).toBe(120)
  })

  it('coerces explicit values inside the bounds', () => {
    const config = loadConfig({
      ...base,
      SESSION_ACCESS_RECHECK_SEC: '60',
      SESSION_ACCESS_PUBLIC_TTL_SEC: '900',
      SESSION_ACCESS_IDENTITY_TTL_SEC: '3600'
    })
    expect(config.SESSION_ACCESS_RECHECK_SEC).toBe(60)
    expect(config.SESSION_ACCESS_PUBLIC_TTL_SEC).toBe(900)
    expect(config.SESSION_ACCESS_IDENTITY_TTL_SEC).toBe(3600)
  })

  it.each([
    ['SESSION_ACCESS_RECHECK_SEC', '29'],
    ['SESSION_ACCESS_RECHECK_SEC', '601'],
    ['SESSION_ACCESS_PUBLIC_TTL_SEC', '299'],
    ['SESSION_ACCESS_PUBLIC_TTL_SEC', '14401'],
    ['SESSION_ACCESS_IDENTITY_TTL_SEC', '29'],
    ['SESSION_ACCESS_IDENTITY_TTL_SEC', '86401']
  ])('rejects %s outside its bounds (%s)', (key, value) => {
    expect(() => loadConfig({ ...base, [key]: value })).toThrow()
  })

  it('leaves the identity lease independent of the recheck threshold — they are separate axes', () => {
    const config = loadConfig({ ...base, SESSION_ACCESS_RECHECK_SEC: '600', SESSION_ACCESS_IDENTITY_TTL_SEC: '30' })
    expect(config.SESSION_ACCESS_IDENTITY_TTL_SEC).toBe(30)
  })

  it('rejects a public serving lease shorter than the recheck threshold', () => {
    expect(() =>
      loadConfig({ ...base, SESSION_ACCESS_RECHECK_SEC: '600', SESSION_ACCESS_PUBLIC_TTL_SEC: '300' })
    ).toThrow(/SESSION_ACCESS_PUBLIC_TTL_SEC/)
  })
})

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
