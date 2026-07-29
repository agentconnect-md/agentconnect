/**
 * Resumable adapter for Feishu/Lark's official app-registration device flow.
 *
 * The public SDK wraps both `begin` and repeated `poll` calls in one Promise,
 * which cannot be resumed by another Control Plane replica. This adapter uses
 * the same official endpoint and payload, while exposing the device cursor so
 * the encrypted persistence store can resume it after load balancing/restart.
 */
import type { FeishuRegion } from '@agentconnect.md/protocol'
import { AGENTCONNECT_FEISHU_APP_TEMPLATE, buildFeishuAuthorizationUrl } from './feishu-app-template.js'

export const FEISHU_REGISTRATION_DOMAIN = 'accounts.feishu.cn'
export const LARK_REGISTRATION_DOMAIN = 'accounts.larksuite.com'

const REGISTRATION_PATH = '/oauth/v1/app/registration'

interface RegistrationResponse {
  verification_uri_complete?: string
  device_code?: string
  expires_in?: number
  interval?: number
  client_id?: string
  client_secret?: string
  error?: string
  error_description?: string
  user_info?: { tenant_brand?: FeishuRegion }
}

export interface BeginFeishuRegistration {
  authorizationUrl: string
  deviceCode: string
  providerDomain: string
  intervalMs: number
  expiresInMs: number
}

export type PollFeishuRegistration =
  | { outcome: 'pending' }
  | { outcome: 'slow_down' }
  | { outcome: 'switch_domain'; providerDomain: string }
  | { outcome: 'authorized'; appId: string; appSecret: string; region?: FeishuRegion }
  | { outcome: 'denied' }
  | { outcome: 'expired' }
  | { outcome: 'failed' }

export interface FeishuRegistrationProvider {
  begin(appName: string, region: FeishuRegion): Promise<BeginFeishuRegistration>
  poll(providerDomain: string, deviceCode: string): Promise<PollFeishuRegistration>
}

type RegistrationFetch = typeof fetch

export class OfficialFeishuRegistrationProvider implements FeishuRegistrationProvider {
  constructor(private readonly fetcher: RegistrationFetch = fetch) {}

  async begin(appName: string, region: FeishuRegion): Promise<BeginFeishuRegistration> {
    const providerDomain = region === 'lark' ? LARK_REGISTRATION_DOMAIN : FEISHU_REGISTRATION_DOMAIN
    const response = await this.request(providerDomain, {
      action: 'begin',
      archetype: AGENTCONNECT_FEISHU_APP_TEMPLATE.archetype,
      auth_method: 'client_secret',
      request_user_info: 'open_id'
    })
    if (!response.verification_uri_complete || !response.device_code) {
      throw new Error('Feishu app registration did not return a device session')
    }
    return {
      authorizationUrl: buildFeishuAuthorizationUrl(response.verification_uri_complete, appName),
      deviceCode: response.device_code,
      providerDomain,
      intervalMs: Math.max(1, response.interval ?? 5) * 1000,
      expiresInMs: Math.max(1, response.expires_in ?? 600) * 1000
    }
  }

  async poll(providerDomain: string, deviceCode: string): Promise<PollFeishuRegistration> {
    const response = await this.request(providerDomain, { action: 'poll', device_code: deviceCode })
    if (response.user_info?.tenant_brand === 'lark' && providerDomain !== LARK_REGISTRATION_DOMAIN) {
      return { outcome: 'switch_domain', providerDomain: LARK_REGISTRATION_DOMAIN }
    }
    if (response.client_id && response.client_secret) {
      return {
        outcome: 'authorized',
        appId: response.client_id,
        appSecret: response.client_secret,
        ...(response.user_info?.tenant_brand ? { region: response.user_info.tenant_brand } : {})
      }
    }
    switch (response.error) {
      case 'authorization_pending':
        return { outcome: 'pending' }
      case 'slow_down':
        return { outcome: 'slow_down' }
      case 'access_denied':
        return { outcome: 'denied' }
      case 'expired_token':
        return { outcome: 'expired' }
      case undefined:
        return { outcome: 'pending' }
      default:
        return { outcome: 'failed' }
    }
  }

  private async request(providerDomain: string, params: Record<string, string>): Promise<RegistrationResponse> {
    const response = await this.fetcher(`https://${providerDomain}${REGISTRATION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000)
    })
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error('Feishu app registration returned an invalid response')
    }
    if (!response.ok && typeof Reflect.get(body, 'error') !== 'string') {
      throw new Error('Feishu app registration request failed')
    }
    return body as RegistrationResponse
  }
}
