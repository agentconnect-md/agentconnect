import type { FeishuRegion } from '@agentconnect.md/protocol'
import type { IconStore } from '../icons/icon-store.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from './bot-profile-icon.js'

const REGION_ORIGIN: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
}
const FEISHU_TIMEOUT_MS = 15_000
const FEISHU_ICON_SIZE = 512

interface FeishuApiResponse {
  code?: number
  data?: { url?: string }
}

export type FeishuAppIconSyncer = (
  appId: string,
  appSecret: string,
  region: FeishuRegion,
  agent: BotProfileIconAgent
) => Promise<void>

async function request(fetcher: typeof fetch, url: string, init: RequestInit, operation: string): Promise<Response> {
  try {
    return await fetcher(url, init)
  } catch {
    // Never retain the token exchange body or Authorization header in the
    // error that the best-effort caller writes to application logs.
    throw new Error(`Lark/Feishu ${operation} request failed`)
  }
}

async function responseBody(res: Response): Promise<FeishuApiResponse | null> {
  return (await res.json().catch(() => null)) as FeishuApiResponse | null
}

async function iconPng(agent: BotProfileIconAgent, iconStore?: IconStore): Promise<Buffer> {
  const source = await loadBotProfileIcon(agent, iconStore, FEISHU_ICON_SIZE)
  const { default: sharp } = await import('sharp')
  return sharp(source.bytes).resize(FEISHU_ICON_SIZE, FEISHU_ICON_SIZE, { fit: 'cover' }).png().toBuffer()
}

/**
 * Update a self-built Feishu/Lark application's icon and submit the resulting
 * application version. The app must grant `application:application:patch`;
 * provider review, when required by the tenant, completes asynchronously.
 */
export function createFeishuAppIconSyncer(iconStore?: IconStore, fetcher: typeof fetch = fetch): FeishuAppIconSyncer {
  return async (appId, appSecret, region, agent) => {
    const origin = REGION_ORIGIN[region]
    const tokenRes = await request(
      fetcher,
      `${origin}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
      },
      'credential exchange'
    )
    const tokenBody = (await responseBody(tokenRes)) as (FeishuApiResponse & { tenant_access_token?: string }) | null
    if (!tokenRes.ok || tokenBody?.code !== 0 || !tokenBody.tenant_access_token) {
      throw new Error(`Lark/Feishu credential exchange returned ${tokenRes.status}`)
    }

    const token = tokenBody.tenant_access_token
    const png = await iconPng(agent, iconStore)
    const form = new FormData()
    form.set('avatar', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'agent-icon.png')
    const uploadRes = await request(
      fetcher,
      `${origin}/open-apis/application/v7/app_avatar/upload`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
      },
      'icon upload'
    )
    const uploadBody = await responseBody(uploadRes)
    const avatarUrl = uploadBody?.data?.url
    if (!uploadRes.ok || uploadBody?.code !== 0 || !avatarUrl) {
      throw new Error(`Lark/Feishu icon upload returned ${uploadRes.status}`)
    }

    const encodedAppId = encodeURIComponent(appId)
    const patchRes = await request(
      fetcher,
      `${origin}/open-apis/application/v7/applications/${encodedAppId}/base`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({ avatar_url: avatarUrl }),
        signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
      },
      'icon patch'
    )
    const patchBody = await responseBody(patchRes)
    if (!patchRes.ok || patchBody?.code !== 0) {
      throw new Error(`Lark/Feishu icon patch returned ${patchRes.status}`)
    }

    const publishRes = await request(
      fetcher,
      `${origin}/open-apis/application/v7/applications/${encodedAppId}/publish`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          remark: 'Sync the application icon with its AgentConnect agent',
          changelog: 'Updated the application icon'
        }),
        signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
      },
      'publish'
    )
    const publishBody = await responseBody(publishRes)
    if (!publishRes.ok || publishBody?.code !== 0) {
      throw new Error(`Lark/Feishu publish returned ${publishRes.status}`)
    }
  }
}
