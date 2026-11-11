// The Microsoft Teams provider (teams-integration.md §2, §5, §6): an organization's own bot registration, checked by a client-credentials token request; the relay owns ingress.
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import {
  IntegrationMsTeamsConfig,
  MSTEAMS_PLATFORM,
  MSTEAMS_RELAY_EGRESS_V1_FEATURE,
  msTeamsMessagesUrl
} from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import { isMsTeamsConversationId, msTeamsSessionRealm } from './session-access.js'
import {
  MSTEAMS_DEPLOYMENT_OWNER,
  MSTEAMS_DEPLOYMENT_SECRET_MARKER,
  MSTEAMS_ROW_OWNER_KEY,
  MsTeamsCpEnvSchema,
  isMsTeamsCustomerRow,
  isMsTeamsDeploymentRow,
  msTeamsAgentBotEntries,
  msTeamsAgentBotOf,
  servesMsTeamsDeploymentRow,
  type MsTeamsAgentBots,
  type MsTeamsPlatformApp
} from './deployment-app.js'
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

/** The tenant whose endpoint issues the bot's tokens: a deployment app's home tenant, recorded on its customer rows, else the tenant it serves (§8.2). */
export function msTeamsTokenTenant(bot: Pick<BotRecord, 'externalTenantId' | 'platformConfig'>): string | null {
  const home = bot.platformConfig?.tokenTenantId
  return typeof home === 'string' && home ? home : bot.externalTenantId
}

/** An organization's own bot's secret row: its client secret in `botToken`, which reaches the serving daemon only. */
export function msTeamsSecrets(clientSecret: string): BotSecretMaterial {
  return { botToken: clientSecret, appToken: null, signingSecret: null }
}

/** The daemon spec payload; undefined when the row lacks its identity or secret. A deployment row, the app's or an agent bot's, gets no secret, only the relay as its egress (§8.5, §8.6.7). */
export function msTeamsIntegrationConfig(
  bot: Pick<BotRecord, 'id' | 'externalAppId' | 'externalTenantId' | 'prebuilt' | 'platformConfig'>,
  secrets: Pick<BotSecretMaterial, 'botToken'>,
  publicRelayUrl?: string,
  app?: Pick<MsTeamsPlatformApp, 'appId'>,
  agentBots?: Pick<MsTeamsAgentBots, 'blueprintId'>
): IntegrationMsTeamsConfig | undefined {
  if (!bot.externalAppId || !bot.externalTenantId) return undefined
  const identity = {
    appId: bot.externalAppId,
    tenantId: bot.externalTenantId,
    ...(publicRelayUrl ? { messagesUrl: msTeamsMessagesUrl(publicRelayUrl) } : {})
  }
  // Decided by what the row stores, never by its secret slot; with no matching app configured it delivers nothing.
  if (isMsTeamsDeploymentRow(bot, app) || secrets.botToken === MSTEAMS_DEPLOYMENT_SECRET_MARKER)
    return servesMsTeamsDeploymentRow(bot, app, agentBots) ? { ...identity, egress: 'relay', botId: bot.id } : undefined
  if (!secrets.botToken) return undefined
  return { ...identity, clientSecret: secrets.botToken }
}

/** What a daemon must advertise to hold a projected config: the relay egress for a deployment app's row (§8.5). */
export function msTeamsRequiredDaemonFeatures(config: unknown): readonly string[] {
  const parsed = IntegrationMsTeamsConfig.safeParse(config)
  return parsed.success && 'egress' in parsed.data ? [MSTEAMS_RELAY_EGRESS_V1_FEATURE] : []
}

/** The relay assignment: no secret, the app ID the inbound token's audience must equal, the bot's own tenant, its `28:` mention identity, and the mark of an agent bot, which the relay cannot tell otherwise (§8.6.7). */
export function msTeamsBotAssignBags(bot: Pick<BotRecord, 'externalAppId' | 'externalTenantId' | 'platformConfig'>): {
  secrets: Record<string, unknown>
  ingress: Record<string, unknown>
} {
  return {
    secrets: {},
    ingress: {
      ...(bot.externalAppId ? { apiAppId: bot.externalAppId, botUserId: `28:${bot.externalAppId.toLowerCase()}` } : {}),
      ...(bot.externalTenantId ? { teamId: bot.externalTenantId } : {}),
      ...(msTeamsAgentBotOf(bot) ? { agentBot: true } : {})
    }
  }
}

