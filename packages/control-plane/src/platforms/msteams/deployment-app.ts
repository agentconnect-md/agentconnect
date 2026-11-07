// The deployment-owned Teams app (teams-integration.md §8.2), projected from the Setup Server's `msTeams` slice; all three keys or none.
import { createHmac } from 'node:crypto'
import { z, type ZodRawShape } from 'zod'
import { RcMsTeamsAnchor, RcMsTeamsDeploymentApp } from '@agentconnect.md/protocol'
import type { BotSecretMaterial } from '../../persistence/ports.js'

export const MsTeamsCpEnvSchema = {
  MSTEAMS_PLATFORM_APP_ID: z.string().optional(),
  MSTEAMS_PLATFORM_TENANT_ID: z.string().optional(),
  MSTEAMS_PLATFORM_CLIENT_SECRET: z.string().optional(),
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

/** What a deployment app's row stores in its secret slot: a marker, not a secret, since the app's secret never leaves the deployment (§8.5). */
export const MSTEAMS_DEPLOYMENT_SECRET_MARKER = 'msteams-deployment-app:no-secret'

export function msTeamsDeploymentSecrets(): BotSecretMaterial {
  return { botToken: MSTEAMS_DEPLOYMENT_SECRET_MARKER, appToken: null, signingSecret: null }
}

/** The key relays sign conversation tickets with, derived from the pepper like the CP's other signing keys; base64url. */
export function msTeamsRelayTicketKey(pepper: string): string {
  return createHmac('sha256', pepper).update('msteams-relay-ticket-v1').digest('base64url')
}

/** The deployment app as the relay sends its rows' egress with (§8.5); none without an app. */
export function msTeamsRelayApp(
  app: MsTeamsPlatformApp | undefined,
  pepper: string
): RcMsTeamsDeploymentApp | undefined {
  if (!app) return undefined
  const parsed = RcMsTeamsDeploymentApp.safeParse({
    appId: app.appId,
    tenantId: app.tenantId,
    clientSecret: app.clientSecret,
    ticketKey: msTeamsRelayTicketKey(pepper)
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
