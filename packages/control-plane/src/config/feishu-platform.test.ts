import { describe, expect, it } from 'vitest'
import { resolveFeishuPlatformApps } from './feishu-platform.js'

describe('resolveFeishuPlatformApps', () => {
  it('supports either regional Login App independently', () => {
    expect(
      resolveFeishuPlatformApps({
        FEISHU_PLATFORM_APP_ID: undefined,
        FEISHU_PLATFORM_APP_SECRET: undefined,
        LARK_PLATFORM_APP_ID: 'cli_lark',
        LARK_PLATFORM_APP_SECRET: 'secret'
      })
    ).toEqual({ lark: { appId: 'cli_lark', appSecret: 'secret' } })
  })

  it('fails fast for a partial regional pair', () => {
    expect(() =>
      resolveFeishuPlatformApps({
        FEISHU_PLATFORM_APP_ID: 'cli_feishu',
        FEISHU_PLATFORM_APP_SECRET: undefined,
        LARK_PLATFORM_APP_ID: undefined,
        LARK_PLATFORM_APP_SECRET: undefined
      })
    ).toThrow(/FEISHU_PLATFORM_APP_SECRET/)
  })
})
