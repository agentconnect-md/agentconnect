/**
 * Feishu / Lark credential verification for the install flow — the Feishu analog of
 * discord-identity.ts / slack-identity.ts.
 *
 * A Feishu self-built app authenticates with an `appId` + `appSecret` PAIR. Unlike a
 * single static bot token, the credentials are exchanged for a short-lived
 * `tenant_access_token`; verifying them = performing that exchange once. `POST
 * /open-apis/auth/v3/tenant_access_token/internal` validates BOTH credentials in one
 * call — a wrong app id or secret comes back as a non-zero Feishu error `code`. We then
 * (best-effort) `GET /open-apis/bot/v3/info` with the minted token to derive the bot's
 * display name when the install omits one, so we don't force the operator to type it.
 *
 * Best-effort about *reachability*: a network error / timeout / non-2xx HTTP is reported
 * as `unreachable` (inconclusive) and MUST NOT block the install — the CP momentarily
 * failing to reach Feishu is not evidence the credentials are bad. Only a definitive
 * credential rejection (HTTP 200 with a non-zero Feishu `code`) is treated as `invalid`.
 *
 * This is the only spot the CP touches the appSecret to reach Feishu; it NEVER logs it.
 */
import type { FeishuRegion } from '@agentconnect.md/protocol'
import { AGENTCONNECT_FEISHU_EVENTS, AGENTCONNECT_FEISHU_SCOPES } from './feishu-app-template.js'

/** tenant-access-token exchange outcome: valid creds (with the derived bot name), creds
 *  Feishu rejected, or an inconclusive reachability failure. */
export type FeishuBotVerification =
  | { status: 'ok'; name: string | null; openId: string | null }
  | { status: 'invalid' } // Feishu returned a non-zero code — bad app id / secret
  | { status: 'unreachable' } // network / timeout / non-2xx — inconclusive, do not block

export type FeishuBotVerifier = (
  appId: string,
  appSecret: string,
  region?: FeishuRegion
) => Promise<FeishuBotVerification>

/** Resolve the tenant that owns an App. The installer compares this immutable
 *  tenant_key with the login App's tenant without retaining either an App-user
 *  token or a request-bound authorization grant. */
export type FeishuAppTenantResolution =
  | { status: 'ok'; tenantKey: string }
  | { status: 'invalid_credentials' }
  | { status: 'unresolved' }
  | { status: 'unavailable' }

export type FeishuAppTenantResolver = (
  appId: string,
  appSecret: string,
  region: FeishuRegion
) => Promise<FeishuAppTenantResolution>

export type FeishuAppTenantCheck =
  'ok' | 'not_configured' | 'invalid_credentials' | 'unresolved' | 'unavailable' | 'org_mismatch'

/** One same-organization rule shared by manual and one-click installs. */
export interface FeishuAppTenantGuard {
  loginAppStatus(region: FeishuRegion): Promise<'ok' | 'not_configured' | 'unavailable'>
  checkApp(appId: string, appSecret: string, region: FeishuRegion): Promise<FeishuAppTenantCheck>
}

/** Open-platform gateway per region. Mainland China ('feishu') vs international ('lark');
 *  the verifier must exchange credentials against the SAME host the daemon's SDK will use,
 *  or a valid Lark app would be rejected against the Feishu gateway. Defaults to feishu. */
const REGION_BASE: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn/open-apis',
  lark: 'https://open.larksuite.com/open-apis'
}
const FEISHU_TIMEOUT_MS = 5000

