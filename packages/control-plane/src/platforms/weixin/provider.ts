import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { CpPlatformProvider, CpConfigRefusal, CpValidatedIdentity } from '../provider.js'

export const WeixinCreateCredentials = z.object({
  accountId: z.string().trim().min(1),
  botToken: z.string().trim().min(1),
  baseUrl: z.string().url().optional()
})
type Credentials = z.infer<typeof WeixinCreateCredentials>

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

type WeixinValidation = { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 503 })

/**
 * iLink has no lightweight auth-check endpoint, so the probe is `getupdates`
 * itself with a short timeout: a fast errcode means the token was rejected;
 * the long-poll simply holding the connection open means it was accepted.
 */
export async function verifyWeixinBot(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch
): Promise<WeixinValidation> {
  const base = (credentials.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  try {
    const response = await fetchImpl(`${base}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.botToken}` },
      body: JSON.stringify({ update_buf: '' }),
      signal: AbortSignal.timeout(5_000)
    })
    const body = (await response.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
    if (response.status === 401 || response.status === 403 || body.errcode === -14)
      return {
        ok: false,
        status: 400,
        code: 'WEIXIN_CREDENTIALS_INVALID',
        message: 'iLink rejected the bot token — the session is expired; run the QR login again to mint a fresh one.'
      }
    if (response.status >= 500 || (body.errcode !== undefined && body.errcode !== 0)) return unavailable()
    return { ok: true, identity: { name: `Weixin · ${credentials.accountId}`, externalAppId: credentials.accountId } }
  } catch (error) {
    // A timeout means the long-poll stayed open — the token was accepted.
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: true, identity: { name: `Weixin · ${credentials.accountId}`, externalAppId: credentials.accountId } }
    }
    return unavailable()
  }
}

function unavailable(): WeixinValidation {
  return {
    ok: false,
    status: 503,
    code: 'WEIXIN_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach iLink to check this bot. Try again in a moment.'
  }
}

export function createWeixinCpProvider(
  verify = verifyWeixinBot,
  routes: FastifyPluginAsync[] = []
): CpPlatformProvider<Credentials> {
  return {
    platformId: 'weixin',
    installRoutes: (scope) => (scope === 'org' ? routes : []),
    credentialBodySchema: WeixinCreateCredentials,
    validateConfig: (credentials) => verify(credentials),
    buildNewBotInstall: ({ credentials }) => ({
      bot: { botUserId: credentials.accountId },
      secrets: { botToken: credentials.botToken, appToken: credentials.accountId, signingSecret: null },
      externalIdentity: {
        externalAppId: credentials.accountId,
        externalTenantId: '-',
        conflictMessage: 'This Weixin bot is already installed. Reuse the existing bot.'
      }
    }),
    projectBotIdentity: (input) => ({ externalAppId: input.botUserId ?? undefined, externalTenantId: '-' }),
    secretShape: { slots: { botToken: 'iLink bot token', appToken: 'iLink account id' }, httpAssignRequires: [] },
    async projectIntegrationConfig(_integration, _bot, _core, secrets) {
      return { accountId: secrets.appToken, botToken: secrets.botToken }
    }
  }
}
