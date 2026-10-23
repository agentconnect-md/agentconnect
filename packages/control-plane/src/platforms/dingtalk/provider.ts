// The DingTalk provider (dingtalk-integration.md §2, §6): an enterprise internal app's credentials, checked by a token exchange; the daemon owns the Stream connection.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { DINGTALK_PLATFORM, type IntegrationDingTalkConfig } from '@agentconnect.md/protocol'
import { TENANTLESS_SENTINEL } from '../../persistence/ports.js'
import type { CpConfigRefusal, CpPlatformProvider, CpValidatedIdentity } from '../provider.js'

// Each edition runs its own OpenAPI host, and an app's credentials work on its edition's only (§2.1).
export const DINGTALK_TOKEN_URLS = [
  'https://api.dingtalk.com/v1.0/oauth2/accessToken',
  'https://api.dingtalk.io/v1.0/oauth2/accessToken'
] as const

export const DingTalkCreateCredentials = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/),
  clientSecret: z.string().trim().min(1).max(512)
})
export type DingTalkCreateCredentials = z.infer<typeof DingTalkCreateCredentials>

/** The check refuses with 400 or 503 only, which the credential route relays as is. */
export type DingTalkValidation = { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 503 })

export async function verifyDingTalkApp(
  credentials: DingTalkCreateCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<DingTalkValidation> {
  // The mainland host first; a refusal there may be an international app, so the international host decides.
  for (const url of DINGTALK_TOKEN_URLS) {
    const answer = await exchange(url, credentials, fetchImpl)
    if (answer === 'unavailable') return unavailable()
    if (answer === 'ok')
      return {
        ok: true,
        identity: { name: `DingTalk · ${credentials.clientId}`, externalAppId: credentials.clientId }
      }
  }
  // `invalidClientIdOrSecret` is the documented refusal; any other definitive answer is no usable credential either.
  return {
    ok: false,
    status: 400,
    code: 'DINGTALK_CREDENTIALS_INVALID',
    message: 'DingTalk rejected the Client ID or Client Secret — copy them again from the DingTalk developer console.'
  }
}

async function exchange(
  url: string,
  credentials: DingTalkCreateCredentials,
  fetchImpl: typeof fetch
): Promise<'ok' | 'refused' | 'unavailable'> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: credentials.clientId, appSecret: credentials.clientSecret }),
      signal: AbortSignal.timeout(10_000)
    })
    if (response.status >= 500 || response.status === 429) return 'unavailable'
    const data = (await response.json()) as { accessToken?: unknown }
    return response.ok && typeof data.accessToken === 'string' && data.accessToken ? 'ok' : 'refused'
  } catch {
    return 'unavailable'
  }
}

function unavailable(): DingTalkValidation {
  return {
    ok: false,
    status: 503,
    code: 'DINGTALK_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach DingTalk to check this app. Try again in a moment.'
  }
}

export interface DingTalkCpProviderDeps {
  /** DingTalk's token endpoint; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** The credential route, pre-bound by the composition root. */
  installRoutes?: FastifyPluginAsync[]
}

export function createDingTalkCpProvider(
  deps: DingTalkCpProviderDeps = {}
): CpPlatformProvider<DingTalkCreateCredentials> {
  const fetchImpl: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init)
  return {
    platformId: DINGTALK_PLATFORM,
    installRoutes: (scope) => (scope === 'org' ? (deps.installRoutes ?? []) : []),
    credentialBodySchema: DingTalkCreateCredentials,
    validateConfig: (credentials) => verifyDingTalkApp(credentials, fetchImpl),
    buildNewBotInstall: ({ credentials }) => ({
      bot: { externalAppId: credentials.clientId },
      secrets: { botToken: credentials.clientSecret, appToken: credentials.clientId, signingSecret: null },
      // The token exchange names no organization, so the fence is one bot per app under the tenantless sentinel.
      externalIdentity: {
        externalAppId: credentials.clientId,
        externalTenantId: TENANTLESS_SENTINEL,
        conflictMessage: 'This DingTalk app is already installed. Reuse the existing bot.'
      }
    }),
    projectBotIdentity: (input) =>
      input.externalAppId ? { externalAppId: input.externalAppId, externalTenantId: TENANTLESS_SENTINEL } : {},
    secretShape: {
      slots: { botToken: 'DingTalk Client Secret', appToken: 'DingTalk Client ID (identifier, not a secret)' },
      httpAssignRequires: []
    },
    async projectIntegrationConfig(_integration, bot, _core, secrets): Promise<IntegrationDingTalkConfig> {
      return { clientId: secrets.appToken ?? bot.externalAppId ?? '', clientSecret: secrets.botToken }
    }
  }
}
