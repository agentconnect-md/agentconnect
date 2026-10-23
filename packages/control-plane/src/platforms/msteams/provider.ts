// The Microsoft Teams provider (teams-integration.md §2, §5, §6): an organization's own bot registration, checked by a client-credentials token request; the relay owns ingress.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { MSTEAMS_PLATFORM, msTeamsMessagesUrl, type IntegrationMsTeamsConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { isMsTeamsConversationId, msTeamsSessionRealm } from './session-access.js'
import type { CpConfigRefusal, CpInstallTransport, CpPlatformProvider, CpValidatedIdentity } from '../provider.js'

/** The Bot Framework audience a bot's outbound token is issued for. */
export const MSTEAMS_TOKEN_SCOPE = 'https://api.botframework.com/.default'

/** The tenant's own Entra token endpoint; a single-tenant bot has no other (§2). */
export function msTeamsTokenUrl(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Guid = (label: string) =>
  z
    .string()
    .trim()
    .regex(GUID_RE, `${label} must be a GUID`)
    .transform((value) => value.toLowerCase())

/** The `msteams` block of `POST /integrations`; both IDs are stored lower-cased, so one registration is one key. */
export const MsTeamsCreateCredentials = z.object({
  appId: Guid('appId').describe('The Entra application (client) ID, which is also the bot ID.'),
  tenantId: Guid('tenantId').describe('The Entra directory (tenant) ID the app is registered in.'),
  clientSecret: z.string().trim().min(1).max(512).describe('An Entra client secret value of the app (write-only).')
})
export type MsTeamsCreateCredentials = z.infer<typeof MsTeamsCreateCredentials>

/** Teams delivers activities only to the relay's messaging endpoint, so there is no socket install. */
export function refineMsTeamsCreateBody(
  body: { credentials: MsTeamsCreateCredentials; transport: CpInstallTransport },
  addIssue: (message: string) => void
): void {
  if (body.transport !== 'http') addIssue('msteams requires transport http: Teams activities arrive through the relay')
}

/** The 409 copy of the one-bot-per-registration fence. */
export const MSTEAMS_APP_TAKEN_MESSAGE =
  'This Teams bot is already connected to an agent. Each bot serves one agent; register another bot for this agent.'

const TIMEOUT_MS = 10_000

/** The check refuses with 400 or 503 only, which the credential route relays as is. */
export type MsTeamsValidation = { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 503 })

