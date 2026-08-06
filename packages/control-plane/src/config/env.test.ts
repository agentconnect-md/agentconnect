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

  it('keeps the internal OIDC endpoint separate from the public token issuer', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://agentconnect:agentconnect@localhost:5432/agentconnect',
      API_KEY_PEPPER: 'a'.repeat(32),
      OIDC_ISSUER: 'http://localhost:3001/oidc',
      OIDC_INTERNAL_ENDPOINT: 'http://logto:3001/oidc'
    })

    expect(config.OIDC_ISSUER).toBe('http://localhost:3001/oidc')
    expect(config.OIDC_INTERNAL_ENDPOINT).toBe('http://logto:3001/oidc')
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
