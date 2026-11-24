// The Mattermost provider: a self-hosted server URL and Bot Account token or PAT, checked via GET /api/v4/users/me; the daemon owns the WebSocket.
import { createHmac } from 'node:crypto'
import type { FastifyPluginAsync } from 'fastify'
import { z, type ZodRawShape } from 'zod'
import {
  MATTERMOST_PLATFORM,
  MATTERMOST_WEBSOCKET_REPLIES_V1_FEATURE,
  deriveMattermostOrgActionSecret,
  IntegrationMattermostConfig
} from '@agentconnect.md/protocol'
import { guardedRequest, isLinkLocalOrUnspecifiedAddress } from '../../net/guarded-fetch.js'
import type { BotRecord } from '../../persistence/ports.js'
import type { CpConfigRefusal, CpPlatformProvider, CpValidatedIdentity } from '../provider.js'
import { mattermostExternalAppId, normalizeMattermostServerUrl } from './server-url.js'

const MM_CHANNEL_ID_RE = /^[a-z0-9]{26}$/
const MM_APP_ID_RE = /^mm-[0-9a-f]{16}$/

export { mattermostExternalAppId, normalizeMattermostServerUrl }

export const MattermostCpEnvSchema = {
  /** Bound Mattermost server URL for Logto oauth2 social sign-in; projected from deployment config when set. */
  MATTERMOST_OAUTH_SERVER_URL: z.string().optional(),
  /** Optional master HMAC secret for signing Mattermost interactive action button tokens (falls back to API_KEY_PEPPER). */
  MATTERMOST_ACTION_SECRET: z.string().min(32).optional(),
  /** Whether tenant-supplied Mattermost serverUrl values may dial private/loopback IPs (default: true outside production). */
  MATTERMOST_ALLOW_PRIVATE_NETWORK: z.enum(['true', 'false']).optional()
} satisfies ZodRawShape

export const MATTERMOST_CHECK_TIMEOUT_MS = 10_000

export const MattermostCreateCredentials = z.object({
  serverUrl: z.string().trim().min(1).max(1024),
  botToken: z.string().trim().min(1).max(512)
})
export type MattermostCreateCredentials = z.infer<typeof MattermostCreateCredentials>

/** The check refuses with 400 or 503 only, which the credential route relays as is. */
export type MattermostCheckResult =
  { ok: true; identity: CpValidatedIdentity } | (CpConfigRefusal & { status: 400 | 503 })

/** Provider config validation may also refuse with 409 when the bot is already installed. */
export type MattermostValidation = MattermostCheckResult | (CpConfigRefusal & { status: 409 })

const CONFLICT_MESSAGE = 'This Mattermost bot is already installed. Reuse the existing bot.'

function invalidServerUrl(message: string): MattermostCheckResult {
  return { ok: false, status: 400, code: 'MATTERMOST_SERVER_URL_INVALID', message }
}

function invalidCredentials(): MattermostCheckResult {
  return {
    ok: false,
    status: 400,
    code: 'MATTERMOST_CREDENTIALS_INVALID',
    message: 'Mattermost rejected the token. Check that you copied a valid Bot Account token or Personal Access Token.'
  }
}

