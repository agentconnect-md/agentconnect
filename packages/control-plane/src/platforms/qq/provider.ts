import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import type { CpPlatformProvider, CpConfigValidation } from '../provider.js'

export const QQCreateCredentials = z.object({ appId: z.string().regex(/^\d+$/), appSecret: z.string().trim().min(1) })
type Credentials = z.infer<typeof QQCreateCredentials>

export async function verifyQQBot(
  credentials: Credentials,
  fetchImpl: typeof fetch = fetch
): Promise<CpConfigValidation> {
  try {
    const response = await fetchImpl('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: credentials.appId, clientSecret: credentials.appSecret }),
      signal: AbortSignal.timeout(10_000)
    })
    if (response.status >= 500 || response.status === 429) return unavailable()
    const data = (await response.json()) as { access_token?: string; expires_in?: number }
    if (!response.ok || !data.access_token)
      return {
        ok: false,
        status: 400,
        code: 'QQ_CREDENTIALS_INVALID',
        message: 'QQ rejected the AppID or AppSecret — copy them again from the QQ developer portal.'
      }
    return { ok: true, identity: { externalAppId: credentials.appId } }
  } catch {
    return unavailable()
  }
}

function unavailable(): CpConfigValidation {
  return {
    ok: false,
    status: 503,
    code: 'QQ_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach QQ to check this bot. Try again in a moment.'
  }
}

export function createQQCpProvider(
  verify = verifyQQBot,
  routes: FastifyPluginAsync[] = []
): CpPlatformProvider<Credentials> {
  return {
    platformId: 'qq',
    installRoutes: (scope) => (scope === 'org' ? routes : []),
    credentialBodySchema: QQCreateCredentials,
    validateConfig: (credentials) => verify(credentials),
    buildNewBotInstall: ({ credentials }) => ({
      bot: { botUserId: credentials.appId },
      secrets: { botToken: credentials.appSecret, appToken: credentials.appId, signingSecret: null },
      externalIdentity: {
        externalAppId: credentials.appId,
        externalTenantId: '-',
        conflictMessage: 'This QQ bot is already installed. Reuse the existing bot.'
      }
    }),
    projectBotIdentity: (input) => ({ externalAppId: input.botUserId ?? undefined, externalTenantId: '-' }),
    secretShape: { slots: { botToken: 'QQ AppSecret', appToken: 'QQ AppID' }, httpAssignRequires: [] },
    async projectIntegrationConfig(_integration, _bot, _core, secrets) {
      return { appId: secrets.appToken, appSecret: secrets.botToken }
    }
  }
}
