import { LRUCache } from 'lru-cache'
import { z } from 'zod'
import { cacheOptions } from '../../cache.js'
import type { BotRecord } from '../../persistence/ports.js'
import { BotAccessError, BotSessionAccessService, type BotSessionAccessDeps } from '../bot-session-access.js'
import { MsTeamsAgentBotClient, MsTeamsAgentBotError } from './agent-bots.js'
import {
  MSTEAMS_DEPLOYMENT_SECRET_MARKER,
  isMsTeamsDeploymentRow,
  msTeamsAgentBotOf,
  usesMsTeamsDeploymentApp,
  type MsTeamsAgentBots,
  type MsTeamsPlatformApp
} from './deployment-app.js'
import { MSTEAMS_TOKEN_SCOPE, msTeamsTokenTenant, msTeamsTokenUrl } from './provider.js'

/** The public cloud's global Bot Connector origin, which answers member lookups for every region (teams-integration.md §4.5). */
export const MSTEAMS_CONNECTOR_ORIGIN = 'https://smba.trafficmanager.net/teams/'

const ENTRA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A channel, group chat or meeting conversation (`19:`) or a 1:1 chat (`a:`), without a thread suffix.
const CONVERSATION_ID = /^(?:19:[\w.@-]{1,190}|a:[\w-]{1,190})$/

/** A Teams conversation the Control Plane can check membership in. */
export function isMsTeamsConversationId(value: string): boolean {
  return CONVERSATION_ID.test(value)
}

/** A bot's sessions live in its own tenant; the stored ID is already lower-cased. */
export function msTeamsSessionRealm(bot: Pick<BotRecord, 'externalTenantId'>): string | null {
  return bot.externalTenantId && ENTRA_ID.test(bot.externalTenantId) ? bot.externalTenantId : null
}

/** How long an agent bot's token is reused; Entra issues it for about an hour and does not say so through the client. */
const AGENT_BOT_TOKEN_TTL_MS = 10 * 60_000

const Token = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().positive() })
const Member = z.object({ aadObjectId: z.string(), tenantId: z.string() })

// The bot's client secret proves membership through the Bot Connector with no Graph permission; a deployment app's row uses the app's own, held here and never on the row (§8.5), and an agent bot's the token its own tenant issues for the blueprint (§8.6.7).
export function createMsTeamsSessionAccess(
  deps: BotSessionAccessDeps,
  fetchImpl: typeof fetch = fetch,
  app?: MsTeamsPlatformApp,
  agentBots?: MsTeamsAgentBots
) {
  const agentBotClient = app && agentBots ? new MsTeamsAgentBotClient({ app, agentBots, fetch: fetchImpl }) : undefined
  const tokens = new LRUCache<string, string, { bot: BotRecord; secret: string; signal: AbortSignal }>({
    ...cacheOptions(deps.clock, 1_000),
    ttl: 60_000,
    fetchMethod: async (_key, _stale, { context, options }) => {
      const { bot, signal } = context
      // An agent bot is in the conversation as its own identity, so only that identity's token reads its members.
      const agentBot = msTeamsAgentBotOf(bot)
      if (agentBot) {
        if (!agentBotClient || agentBots?.blueprintId !== agentBot.blueprintId || !bot.externalTenantId)
          throw new BotAccessError('app_authorization')
        try {
          options.ttl = AGENT_BOT_TOKEN_TTL_MS
          return await agentBotClient.botToken(bot.externalTenantId, bot.externalAppId!)
        } catch (err) {
          throw new BotAccessError(
            err instanceof MsTeamsAgentBotError && !err.transient ? 'app_authorization' : 'unavailable'
          )
        }
      }
      // A deployment app's row uses only the configured app's credential, never what its secret slot holds.
      const deployment = isMsTeamsDeploymentRow(bot, app) || context.secret === MSTEAMS_DEPLOYMENT_SECRET_MARKER
      if (deployment && !usesMsTeamsDeploymentApp(bot, app)) throw new BotAccessError('app_authorization')
      const secret = deployment ? app!.clientSecret : context.secret
      const tenant = deployment ? app!.tenantId : msTeamsTokenTenant(bot)!
      const response = await fetchImpl(msTeamsTokenUrl(tenant), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: bot.externalAppId!,
          client_secret: secret,
          scope: MSTEAMS_TOKEN_SCOPE
        }).toString(),
        signal
      })
      if (response.status === 400 || response.status === 401) throw new BotAccessError('app_authorization')
      if (!response.ok) throw new BotAccessError('unavailable')
      const token = Token.parse(await response.json())
      options.ttl = Math.max(60, token.expires_in - 300) * 1000
      return token.access_token
    }
  })
  return new BotSessionAccessService(
    'msteams',
    deps,
    (_secret, bot) => msTeamsSessionRealm(bot),
    async ({ token: secret, bot, resource, member }, signal) => {
      if (!CONVERSATION_ID.test(resource) || !ENTRA_ID.test(member)) return false
      if (!bot.externalAppId || !msTeamsSessionRealm(bot)) throw new BotAccessError('app_authorization')
      const token = await tokens.fetch(`${bot.id}:${bot.credentialRevision}`, { context: { bot, secret, signal } })
      const response = await fetchImpl(
        `${MSTEAMS_CONNECTOR_ORIGIN}v3/conversations/${encodeURIComponent(resource)}/members/${member}`,
        { headers: { authorization: `Bearer ${token}` }, signal }
      )
      if (response.status === 404) return false
      if (response.status === 401 || response.status === 403) throw new BotAccessError('app_authorization')
      if (!response.ok) throw new BotAccessError('unavailable')
      const found = Member.parse(await response.json())
      if (found.aadObjectId.toLowerCase() !== member || found.tenantId.toLowerCase() !== bot.externalTenantId)
        throw new BotAccessError('unavailable')
      return true
    }
  )
}
