// The deployment-owned Google Chat app (google-chat-integration.md §3), configured in the Setup Server; all three keys or none.
import type { AppConfig } from './env.js'

export interface GoogleChatPlatformAppConfig {
  projectId: string
  projectNumber: string
  /** Service-account key JSON; secret material, never logged or returned. */
  serviceAccountKey: string
}

type GoogleChatPlatformEnvSlice = Pick<
  AppConfig,
  'GOOGLE_CHAT_PLATFORM_PROJECT_ID' | 'GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER' | 'GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY'
>

/** Undefined ⇒ no deployment-owned app. Throws on a partial set. */
export function resolveGoogleChatPlatformAppConfig(
  config: GoogleChatPlatformEnvSlice
): GoogleChatPlatformAppConfig | undefined {
  const present = {
    GOOGLE_CHAT_PLATFORM_PROJECT_ID: config.GOOGLE_CHAT_PLATFORM_PROJECT_ID !== undefined,
    GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER: config.GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER !== undefined,
    GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY: config.GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY !== undefined
  }
  const set = Object.values(present).filter(Boolean).length
  if (set === 0) return undefined
  if (set < 3) {
    const missing = Object.entries(present)
      .filter(([, ok]) => !ok)
      .map(([key]) => key)
    throw new Error(
      `google chat platform app config is partial — missing ${missing.join(', ')} (set all three or none)`
    )
  }
  return {
    projectId: config.GOOGLE_CHAT_PLATFORM_PROJECT_ID!,
    projectNumber: config.GOOGLE_CHAT_PLATFORM_PROJECT_NUMBER!,
    serviceAccountKey: config.GOOGLE_CHAT_PLATFORM_SERVICE_ACCOUNT_KEY!
  }
}
