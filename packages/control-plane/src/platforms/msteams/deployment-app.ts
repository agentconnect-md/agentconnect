// The deployment-owned Teams app (teams-integration.md §8.2), projected from the Setup Server's `msTeams` slice; all three keys or none.
import { createHmac } from 'node:crypto'
import { z, type ZodRawShape } from 'zod'
import { RcMsTeamsAnchor, RcMsTeamsDeploymentApp } from '@agentconnect.md/protocol'
import type { BotSecretMaterial } from '../../persistence/ports.js'

export const MsTeamsCpEnvSchema = {
  MSTEAMS_PLATFORM_APP_ID: z.string().optional(),
  MSTEAMS_PLATFORM_TENANT_ID: z.string().optional(),
  MSTEAMS_PLATFORM_CLIENT_SECRET: z.string().optional(),
  // Agent bots (§8.6.3): the blueprint and where their bot registrations are made; all four or none.
  MSTEAMS_AGENT_BOTS_BLUEPRINT_ID: z.string().optional(),
  MSTEAMS_AGENT_BOTS_BLUEPRINT_SECRET: z.string().optional(),
  MSTEAMS_AGENT_BOTS_SUBSCRIPTION_ID: z.string().optional(),
  MSTEAMS_AGENT_BOTS_RESOURCE_GROUP: z.string().optional(),
  // A non-production deployment's label, shown after every Teams app's name (§5); 26 characters leave its " (…)" room in the 30-character short name.
  MSTEAMS_APP_LABEL: z.string().trim().max(26).optional()
} satisfies ZodRawShape

export interface MsTeamsPlatformApp {
  appId: string
  /** The app's home tenant, which issues the bot's tokens for every customer tenant. */
  tenantId: string
  /** Secret material, never logged or returned; it reaches the relay and never a daemon (§8.5). */
  clientSecret: string
}

type Env = { [K in keyof typeof MsTeamsCpEnvSchema]?: string | undefined }

/** Undefined ⇒ no deployment-owned app. Throws on a partial set. */
export function resolveMsTeamsPlatformApp(env: Env): MsTeamsPlatformApp | undefined {
  const { MSTEAMS_PLATFORM_APP_ID: appId, MSTEAMS_PLATFORM_TENANT_ID: tenantId } = env
  const clientSecret = env.MSTEAMS_PLATFORM_CLIENT_SECRET
  const set = [appId, tenantId, clientSecret].filter((value) => value !== undefined).length
  if (set === 0) return undefined
  if (set < 3 || !appId || !tenantId || !clientSecret)
    throw new Error('microsoft teams platform app config is partial (set all three MSTEAMS_PLATFORM_* keys or none)')
  return { appId: appId.toLowerCase(), tenantId: tenantId.toLowerCase(), clientSecret }
}

export interface MsTeamsAgentBots {
  /** The agent identity blueprint in the app's home tenant, which holds the only credential the agent bots have. */
  blueprintId: string
  /** Secret material, never logged or returned; it reaches the relay and never a daemon (§8.6.3). */
  clientSecret: string
  /** The Azure subscription and resource group the bot registrations are made in. */
  subscriptionId: string
  resourceGroup: string
}

/** Undefined ⇒ agent bots are off, as they are without the Teams app. Throws on a partial set. */
export function resolveMsTeamsAgentBots(env: Env, app: MsTeamsPlatformApp | undefined): MsTeamsAgentBots | undefined {
  const blueprintId = env.MSTEAMS_AGENT_BOTS_BLUEPRINT_ID
  const clientSecret = env.MSTEAMS_AGENT_BOTS_BLUEPRINT_SECRET
  const subscriptionId = env.MSTEAMS_AGENT_BOTS_SUBSCRIPTION_ID
  const resourceGroup = env.MSTEAMS_AGENT_BOTS_RESOURCE_GROUP
  const set = [blueprintId, clientSecret, subscriptionId, resourceGroup].filter((value) => value !== undefined).length
  if (set === 0) return undefined
  if (set < 4 || !blueprintId || !clientSecret || !subscriptionId || !resourceGroup)
    throw new Error('microsoft teams agent bots config is partial (set all four MSTEAMS_AGENT_BOTS_* keys or none)')
  if (!app) throw new Error('microsoft teams agent bots need the platform app (set the MSTEAMS_PLATFORM_* keys)')
  return {
    blueprintId: blueprintId.toLowerCase(),
    clientSecret,
    subscriptionId: subscriptionId.toLowerCase(),
    resourceGroup
  }
}

/** A row named as the configured deployment app's by its app ID. */
export function usesMsTeamsDeploymentApp(
  bot: { externalAppId: string | null },
  app: Pick<MsTeamsPlatformApp, 'appId'> | undefined
): boolean {
  return !!app && bot.externalAppId === app.appId
}

/** The `platformConfig` entry every deployment app's row carries, so it is one whatever the deployment's settings say later (§8.5). */
export const MSTEAMS_ROW_OWNER_KEY = 'appOwner'
export const MSTEAMS_DEPLOYMENT_OWNER = 'deployment'

/** A deployment app's row by facts stored on it: the owner entry, or the token tenant and prebuilt flag every connect has written; or by the configured app's ID. */
export function isMsTeamsDeploymentRow(
  bot: { externalAppId: string | null; prebuilt?: boolean; platformConfig: Record<string, unknown> | null },
  app?: Pick<MsTeamsPlatformApp, 'appId'>
): boolean {
  const stored = bot.platformConfig ?? {}
  return (
    stored[MSTEAMS_ROW_OWNER_KEY] === MSTEAMS_DEPLOYMENT_OWNER ||
    (typeof stored.tokenTenantId === 'string' && stored.tokenTenantId !== '') ||
    bot.prebuilt === true ||
    usesMsTeamsDeploymentApp(bot, app)
  )
}