function unavailable(): MattermostCheckResult {
  return {
    ok: false,
    status: 503,
    code: 'MATTERMOST_CHECK_UNAVAILABLE',
    message: 'AgentConnect could not reach the Mattermost server to check this token. Try again in a moment.'
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

function mattermostBotRealm(bot: Pick<BotRecord, 'platformConfig' | 'externalAppId'>): string | null {
  const serverUrl = text(bot.platformConfig?.serverUrl)
  if (serverUrl) {
    const normalized = normalizeMattermostServerUrl(serverUrl)
    if (normalized.ok) return mattermostExternalAppId(normalized.serverUrl)
  }
  const externalAppId = text(bot.externalAppId)
  return externalAppId && MM_APP_ID_RE.test(externalAppId) ? externalAppId : null
}

function interpretMeResponse(serverUrl: string, status: number, body: unknown): MattermostCheckResult {
  if (status === 401 || status === 403) return invalidCredentials()
  if (status === 404) {
    return invalidServerUrl('Mattermost API v4 was not found at this server URL. Check the base URL and subpath.')
  }
  if (status === 408 || status === 429 || status >= 500 || status < 200 || (status >= 300 && status < 400)) {
    return unavailable()
  }
  if (status >= 400) return invalidCredentials()

  const user = body && typeof body === 'object' ? (body as { id?: unknown; username?: unknown }) : null
  const botUserId = text(user?.id)
  const botUsername = text(user?.username)
  // The id becomes `externalTenantId` inside colon-split identity keys, so accept only Mattermost's 26-char id shape.
  if (!botUserId || !/^[a-z0-9]{26}$/.test(botUserId) || !botUsername) {
    return invalidServerUrl('The server did not return a valid Mattermost user profile at /api/v4/users/me.')
  }

  return {
    ok: true,
    identity: {
      name: `Mattermost · ${botUsername}`,
      botName: botUsername,
      externalAppId: mattermostExternalAppId(serverUrl),
      botUserId,
      workspaceName: new URL(serverUrl).host,
      platformConfig: {
        serverUrl,
        botUserId,
        botUsername
      }
    }
  }
}

export interface MattermostCheckOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  allowPrivateNetwork?: boolean
  allowlist?: ReadonlySet<string>
}

/** Verify a Mattermost Bot Account token or PAT via `GET ${serverUrl}/api/v4/users/me`. */
export async function verifyMattermostBot(
  credentials: MattermostCreateCredentials,
  options: MattermostCheckOptions = {}
): Promise<MattermostCheckResult> {
  const normalized = normalizeMattermostServerUrl(credentials.serverUrl)
  if (!normalized.ok) return invalidServerUrl(normalized.reason)
  const { serverUrl } = normalized
  const meUrl = `${serverUrl}/api/v4/users/me`
  const timeoutMs = options.timeoutMs ?? MATTERMOST_CHECK_TIMEOUT_MS
  const headers = {
    Authorization: `Bearer ${credentials.botToken}`,
    Accept: 'application/json'
  }

  if (options.fetch) {
    try {
      const response = await options.fetch(meUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      })
      const body = response.ok ? await response.json().catch(() => undefined) : undefined
      return interpretMeResponse(serverUrl, response.status, body)
    } catch {
      return unavailable()
    }
  }

  const guarded = await guardedRequest(meUrl, {
    method: 'GET',
    headers,
    ...(options.allowlist ? { allowlist: options.allowlist } : {}),
    ...(options.allowPrivateNetwork ? { blockAddress: isLinkLocalOrUnspecifiedAddress } : {}),
    timeoutMs
  })
  if (!guarded.ok) {
    if (guarded.failure === 'url_rejected' || guarded.failure === 'address_blocked') {
      return invalidServerUrl('This Mattermost server address is not allowed.')
    }
    return unavailable()
  }
  return interpretMeResponse(serverUrl, guarded.response.status, guarded.response.json)
}

/** Derive the shared HMAC secret used by daemons to sign Mattermost interactive button tokens and by relays to verify them. */
export function deriveMattermostActionSecret(pepper: string): string {
  return createHmac('sha256', pepper).update('agentconnect:mattermost-action:v1').digest('base64url')
}

export interface MattermostCpProviderDeps {
  /** HTTP edge; tests pass a fake. Defaults to SSRF-guarded outbound HTTP in production. */
  fetch?: typeof fetch
  /** Permit dialing private/loopback Mattermost serverUrl targets when not explicitly allowlisted. */
  allowPrivateNetwork?: boolean
  /** Deployment-level outbound host allowlist passed through to guardedRequest. */
  allowlist?: ReadonlySet<string>
  /** Master card-callback secret; each integration is sent only its own organization's derivation of it. */
  actionSecret?: string
  /** Whether a bot row already holds `(externalAppId, botUserId)`. */
  isInstalled?: (externalAppId: string, botUserId: string) => Promise<boolean>
  /** Credential routes, pre-bound by the composition root. */
  installRoutes?: FastifyPluginAsync[]
}