async function tenantAccessToken(
  appId: string,
  appSecret: string,
  region: FeishuRegion,
  fetcher: typeof fetch = fetch
): Promise<{ status: 'ok'; token: string } | { status: 'invalid' | 'unavailable' }> {
  try {
    const res = await fetcher(`${REGION_BASE[region]}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'unavailable' }
    const body = (await res.json()) as { code?: number; tenant_access_token?: string }
    return body.code === 0 && body.tenant_access_token
      ? { status: 'ok', token: body.tenant_access_token }
      : { status: 'invalid' }
  } catch {
    return { status: 'unavailable' }
  }
}

export interface FeishuAppSetupDiff {
  field: string
  current: unknown
  expected: unknown
}

export interface FeishuAppSetupAudit {
  status: 'ok' | 'mismatch' | 'invalid' | 'unavailable'
  appName: string | null
  version: string | null
  diff: FeishuAppSetupDiff[]
  message?: string
}

export interface FeishuAppSetupExpectation {
  redirectUris?: readonly string[]
}

export type FeishuAppSetupAuditor = (
  appId: string,
  appSecret: string,
  region: FeishuRegion,
  expectation?: FeishuAppSetupExpectation
) => Promise<FeishuAppSetupAudit>

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function scopeNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const scope = record(item).scope
        return typeof scope === 'string' ? [scope] : []
      })
    : []
}

async function responseJson(response: Response): Promise<JsonRecord> {
  try {
    return record(await response.json())
  } catch {
    return {}
  }
}

function applicationReadPermissionMissing(body: JsonRecord): boolean {
  const code = body.code
  const message = typeof body.msg === 'string' ? body.msg : ''
  return (
    code === 210508 ||
    code === 99991672 ||
    message.includes('application:application:self_manage') ||
    message.toLowerCase().includes('insufficient permission')
  )
}

/** Audit the actual published regional App instead of treating a successful
 * credential exchange as proof that its Bot, scopes, events and release are ready. */
export function createFeishuAppSetupAuditor(fetcher: typeof fetch = fetch): FeishuAppSetupAuditor {
  return async (appId, appSecret, region, expectation = {}) => {
    const base = REGION_BASE[region]
    const token = await tenantAccessToken(appId, appSecret, region, fetcher)
    if (token.status !== 'ok') {
      return {
        status: token.status === 'invalid' ? 'invalid' : 'unavailable',
        appName: null,
        version: null,
        diff: []
      }
    }

    try {
      const headers = { authorization: `Bearer ${token.token}` }
      const appResponse = await fetcher(`${base}/application/v6/applications/${encodeURIComponent(appId)}?lang=en_us`, {
        headers,
        signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
      })
      const appBody = await responseJson(appResponse)
      if (!appResponse.ok || appBody.code !== 0) {
        if (applicationReadPermissionMissing(appBody)) {
          return {
            status: 'mismatch',
            appName: null,
            version: null,
            diff: [
              {
                field: 'API permission: application:application:self_manage',
                current: 'Missing',
                expected: 'Required for setup audit'
              }
            ]
          }
        }
        return {
          status: 'unavailable',
          appName: null,
          version: null,
          diff: [],
          ...(typeof appBody.msg === 'string' ? { message: appBody.msg } : {})
        }
      }

      const app = record(record(appBody.data).app)
      const appName = typeof app.app_name === 'string' ? app.app_name : null
      const onlineVersionId = typeof app.online_version_id === 'string' ? app.online_version_id.trim() : ''
      const diff: FeishuAppSetupDiff[] = []
      const redirectUris = strings(app.redirect_urls)
      if (expectation.redirectUris?.some((redirectUri) => !redirectUris.includes(redirectUri))) {
        diff.push({ field: 'OAuth redirect URLs', current: redirectUris, expected: expectation.redirectUris })
      }
      if (app.status !== 1) diff.push({ field: 'App status', current: 'Disabled', expected: 'Enabled' })
      if (!onlineVersionId) {
        diff.push({ field: 'Published version', current: 'None', expected: 'Published' })
        return { status: 'mismatch', appName, version: null, diff }
      }

      const versionResponse = await fetcher(
        `${base}/application/v6/applications/${encodeURIComponent(appId)}/app_versions/${encodeURIComponent(onlineVersionId)}?lang=en_us`,
        { headers, signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS) }
      )
      const versionBody = await responseJson(versionResponse)
      if (!versionResponse.ok || versionBody.code !== 0) {
        return {
          status: 'unavailable',
          appName,
          version: null,
          diff,
          ...(typeof versionBody.msg === 'string' ? { message: versionBody.msg } : {})
        }
      }

      const appVersion = record(record(versionBody.data).app_version)
      const version = typeof appVersion.version === 'string' ? appVersion.version : null
      if (appVersion.status !== 1 || !appVersion.publish_time) {
        diff.push({ field: 'Published version', current: version ?? 'Not published', expected: 'Published' })
      }

      const publishedScopes = new Set(scopeNames(appVersion.scopes))
      for (const scope of AGENTCONNECT_FEISHU_SCOPES) {
        if (!publishedScopes.has(scope)) {
          diff.push({ field: `API permission: ${scope}`, current: 'Missing', expected: 'Required' })
        }
      }

      const publishedEvents = new Set([
        ...strings(appVersion.events),
        ...(Array.isArray(appVersion.event_infos)
          ? appVersion.event_infos.flatMap((item) => {
              const eventType = record(item).event_type
              return typeof eventType === 'string' ? [eventType] : []
            })
          : [])
      ])
      for (const event of AGENTCONNECT_FEISHU_EVENTS) {
        if (!publishedEvents.has(event)) {
          diff.push({ field: `Event subscription: ${event}`, current: 'Missing', expected: 'Required' })
        }
      }

      if (!Object.hasOwn(record(appVersion.ability), 'bot')) {
        diff.push({ field: 'Bot capability', current: 'Disabled', expected: 'Enabled' })
      } else {
        const botResponse = await fetcher(`${base}/bot/v3/info`, {
          headers,
          signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
        })
        const botBody = await responseJson(botResponse)
        if (!botResponse.ok) {
          return { status: 'unavailable', appName, version, diff }
        }
        if (botBody.code !== 0) {
          diff.push({ field: 'Bot capability', current: 'Unavailable', expected: 'Enabled' })
        }
      }

      return { status: diff.length ? 'mismatch' : 'ok', appName, version, diff }
    } catch {
      return { status: 'unavailable', appName: null, version: null, diff: [] }
    }
  }
}

/** Exchange (app_id, app_secret) → tenant_access_token, then derive the bot name from
 *  `/bot/v3/info`. A non-zero `code` on the token exchange means Feishu rejected the
 *  credentials (`invalid`); any transport failure is `unreachable`. `region` selects the
 *  gateway (feishu.cn vs larksuite.com); omitted ⇒ 'feishu'. */
export const verifyFeishuBot: FeishuBotVerifier = async (appId, appSecret, region = 'feishu') => {
  const base = REGION_BASE[region]
  const token = await tenantAccessToken(appId, appSecret, region)
  if (token.status !== 'ok') return { status: token.status === 'invalid' ? 'invalid' : 'unreachable' }
  // Credentials are valid. Derive the bot name best-effort — a failure here must NOT
  // downgrade the verification (the creds already validated), so fall back to null.
  try {
    const res = await fetch(`${base}/bot/v3/info`, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'ok', name: null, openId: null }
    const body = (await res.json()) as { code?: number; bot?: { app_name?: string; open_id?: string } }
    const name = body.code === 0 && body.bot?.app_name ? body.bot.app_name : null
    const openId = body.code === 0 && body.bot?.open_id ? body.bot.open_id : null
    return { status: 'ok', name, openId }
  } catch {
    return { status: 'ok', name: null, openId: null }
  }
}

export const resolveFeishuAppTenant: FeishuAppTenantResolver = async (appId, appSecret, region) => {
  const base = REGION_BASE[region]
  const token = await tenantAccessToken(appId, appSecret, region)
  if (token.status !== 'ok') {
    return { status: token.status === 'invalid' ? 'invalid_credentials' : 'unavailable' }
  }

  try {
    const res = await fetch(`${base}/tenant/v2/tenant/query`, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'unavailable' }
    const body = (await res.json()) as { code?: number; data?: { tenant?: { tenant_key?: string } } }
    if (body.code !== 0) return { status: 'unavailable' }
    const tenantKey = body.data?.tenant?.tenant_key?.trim()
    return tenantKey ? { status: 'ok', tenantKey } : { status: 'unresolved' }
  } catch {
    return { status: 'unavailable' }
  }
}

export function createFeishuAppTenantGuard(
  loginAppFor: (region: FeishuRegion) => { appId: string; appSecret: string } | undefined,
  resolve: FeishuAppTenantResolver = resolveFeishuAppTenant
): FeishuAppTenantGuard {
  const loginTenants = new Map<FeishuRegion, string>()
  const loginTenant = async (
    region: FeishuRegion
  ): Promise<{ status: 'ok'; tenantKey: string } | { status: 'not_configured' | 'unavailable' }> => {
    const cached = loginTenants.get(region)
    if (cached) return { status: 'ok', tenantKey: cached }
    const app = loginAppFor(region)
    if (!app) return { status: 'not_configured' }
    const result = await resolve(app.appId, app.appSecret, region)
    if (result.status !== 'ok') return { status: 'unavailable' }
    loginTenants.set(region, result.tenantKey)
    return result
  }

  return {
    async loginAppStatus(region) {
      return (await loginTenant(region)).status
    },
    async checkApp(appId, appSecret, region) {
      const login = await loginTenant(region)
      if (login.status !== 'ok') return login.status
      const candidate = await resolve(appId, appSecret, region)
      if (candidate.status !== 'ok') return candidate.status
      return candidate.tenantKey === login.tenantKey ? 'ok' : 'org_mismatch'
    }
  }
}