/** The 409 copy when a per-agent install names the deployment's own app, which organizations connect from the Console (§8.3). */
export const MSTEAMS_DEPLOYMENT_APP_MESSAGE =
  'This is the deployment’s own Teams app. Connect your Microsoft 365 organization with Use the AgentConnect app instead.'

export interface MsTeamsCpProviderDeps {
  /** The deployment-owned app (§8.2), when Setup configured one. */
  app?: MsTeamsPlatformApp
  /** The blueprint agent bots are made from (§8.6.3), when Setup configured them. */
  agentBots?: Pick<MsTeamsAgentBots, 'blueprintId'>
  /** The boot pass that removes the deployment secret from the app's rows (§8.5). */
  credentialReconciler?: { start(): void; stop(): void }
  /** The loop that watches members' pending agent-bot requests until their packages are approved (§8.6.6). */
  agentBotRequests?: { start(): void; stop(): void }
  /** Removes a deleted row's bot, renames bots with their agents, and deletes what no row names (§8.6.5). */
  agentBotKeeper?: { start(): void; stop(): void; remove(bot: BotRecord): Promise<void> }
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
    validateConfig: async (credentials) =>
      credentials.appId === deps.app?.appId
        ? { ok: false, status: 409, code: 'MSTEAMS_DEPLOYMENT_APP', message: MSTEAMS_DEPLOYMENT_APP_MESSAGE }
        : await verifyMsTeamsApp(credentials, fetchImpl),

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
    // A deployment app's customer row also keeps its home tenant, which issues its tokens (§8.2).
    projectBotIdentity: (input) => {
      const tenantId = input.platformConfig?.tenantId
      const tokenTenantId = input.platformConfig?.tokenTenantId
      const owner = input.platformConfig?.[MSTEAMS_ROW_OWNER_KEY]
      if (!input.externalAppId || !tenantId) return {}
      // An agent bot's row keeps what names its blueprint and its Azure resource (§8.6.4).
      const agentBot = msTeamsAgentBotOf(input)
      const kept = {
        ...(tokenTenantId ? { tokenTenantId } : {}),
        ...(owner === MSTEAMS_DEPLOYMENT_OWNER ? { [MSTEAMS_ROW_OWNER_KEY]: owner } : {}),
        ...(agentBot ? msTeamsAgentBotEntries(agentBot) : {})
      }
      return {
        externalAppId: input.externalAppId,
        externalTenantId: tenantId,
        ...(Object.keys(kept).length ? { platformConfig: kept } : {})
      }
    },

    secretShape: {
      slots: {
        botToken:
          'An own bot’s Microsoft Entra client secret, sent to its serving daemon and never to the relay; a deployment app’s row holds a marker instead'
      },
      httpAssignRequires: []
    },

    envSchema: MsTeamsCpEnvSchema,

    ...(deps.agentBotKeeper ? { sideEffects: { onBotDelete: (bot) => deps.agentBotKeeper!.remove(bot) } } : {}),

    ...(deps.credentialReconciler || deps.agentBotRequests || deps.agentBotKeeper
      ? {
          backgroundLoops: [
            ...(deps.credentialReconciler
              ? [
                  {
                    label: 'msteams-deployment-secret-purge',
                    start: () => deps.credentialReconciler!.start(),
                    stop: () => deps.credentialReconciler!.stop()
                  }
                ]
              : []),
            ...(deps.agentBotRequests
              ? [
                  {
                    label: 'msteams-agent-bot-requests',
                    start: () => deps.agentBotRequests!.start(),
                    stop: () => deps.agentBotRequests!.stop()
                  }
                ]
              : []),
            ...(deps.agentBotKeeper
              ? [
                  {
                    label: 'msteams-agent-bot-upkeep',
                    start: () => deps.agentBotKeeper!.start(),
                    stop: () => deps.agentBotKeeper!.stop()
                  }
                ]
              : [])
          ]
        }
      : {}),

    // A freed customer row is deleted so its tenant can be connected anew, by any organization (§8.3); a freed agent bot's row names a bot that is being deleted (§8.6.5).
    releasesFreedBot: (bot) => isMsTeamsCustomerRow(bot, deps.app) || !!msTeamsAgentBotOf(bot),

    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return msTeamsIntegrationConfig(bot, secrets, deps.publicRelayUrl, deps.app, deps.agentBots)
    },

    requiredDaemonFeatures: msTeamsRequiredDaemonFeatures,

    async projectBotAssign(bot) {
      return msTeamsBotAssignBags(bot)
    }
  }
}