/** The two `platformConfig` entries of an agent bot's row (§8.6.4): the blueprint that made its identity, and its Azure Bot resource. */
export const MSTEAMS_AGENT_BOT_BLUEPRINT_KEY = 'agentBotBlueprintId'
export const MSTEAMS_AGENT_BOT_RESOURCE_KEY = 'agentBotResourceName'
export interface MsTeamsAgentBotEntry {
  blueprintId: string
  resourceName: string
}

/** The agent bot a row is, by what it stores; undefined for the app's own row and for an organization's own bot. */
export function msTeamsAgentBotOf(bot: {
  platformConfig?: Record<string, unknown> | null
}): MsTeamsAgentBotEntry | undefined {
  const blueprintId = bot.platformConfig?.[MSTEAMS_AGENT_BOT_BLUEPRINT_KEY]
  const resourceName = bot.platformConfig?.[MSTEAMS_AGENT_BOT_RESOURCE_KEY]
  return typeof blueprintId === 'string' && blueprintId && typeof resourceName === 'string' && resourceName
    ? { blueprintId, resourceName }
    : undefined
}

/** Marks a tenant's row once an administrator accepted the tenant-wide consent (§8.6.5), so later connects of the organization skip that page. */
export const MSTEAMS_TENANT_CONSENT_KEY = 'tenantConsent'
/** The scope set that consent covered; raised when the connect asks a further scope, so a tenant is asked once more. */
export const MSTEAMS_TENANT_CONSENT_VERSION = '3'

/** The entries a new agent bot's row is written with. */
export const msTeamsAgentBotEntries = (entry: MsTeamsAgentBotEntry): Record<string, string> => ({
  [MSTEAMS_AGENT_BOT_BLUEPRINT_KEY]: entry.blueprintId,
  [MSTEAMS_AGENT_BOT_RESOURCE_KEY]: entry.resourceName
})

/** A deployment row the configured deployment can send for: the app's own row, or an agent bot of the configured blueprint. */
export function servesMsTeamsDeploymentRow(
  bot: { externalAppId: string | null; platformConfig?: Record<string, unknown> | null },
  app: Pick<MsTeamsPlatformApp, 'appId'> | undefined,
  agentBots?: Pick<MsTeamsAgentBots, 'blueprintId'>
): boolean {
  const agentBot = msTeamsAgentBotOf(bot)
  if (agentBot) return !!app && agentBots?.blueprintId === agentBot.blueprintId
  return usesMsTeamsDeploymentApp(bot, app)
}

/** What a deployment app's row stores in its secret slot: a marker, not a secret, since the app's secret never leaves the deployment (§8.5). */
export const MSTEAMS_DEPLOYMENT_SECRET_MARKER = 'msteams-deployment-app:no-secret'

export function msTeamsDeploymentSecrets(): BotSecretMaterial {
  return { botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER, appToken: null, signingSecret: null }
}

/** The key relays sign conversation tickets with, derived from the pepper like the CP's other signing keys; base64url. */
export function msTeamsRelayTicketKey(pepper: string): string {
  return createHmac('sha256', pepper).update('msteams-relay-ticket-v1').digest('base64url')
}

/** The deployment app as the relay sends its rows' egress with (§8.5), and the blueprint for its agent bots' (§8.6.7); none without an app. */
export function msTeamsRelayApp(
  app: MsTeamsPlatformApp | undefined,
  pepper: string,
  agentBots?: MsTeamsAgentBots
): RcMsTeamsDeploymentApp | undefined {
  if (!app) return undefined
  const parsed = RcMsTeamsDeploymentApp.safeParse({
    appId: app.appId,
    tenantId: app.tenantId,
    clientSecret: app.clientSecret,
    ticketKey: msTeamsRelayTicketKey(pepper),
    ...(agentBots ? { blueprint: { appId: agentBots.blueprintId, clientSecret: agentBots.clientSecret } } : {})
  })
  return parsed.success ? parsed.data : undefined
}

/** A customer row of the deployment app: its app, a tenant other than the app's home, and the home recorded as its token tenant. */
export function isMsTeamsCustomerRow(
  bot: { externalAppId: string | null; platformConfig: Record<string, unknown> | null },
  app: Pick<MsTeamsPlatformApp, 'appId' | 'tenantId'> | undefined
): boolean {
  return !!app && bot.externalAppId === app.appId && bot.platformConfig?.tokenTenantId === app.tenantId
}

/** The anchor the relay answers an unconnected tenant with (§8.4): the app, its home tenant and secret, and the Console's connect page; none unless the page is https. */
export function msTeamsConnectAnchor(
  app: MsTeamsPlatformApp | undefined,
  webAppUrl: string | undefined
): RcMsTeamsAnchor | undefined {
  if (!app || !webAppUrl) return undefined
  const anchor = RcMsTeamsAnchor.safeParse({
    appId: app.appId,
    tenantId: app.tenantId,
    clientSecret: app.clientSecret,
    connectUrl: `${webAppUrl.replace(/\/+$/, '')}/msteams/connect`
  })
  return anchor.success ? anchor.data : undefined
}
