import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { AppConfig } from './env.js'

export interface FeishuPlatformAppConfig {
  appId: string
  appSecret: string
}

export type FeishuPlatformApps = Partial<Record<FeishuRegion, FeishuPlatformAppConfig>>

type EnvSlice = Pick<
  AppConfig,
  'FEISHU_PLATFORM_APP_ID' | 'FEISHU_PLATFORM_APP_SECRET' | 'LARK_PLATFORM_APP_ID' | 'LARK_PLATFORM_APP_SECRET'
>

/** Resolve each regional app independently. A partial pair is always a deploy
 * mistake; no pairs is the self-hosted/off default. */
export function resolveFeishuPlatformApps(config: EnvSlice): FeishuPlatformApps {
  const apps: FeishuPlatformApps = {}
  for (const [region, idKey, secretKey] of [
    ['feishu', 'FEISHU_PLATFORM_APP_ID', 'FEISHU_PLATFORM_APP_SECRET'],
    ['lark', 'LARK_PLATFORM_APP_ID', 'LARK_PLATFORM_APP_SECRET']
  ] as const) {
    const appId = config[idKey]
    const appSecret = config[secretKey]
    if (!appId && !appSecret) continue
    const missing = [!appId && idKey, !appSecret && secretKey].filter(Boolean)
    if (missing.length > 0) {
      throw new Error(`feishu platform app config is partial — missing ${missing.join(', ')} (set both or none)`)
    }
    apps[region] = { appId: appId!, appSecret: appSecret! }
  }
  return apps
}
