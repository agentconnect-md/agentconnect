// The DingTalk provider (dingtalk-integration.md §2, §6): an enterprise internal app's credentials, checked by a token exchange; the daemon owns the Stream connection.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { DINGTALK_PLATFORM, DingTalkEdition, type IntegrationDingTalkConfig } from '@agentconnect.md/protocol'
import { TENANTLESS_SENTINEL, type BotRecord } from '../../persistence/ports.js'
import type { CpConfigRefusal, CpPlatformProvider, CpTenantName, CpValidatedIdentity } from '../provider.js'

// Each edition runs its own OpenAPI host, and an app's credentials work on its edition's only (§2.1).
export const DINGTALK_TOKEN_URLS: Record<DingTalkEdition, string> = {
  mainland: 'https://api.dingtalk.com/v1.0/oauth2/accessToken',
  international: 'https://api.dingtalk.io/v1.0/oauth2/accessToken'
}

export const DingTalkCreateCredentials = z.object({
  clientId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/),
  clientSecret: z.string().trim().min(1).max(512),
  edition: DingTalkEdition.default('mainland')
})
export type DingTalkCreateCredentials = z.infer<typeof DingTalkCreateCredentials>

const DINGTALK_API_ORIGINS: Record<DingTalkEdition, string> = {
  mainland: 'https://api.dingtalk.com',
  international: 'https://api.dingtalk.io'
}

/** The integration name a connect gives before the organization is known. */
export function dingTalkPlaceholderName(clientId: string): string {
  return `DingTalk · ${clientId}`
}

/** The edition a bot was installed on; rows from before the edition switch are mainland. */
export function dingTalkEditionOf(bot: Pick<BotRecord, 'platformConfig'>): DingTalkEdition {
  return DingTalkEdition.safeParse(bot.platformConfig?.edition).data ?? 'mainland'
}

/** The check refuses with 400 or 503 only, which the credential route relays as is. */
export type DingTalkValidation = { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 503 })

export async function verifyDingTalkApp(
  credentials: DingTalkCreateCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<DingTalkValidation> {
  const answer = await exchange(DINGTALK_TOKEN_URLS[credentials.edition], credentials, fetchImpl)
  if (answer === 'ok')
    return {
      ok: true,
      identity: {
        name: dingTalkPlaceholderName(credentials.clientId),
        externalAppId: credentials.clientId,
        platformConfig: { edition: credentials.edition }
      }
    }
  if (answer === 'unavailable') return unavailable()
  // A refusal may be the other edition's app, which the console names so the member switches instead of copying again.
  const other: DingTalkEdition = credentials.edition === 'mainland' ? 'international' : 'mainland'
  if ((await exchange(DINGTALK_TOKEN_URLS[other], credentials, fetchImpl)) === 'ok')
    return {
      ok: false,
      status: 400,
      code: other === 'international' ? 'DINGTALK_APP_IS_INTERNATIONAL' : 'DINGTALK_APP_IS_MAINLAND',
      message:
        other === 'international'
          ? 'This app belongs to DingTalk international. Switch the DingTalk tile to Intl and connect again.'
          : 'This app belongs to mainland DingTalk. Switch the DingTalk tile to CN and connect again.'
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

/** The organization's name through `Contact.Org.Read` (§2.2), or DingTalk's error code when it answers none (a missing permission among them). */
export async function readDingTalkOrgName(
  credentials: Omit<DingTalkCreateCredentials, 'edition'>,
  edition: DingTalkEdition,
  corpId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ orgName: string } | { reason: string }> {
  const origin = DINGTALK_API_ORIGINS[edition]
  try {
    const tokenResponse = await fetchImpl(`${origin}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: credentials.clientId, appSecret: credentials.clientSecret }),
      signal: AbortSignal.timeout(10_000)
    })
    const token = (await tokenResponse.json()) as { accessToken?: unknown; code?: unknown }
    if (!tokenResponse.ok || typeof token.accessToken !== 'string' || !token.accessToken)
      return { reason: `token: ${errorCode(tokenResponse, token)}` }
    const query = new URLSearchParams({ targetCorpId: corpId })
    const response = await fetchImpl(`${origin}/v1.0/contact/organizations/authInfos?${query}`, {
      headers: { 'x-acs-dingtalk-access-token': token.accessToken },
      signal: AbortSignal.timeout(10_000)
    })
    const info = (await response.json()) as { orgName?: unknown; code?: unknown }
    if (!response.ok) return { reason: errorCode(response, info) }
    return typeof info.orgName === 'string' && info.orgName.trim()
      ? { orgName: info.orgName.trim().slice(0, 200) }
      : { reason: 'no orgName' }
  } catch {
    return { reason: 'unreachable' }
  }
}

// DingTalk's own error code, never its free-text message; the status when it sends none.
function errorCode(response: Response, body: { code?: unknown }): string {
  return typeof body.code === 'string' && body.code ? body.code.slice(0, 120) : `HTTP ${response.status}`
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
      bot: { externalAppId: credentials.clientId, platformConfig: { edition: credentials.edition } },
      secrets: { botToken: credentials.clientSecret, appToken: credentials.clientId, signingSecret: null },
      // The token exchange names no organization, so the fence is one bot per app under the tenantless sentinel.
      externalIdentity: {
        externalAppId: credentials.clientId,
        externalTenantId: TENANTLESS_SENTINEL,
        conflictMessage: 'This DingTalk app is already installed. Reuse the existing bot.'
      }
    }),
    projectBotIdentity: (input) => {
      if (!input.externalAppId) return {}
      const edition = DingTalkEdition.safeParse(input.platformConfig?.edition).data
      return {
        externalAppId: input.externalAppId,
        externalTenantId: TENANTLESS_SENTINEL,
        ...(edition ? { platformConfig: { edition } } : {})
      }
    },
    secretShape: {
      slots: { botToken: 'DingTalk Client Secret', appToken: 'DingTalk Client ID (identifier, not a secret)' },
      httpAssignRequires: []
    },
    socketTenant: {
      // A socket names its app by Client ID, which is the bot's only identity (§2).
      matches: (bot, botUserId) => bot.externalAppId === botUserId,
      async name(bot, secrets, corpId): Promise<CpTenantName | { unnamed: string }> {
        const clientId = secrets.appToken ?? bot.externalAppId
        if (!clientId) return { unnamed: 'no Client ID' }
        const read = await readDingTalkOrgName(
          { clientId, clientSecret: secrets.botToken },
          dingTalkEditionOf(bot),
          corpId,
          fetchImpl
        )
        if ('reason' in read) return { unnamed: read.reason }
        return {
          workspaceName: read.orgName,
          integrationName: { placeholder: dingTalkPlaceholderName(clientId), name: `DingTalk · ${read.orgName}` }
        }
      }
    },
    async projectIntegrationConfig(_integration, bot, _core, secrets): Promise<IntegrationDingTalkConfig> {
      return {
        clientId: secrets.appToken ?? bot.externalAppId ?? '',
        clientSecret: secrets.botToken,
        edition: dingTalkEditionOf(bot)
      }
    }
  }
}
