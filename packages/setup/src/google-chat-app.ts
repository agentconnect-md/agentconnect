import { googleChatEventsUrl } from '@agentconnect.md/protocol'
import type { ProviderAppConfig } from './provider-app.js'

/** The generic Chat API configuration page; a project-specific URL would not resolve for another operator. */
export const GOOGLE_CHAT_CONFIGURATION_URL =
  'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat'

export interface GoogleChatConfiguredUrls {
  /** The Workspace add-on's HTTP endpoint URL, which is also every request token's audience (§11.2). */
  callbackUrl: string
  configurationUrl: string
}

/** Google has no public Chat app creation API, so setup only publishes what to enter by hand (§3). */
export function googleChatConfiguredUrls(config: ProviderAppConfig): GoogleChatConfiguredUrls {
  const relay = config.services.relay
  if (!relay || new URL(relay).protocol !== 'https:') {
    throw new Error('the Google Chat app requires a saved HTTPS ingress public URL')
  }
  return {
    callbackUrl: googleChatEventsUrl(relay),
    configurationUrl: GOOGLE_CHAT_CONFIGURATION_URL
  }
}
