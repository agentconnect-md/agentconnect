/**
 * Post-registration Lark/Feishu app configuration.
 *
 * The official one-click registration URL may pre-fill permissions, events and
 * callbacks, but intentionally rejects sensitive settings such as delivery
 * transport, request URLs and callback verification keys. HTTP/relay installs
 * apply those settings server-side after the provider returns App ID/Secret.
 */
import type { FeishuRegion } from '@agentconnect.md/protocol'
import { AGENTCONNECT_FEISHU_CALLBACKS, AGENTCONNECT_FEISHU_EVENTS } from './feishu-app-template.js'

const REGION_ORIGIN: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com'
}
const REQUEST_TIMEOUT_MS = 15_000

export interface ConfigureFeishuHttpAppInput {
  appId: string
  appSecret: string
  region: FeishuRegion
  requestUrl: string
  verificationToken: string
  encryptKey: string
}

export type FeishuHttpAppConfigurator = (input: ConfigureFeishuHttpAppInput) => Promise<void>

export function feishuEventsRequestUrl(relayHttpBase: string): string {
  return `${relayHttpBase.replace(/\/+$/, '')}/feishu/events`
}

export function createFeishuHttpAppConfigurator(fetcher: typeof fetch = fetch): FeishuHttpAppConfigurator {
  return async (input) => {
    const origin = REGION_ORIGIN[input.region]
    const tokenResponse = await fetcher(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: input.appId, app_secret: input.appSecret }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const tokenBody = (await tokenResponse.json()) as { code?: number; tenant_access_token?: string }
    if (!tokenResponse.ok || tokenBody.code !== 0 || !tokenBody.tenant_access_token) {
      throw new Error('Lark/Feishu rejected the app credentials while configuring HTTP callbacks')
    }

    const configResponse = await fetcher(
      `${origin}/open-apis/application/v7/applications/${encodeURIComponent(input.appId)}/config`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${tokenBody.tenant_access_token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify({
          event: {
            subscription_type: 'webhook',
            request_url: input.requestUrl,
            add_events: [...AGENTCONNECT_FEISHU_EVENTS]
          },
          callback: {
            callback_type: 'webhook',
            request_url: input.requestUrl,
            add_callbacks: [...AGENTCONNECT_FEISHU_CALLBACKS]
          },
          event_and_callback_encrypt_strategy: {
            verification_token: input.verificationToken,
            encryption_key: input.encryptKey
          }
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    )
    const configBody = (await configResponse.json()) as { code?: number }
    if (!configResponse.ok || configBody.code !== 0) {
      throw new Error('Lark/Feishu could not configure HTTP callback delivery')
    }
  }
}

export const configureFeishuHttpApp = createFeishuHttpAppConfigurator()
