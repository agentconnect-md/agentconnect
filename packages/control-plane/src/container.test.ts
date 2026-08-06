/**
 * The composition seam between validated env and the HTTP layer's config slice.
 *
 * It is an explicit field list, and every other test hand-builds `HttpDeps` —
 * including the shared integration harness — so a variable forgotten here reads
 * as unset in production while every focused test still passes. One did.
 */
import { describe, expect, it } from 'vitest'
import { httpServerConfigFrom } from './container.js'
import type { AppConfig } from './config/env.js'

const EXTRAS = { DEFAULT_OWNER_ID: 'owner-1', relayStaleMs: 30_000 }

const appConfig = (over: Partial<AppConfig> = {}): AppConfig =>
  ({ HEARTBEAT_SEC: 10, MISSED_BEATS: 3, WAITLIST_MODE: false, ...over }) as AppConfig

describe('httpServerConfigFrom', () => {
  it('omits optional origins that are unset, rather than passing undefined', () => {
    const projected = httpServerConfigFrom(appConfig(), EXTRAS)
    expect(projected).not.toHaveProperty('PUBLIC_WEB_URL')
    expect(projected).not.toHaveProperty('OIDC_ISSUER')
  })

  it('carries the other optional public origins too', () => {
    const projected = httpServerConfigFrom(
      appConfig({
        PUBLIC_WEB_URL: 'https://console.example.test',
        PUBLIC_CP_URL: 'https://api.example.test',
        OIDC_ISSUER: 'https://auth.example.test'
      }),
      EXTRAS
    )
    expect(projected.PUBLIC_WEB_URL).toBe('https://console.example.test')
    expect(projected.PUBLIC_CP_URL).toBe('https://api.example.test')
    expect(projected.OIDC_ISSUER).toBe('https://auth.example.test')
  })
})