export function createMattermostCpProvider(
  deps: MattermostCpProviderDeps = {}
): CpPlatformProvider<MattermostCreateCredentials> {
  return {
    platformId: MATTERMOST_PLATFORM,
    envSchema: MattermostCpEnvSchema,
    installRoutes: (scope) => (scope === 'org' ? (deps.installRoutes ?? []) : []),
    credentialBodySchema: MattermostCreateCredentials,

    async validateConfig(credentials): Promise<MattermostValidation> {
      const verified = await verifyMattermostBot(credentials, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: deps.allowPrivateNetwork } : {}),
        ...(deps.allowlist ? { allowlist: deps.allowlist } : {})
      })
      if (!verified.ok) return verified
      const externalAppId = verified.identity.externalAppId
      const botUserId = verified.identity.botUserId
      if (externalAppId && botUserId && (await deps.isInstalled?.(externalAppId, botUserId))) {
        return {
          ok: false,
          status: 409,
          code: 'MATTERMOST_BOT_ALREADY_INSTALLED',
          message: CONFLICT_MESSAGE
        }
      }
      return verified
    },

    buildNewBotInstall: ({ credentials, identity }) => {
      const normalized = normalizeMattermostServerUrl(credentials.serverUrl)
      const serverUrl = text(identity.platformConfig?.serverUrl) ?? (normalized.ok ? normalized.serverUrl : undefined)
      const botUserId = text(identity.botUserId) ?? text(identity.platformConfig?.botUserId)
      const botUsername = text(identity.platformConfig?.botUsername)
      const externalAppId = text(identity.externalAppId) ?? (serverUrl ? mattermostExternalAppId(serverUrl) : undefined)
      return {
        bot: {
          ...(externalAppId ? { externalAppId } : {}),
          ...(botUserId ? { botUserId } : {}),
          ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}),
          ...(serverUrl && botUserId && botUsername ? { platformConfig: { serverUrl, botUserId, botUsername } } : {})
        },
        secrets: { botToken: credentials.botToken, appToken: null, signingSecret: null },
        ...(externalAppId && botUserId
          ? {
              externalIdentity: {
                externalAppId,
                externalTenantId: botUserId,
                conflictMessage: CONFLICT_MESSAGE
              }
            }
          : {})
      }
    },

    projectBotIdentity: (input) => {
      const serverUrl = text(input.platformConfig?.serverUrl)
      const botUserId = text(input.platformConfig?.botUserId) ?? text(input.botUserId)
      const botUsername = text(input.platformConfig?.botUsername)
      const externalAppId = text(input.externalAppId) ?? (serverUrl ? mattermostExternalAppId(serverUrl) : undefined)
      if (!externalAppId || !botUserId) return {}
      return {
        externalAppId,
        externalTenantId: botUserId,
        platformConfig: {
          ...(serverUrl ? { serverUrl } : {}),
          botUserId,
          ...(botUsername ? { botUsername } : {})
        }
      }
    },

    secretShape: {
      slots: { botToken: 'Mattermost Bot Account token or Personal Access Token' },
      httpAssignRequires: []
    },

    async projectIntegrationConfig(integration, bot, _core, secrets): Promise<IntegrationMattermostConfig | undefined> {
      const serverUrl = text(bot.platformConfig?.serverUrl)
      if (!serverUrl || !secrets.botToken) return undefined
      const botUserId = text(bot.platformConfig?.botUserId) ?? text(bot.botUserId)
      const botUsername = text(bot.platformConfig?.botUsername)
      return {
        serverUrl,
        botToken: secrets.botToken,
        ...(botUserId ? { botUserId } : {}),
        ...(botUsername ? { botUsername } : {}),
        ...(integration.mattermostWebsocketRepliesOnly ? { websocketRepliesOnly: true } : {}),
        ...(deps.actionSecret && integration.orgId && !integration.mattermostWebsocketRepliesOnly
          ? { actionSecret: deriveMattermostOrgActionSecret(deps.actionSecret, integration.orgId) }
          : {})
      }
    },

    requiredDaemonFeatures: (config) =>
      IntegrationMattermostConfig.safeParse(config).data?.websocketRepliesOnly
        ? [MATTERMOST_WEBSOCKET_REPLIES_V1_FEATURE]
        : [],
    legacySessionAudience: (channel) => MM_CHANNEL_ID_RE.test(channel),
    sessionAudienceRealm: (bot) => mattermostBotRealm(bot),
    chatMemberTenant: (bot) => (bot.revokedAt ? null : mattermostBotRealm(bot)),
    socketLifecycleRevocation: (bot, reported) => {
      const botUserId = text(bot.platformConfig?.botUserId) ?? text(bot.botUserId)
      const realm = mattermostBotRealm(bot)
      return !!botUserId && !!realm && botUserId === reported.botUserId && realm === reported.workspaceId
    }
  }
}
