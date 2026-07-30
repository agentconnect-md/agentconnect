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

/** Open-platform gateway per region. Mainland China ('feishu') vs international ('lark');
 *  the verifier must exchange credentials against the SAME host the daemon's SDK will use,
 *  or a valid Lark app would be rejected against the Feishu gateway. Defaults to feishu. */
const REGION_BASE: Record<FeishuRegion, string> = {
  feishu: 'https://open.feishu.cn/open-apis',
  lark: 'https://open.larksuite.com/open-apis'
}
const FEISHU_TIMEOUT_MS = 5000

/** Exchange (app_id, app_secret) → tenant_access_token, then derive the bot name from
 *  `/bot/v3/info`. A non-zero `code` on the token exchange means Feishu rejected the
 *  credentials (`invalid`); any transport failure is `unreachable`. `region` selects the
 *  gateway (feishu.cn vs larksuite.com); omitted ⇒ 'feishu'. */
export const verifyFeishuBot: FeishuBotVerifier = async (appId, appSecret, region = 'feishu') => {
  const base = REGION_BASE[region]
  let token: string
  try {
    const res = await fetch(`${base}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(FEISHU_TIMEOUT_MS)
    })
    if (!res.ok) return { status: 'unreachable' }
    const body = (await res.json()) as { code?: number; tenant_access_token?: string }
    // code 0 = success; anything else (e.g. 10003 app not found, 10014 secret wrong) is a
    // definitive credential rejection.
    if (body.code !== 0 || !body.tenant_access_token) return { status: 'invalid' }
    token = body.tenant_access_token
  } catch {
    return { status: 'unreachable' }
  }
  // Credentials are valid. Derive the bot name best-effort — a failure here must NOT
  // downgrade the verification (the creds already validated), so fall back to null.
  try {
    const res = await fetch(`${base}/bot/v3/info`, {
      headers: { authorization: `Bearer ${token}` },
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
