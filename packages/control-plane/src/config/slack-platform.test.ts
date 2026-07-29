import { describe, expect, it } from 'vitest'
import { resolveSlackPlatformAppConfig } from './slack-platform.js'

const FULL = {
  SLACK_PLATFORM_APP_ID: 'A0PLATFORM',
  SLACK_PLATFORM_CLIENT_ID: '123.456',
  SLACK_PLATFORM_CLIENT_SECRET: 'shh-client',
  SLACK_PLATFORM_SIGNING_SECRET: 'shh-signing'
}

describe('resolveSlackPlatformAppConfig', () => {
  it('is absent (undefined) when nothing is set — the self-hosted default', () => {
    expect(
      resolveSlackPlatformAppConfig({
        SLACK_PLATFORM_APP_ID: undefined,
        SLACK_PLATFORM_CLIENT_ID: undefined,
        SLACK_PLATFORM_CLIENT_SECRET: undefined,
        SLACK_PLATFORM_SIGNING_SECRET: undefined
      })
    ).toBeUndefined()
  })

  it('resolves all four into the config object', () => {
    expect(resolveSlackPlatformAppConfig(FULL)).toEqual({
      appId: 'A0PLATFORM',
      clientId: '123.456',
      clientSecret: 'shh-client',
      signingSecret: 'shh-signing'
    })
  })

  it('fails fast on a partial set, naming the missing vars', () => {
    expect(() => resolveSlackPlatformAppConfig({ ...FULL, SLACK_PLATFORM_SIGNING_SECRET: undefined })).toThrowError(
      /SLACK_PLATFORM_SIGNING_SECRET/
    )
    expect(() =>
      resolveSlackPlatformAppConfig({
        SLACK_PLATFORM_APP_ID: 'A1',
        SLACK_PLATFORM_CLIENT_ID: undefined,
        SLACK_PLATFORM_CLIENT_SECRET: undefined,
        SLACK_PLATFORM_SIGNING_SECRET: undefined
      })
    ).toThrowError(/SLACK_PLATFORM_CLIENT_ID.*SLACK_PLATFORM_CLIENT_SECRET.*SLACK_PLATFORM_SIGNING_SECRET/)
  })
})
