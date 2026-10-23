import { msTeamsMessagesUrl } from '@agentconnect.md/protocol'
import type { ProviderAppConfig } from './provider-app.js'

/** Microsoft Entra's app registrations, where the operator registers the multi-tenant app and its secret. */
export const MSTEAMS_APP_REGISTRATIONS_URL =
  'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'

export interface MsTeamsConfiguredUrls {
  /** The bot registration's messaging endpoint. */
  messagingEndpoint: string
  /** The Console page Microsoft returns an administrator to after consent (teams-integration.md §8.3). */
  connectRedirectUri: string
  registrationsUrl: string
}

/** Teams has no API to register a bot, so setup only publishes what to enter by hand. */
export function msTeamsConfiguredUrls(config: ProviderAppConfig): MsTeamsConfiguredUrls {
  const { relay, web } = config.services
  if (!relay || new URL(relay).protocol !== 'https:') {
    throw new Error('the Teams app requires a saved HTTPS ingress public URL')
  }
  if (!web || new URL(web).protocol !== 'https:') {
    throw new Error('the Teams app requires a saved HTTPS console URL')
  }
  return {
    messagingEndpoint: msTeamsMessagesUrl(relay),
    connectRedirectUri: `${web.replace(/\/+$/, '')}/msteams/connect`,
    registrationsUrl: MSTEAMS_APP_REGISTRATIONS_URL
  }
}
