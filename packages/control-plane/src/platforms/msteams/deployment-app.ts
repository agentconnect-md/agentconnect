// The deployment-owned Teams app (teams-integration.md §8.2), projected from the Setup Server's `msTeams` slice; all three keys or none.
import { z, type ZodRawShape } from 'zod'

export const MsTeamsCpEnvSchema = {
  MSTEAMS_PLATFORM_APP_ID: z.string().optional(),
  MSTEAMS_PLATFORM_TENANT_ID: z.string().optional(),
  MSTEAMS_PLATFORM_CLIENT_SECRET: z.string().optional()
} satisfies ZodRawShape

export interface MsTeamsPlatformApp {
  appId: string
  /** The app's home tenant, which issues the bot's tokens for every customer tenant. */
  tenantId: string
  /** Secret material, never logged or returned. */
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

/** A customer row of the deployment app: its app, a tenant other than the app's home, and the home recorded as its token tenant. */
export function isMsTeamsCustomerRow(
  bot: { externalAppId: string | null; platformConfig: Record<string, unknown> | null },
  app: Pick<MsTeamsPlatformApp, 'appId' | 'tenantId'> | undefined
): boolean {
  return !!app && bot.externalAppId === app.appId && bot.platformConfig?.tokenTenantId === app.tenantId
}