/** Requests a Bot Framework token from the tenant's endpoint, which proves the app, tenant and secret together; the token is discarded. */
export async function verifyMsTeamsApp(
  credentials: MsTeamsCreateCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<MsTeamsValidation> {
  let response: Response
  let data: { access_token?: unknown; error?: unknown; error_codes?: unknown } | null
  try {
    response = await fetchImpl(msTeamsTokenUrl(credentials.tenantId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.appId,
        client_secret: credentials.clientSecret,
        scope: MSTEAMS_TOKEN_SCOPE
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    data = (await response.json().catch(() => null)) as typeof data
  } catch {
    return unavailable()
  }
  if (response.status >= 500 || response.status === 429) return unavailable()
  if (response.ok) {
    if (typeof data?.access_token === 'string' && data.access_token) {
      return {
        ok: true,
        identity: { name: `Microsoft Teams · ${credentials.appId}`, externalAppId: credentials.appId }
      }
    }
    return unavailable()
  }
  return refusal(data?.error, Array.isArray(data?.error_codes) ? data.error_codes : [])
}

/** Maps an Entra refusal to the reason the console shows; the provider's own description is never echoed. */
function refusal(error: unknown, codes: unknown[]): MsTeamsValidation {
  const has = (code: number) => codes.includes(code)
  if (has(90002) || has(900023)) {
    return invalid(
      'MSTEAMS_TENANT_NOT_FOUND',
      'Microsoft Entra does not know this tenant ID — copy the Directory (tenant) ID from the app registration’s Overview page.'
    )
  }
  if (has(700016) || error === 'unauthorized_client') {
    return invalid(
      'MSTEAMS_APP_NOT_FOUND',
      'This tenant has no app with this app ID — copy the Application (client) ID from the same app registration as the tenant ID.'
    )
  }
  if (has(7000215) || has(7000222) || error === 'invalid_client') {
    return invalid(
      'MSTEAMS_SECRET_INVALID',
      'Microsoft Entra rejected the client secret, or it has expired — create a new client secret and paste its Value, not its Secret ID.'
    )
  }
  return invalid(
    'MSTEAMS_CREDENTIALS_INVALID',
    'Microsoft Entra refused these credentials — check the app ID, tenant ID and client secret.'
  )
}

function invalid(code: string, message: string): MsTeamsValidation {
  return { ok: false, status: 400, code, message }
}

function unavailable(): MsTeamsValidation {
  return {
    ok: false,
    status: 503,
    code: 'MSTEAMS_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach Microsoft Entra to check this bot. Try again in a moment.'
  }
}

/** The secret row: the client secret in `botToken`, which reaches the serving daemon only. */
export function msTeamsSecrets(clientSecret: string): BotSecretMaterial {
  return { botToken: clientSecret, appToken: null, signingSecret: null }
}

/** The daemon spec payload; undefined when the row lacks its identity or secret. */
export function msTeamsIntegrationConfig(
  bot: Pick<BotRecord, 'externalAppId' | 'externalTenantId'>,
  secrets: Pick<BotSecretMaterial, 'botToken'>,
  publicRelayUrl?: string
): IntegrationMsTeamsConfig | undefined {
  if (!bot.externalAppId || !bot.externalTenantId || !secrets.botToken) return undefined
  return {
    appId: bot.externalAppId,
    tenantId: bot.externalTenantId,
    clientSecret: secrets.botToken,
    ...(publicRelayUrl ? { messagesUrl: msTeamsMessagesUrl(publicRelayUrl) } : {})
  }
}

/** The relay assignment: no secret, the app ID the inbound token's audience must equal, the bot's own tenant, and its `28:` mention identity. */
export function msTeamsBotAssignBags(bot: Pick<BotRecord, 'externalAppId' | 'externalTenantId'>): {
  secrets: Record<string, unknown>
  ingress: Record<string, unknown>
} {
  return {
    secrets: {},
    ingress: {
      ...(bot.externalAppId ? { apiAppId: bot.externalAppId, botUserId: `28:${bot.externalAppId.toLowerCase()}` } : {}),
      ...(bot.externalTenantId ? { teamId: bot.externalTenantId } : {})
    }
  }
}

export interface MsTeamsCpProviderDeps {
  /** Entra's token endpoint; tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** The credential and app-package routes, pre-bound by the composition root. */
  installRoutes?: FastifyPluginAsync[]
  /** The relay pool's public http(s) origin, under which the bot registration names its messaging endpoint. */
  publicRelayUrl?: string
}

export function createMsTeamsCpProvider(
  deps: MsTeamsCpProviderDeps = {}
): CpPlatformProvider<MsTeamsCreateCredentials> {
  const fetchImpl: typeof fetch = (input, init) => (deps.fetch ?? fetch)(input, init)
  return {
    platformId: MSTEAMS_PLATFORM,
    chatMemberTenant: (bot) => (bot.revokedAt ? null : 'global'),
    legacySessionAudience: isMsTeamsConversationId,
    sessionAudienceRealm: msTeamsSessionRealm,
    installRoutes: (scope) => (scope === 'org' ? (deps.installRoutes ?? []) : []),
    credentialBodySchema: MsTeamsCreateCredentials,
    refineCreateBody: refineMsTeamsCreateBody,
    validateConfig: (credentials) => verifyMsTeamsApp(credentials, fetchImpl),

    // One bot serves one agent in this version, so a requested `shareable` is dropped.
    buildNewBotInstall: ({ credentials }) => ({
      bot: { externalAppId: credentials.appId, platformConfig: { tenantId: credentials.tenantId } },
      secrets: msTeamsSecrets(credentials.clientSecret),
      externalIdentity: {
        externalAppId: credentials.appId,
        externalTenantId: credentials.tenantId,
        conflictMessage: MSTEAMS_APP_TAKEN_MESSAGE
      }
    }),

    // The relay picks the row by (app ID, tenant ID), so the tenant is the row's key rather than metadata.
    projectBotIdentity: (input) => {
      const tenantId = input.platformConfig?.tenantId
      return input.externalAppId && tenantId ? { externalAppId: input.externalAppId, externalTenantId: tenantId } : {}
    },

    secretShape: {
      slots: { botToken: 'Microsoft Entra client secret (daemon egress only; never sent to the relay)' },
      httpAssignRequires: []
    },

    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return msTeamsIntegrationConfig(bot, secrets, deps.publicRelayUrl)
    },

    async projectBotAssign(bot) {
      return msTeamsBotAssignBags(bot)
    }
  }
}
