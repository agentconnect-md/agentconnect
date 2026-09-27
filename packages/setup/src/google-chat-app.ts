import type { ProviderAppConfig } from './provider-app.js'

/** Relay-terminated Chat interaction events (google-chat-integration.md §2); the relay module must mount this same path. */
export const GOOGLE_CHAT_EVENTS_PATH = '/googlechat/events'

/** The authentication audience the Chat app configuration must select (§2). */
export const GOOGLE_CHAT_AUDIENCE_SETTING = 'Project Number'

/** The generic Chat API configuration page; a project-specific URL would not resolve for another operator. */
export const GOOGLE_CHAT_CONFIGURATION_URL =
  'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat'

export interface GoogleChatConfiguredUrls {
  callbackUrl: string
  audienceSetting: typeof GOOGLE_CHAT_AUDIENCE_SETTING
  configurationUrl: string
}

/** Google has no public Chat app creation API, so setup only publishes what to enter by hand (§3). */
export function googleChatConfiguredUrls(config: ProviderAppConfig): GoogleChatConfiguredUrls {
  const relay = config.services.relay
  if (!relay || new URL(relay).protocol !== 'https:') {
    throw new Error('the Google Chat app requires a saved HTTPS ingress public URL')
  }
  return {
    callbackUrl: `${relay.replace(/\/$/, '')}${GOOGLE_CHAT_EVENTS_PATH}`,
    audienceSetting: GOOGLE_CHAT_AUDIENCE_SETTING,
    configurationUrl: GOOGLE_CHAT_CONFIGURATION_URL
  }
}
