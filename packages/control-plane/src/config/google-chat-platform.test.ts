import { describe, expect, it } from 'vitest'
import { resolveGoogleChatPlatformAppConfig } from './google-chat-platform.js'

const FULL = {
  GOOGLE_CHAT_PLATFORM_PROJECT_ID: 'example-project',
  GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER: '123456789012',
  GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}'
}

describe('resolveGoogleChatPlatformAppConfig', () => {
  it('is absent when nothing is set, leaving only per-agent apps', () => {
    expect(
      resolveGoogleChatPlatformAppConfig({
        GOOGLE_CHAT_PLATFORM_PROJECT_ID: undefined,
        GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER: undefined,
        GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: undefined
      })
    ).toBeUndefined()
  })

  it('resolves all three into the deployment app, serving one Workspace organization by default', () => {
    expect(resolveGoogleChatPlatformAppConfig(FULL)).toEqual({
      projectId: 'example-project',
      projectNumber: '123456789012',
      serviceAccountKey: '{"type":"service_account"}',
      multiTenant: false
    })
    expect(resolveGoogleChatPlatformAppConfig({ ...FULL, GOOGLE_CHAT_PLATFORM_MULTI_TENANT: false })?.multiTenant).toBe(
      false
    )
  })

  it('carries the multi-tenant switch', () => {
    expect(resolveGoogleChatPlatformAppConfig({ ...FULL, GOOGLE_CHAT_PLATFORM_MULTI_TENANT: true })?.multiTenant).toBe(
      true
    )
  })

  it('fails fast on a partial set, naming the missing keys without echoing the key', () => {
    expect(() =>
      resolveGoogleChatPlatformAppConfig({ ...FULL, GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: undefined })
    ).toThrowError(/GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY/)
    expect(() =>
      resolveGoogleChatPlatformAppConfig({
        ...FULL,
        GOOGLE_CHAT_PLATFORM_PROJECT_ID: undefined,
        GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER: undefined
      })
    ).toThrowError(/^(?!.*service_account).*GOOGLE_CHAT_PLATFORM_PROJECT_ID.*GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER/)
  })
})
