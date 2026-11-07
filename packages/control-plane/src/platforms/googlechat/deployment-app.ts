// Which Google Chat rows are the deployment app's (google-chat-integration.md §10.10), by what they store: its key stays on the CP and the relay, and never on a row.
import { RcGoogleChatDeploymentApp } from '@agentconnect.md/protocol'
import type { GoogleChatPlatformAppConfig } from '../../config/google-chat-platform.js'
import type { BotSecretMaterial } from '../../persistence/ports.js'

/** The `platformConfig` entry every deployment app's row carries, so it is one whatever the deployment's settings say later. */
export const GOOGLE_CHAT_ROW_OWNER_KEY = 'appOwner'
export const GOOGLE_CHAT_DEPLOYMENT_OWNER = 'deployment'

/** What a deployment app's row stores in its secret slot: a marker, not a key, and proof of ownership on its own. */
export const GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER = 'googlechat-deployment-app:no-key'

export function googleChatDeploymentSecrets(): BotSecretMaterial {
  return { botToken: GOOGLE_CHAT_DEPLOYMENT_KEY_MARKER, appToken: null, signingSecret: null }
}

/** A row of the configured deployment app, named by its project number. */
export function usesGoogleChatDeploymentApp(
  bot: { externalAppId: string | null },
  app: Pick<GoogleChatPlatformAppConfig, 'projectNumber'> | undefined
): boolean {
  return !!app && bot.externalAppId === app.projectNumber
}

/** A deployment app's row by facts stored on it: the owner entry, or the prebuilt flag every claim has written; or by the configured project. A tenant key alone proves nothing: an organization's own app can be keyed by its customer too. */
export function isGoogleChatDeploymentRow(
  bot: { externalAppId: string | null; prebuilt?: boolean; platformConfig?: Record<string, unknown> | null },
  app?: Pick<GoogleChatPlatformAppConfig, 'projectNumber'>
): boolean {
  return (
    bot.platformConfig?.[GOOGLE_CHAT_ROW_OWNER_KEY] === GOOGLE_CHAT_DEPLOYMENT_OWNER ||
    bot.prebuilt === true ||
    usesGoogleChatDeploymentApp(bot, app)
  )
}

/** The deployment app as the relay sends its customer rows' calls with (§10.10); none without an app. */
export function googleChatRelayApp(
  app: Pick<GoogleChatPlatformAppConfig, 'projectNumber' | 'serviceAccountKey'> | undefined
): RcGoogleChatDeploymentApp | undefined {
  if (!app) return undefined
  const parsed = RcGoogleChatDeploymentApp.safeParse({
    projectNumber: app.projectNumber,
    serviceAccountKey: app.serviceAccountKey
  })
  return parsed.success ? parsed.data : undefined
}
