// No 'use client' here: pure rules shared by the wizard pane and the settings fragment.

import { ApiError } from '@/lib/api'

// The protocol's GOOGLE_CHAT_EVENTS_PATH, restated because the console may value-import only leaf protocol modules; setup.test.ts keeps them equal.
export const GOOGLE_CHAT_EVENTS_PATH = '/googlechat/events'

/** The Authentication Audience a Chat app that is not a Workspace add-on selects (google-chat-integration.md §2, §11). */
export const GOOGLE_CHAT_AUDIENCE = 'Project Number'

/** Google Cloud Console's Chat API configuration page, where the app's endpoint and audience are entered. */
export const GOOGLE_CHAT_CONFIG_URL = 'https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat'

/** The HTTPS endpoint to copy into the Chat app: the relay's public origin plus the module route. */
export function googleChatCallbackUrl(relayPublicUrl: string | null): string | null {
  return relayPublicUrl ? `${relayPublicUrl.replace(/\/+$/, '')}${GOOGLE_CHAT_EVENTS_PATH}` : null
}

/** A project number is Google's numeric id; empty means "resolve it from the key". */
export function projectNumberOk(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || /^\d+$/.test(trimmed)
}

/** The fields a downloaded service-account key carries; anything else never reaches the Control Plane. */
export function parseServiceAccountKey(raw: string): { projectId: string | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const key = parsed as Record<string, unknown>
  if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') return null
  return { projectId: typeof key.project_id === 'string' ? key.project_id : null }
}

/** Every `GOOGLE_CHAT_*` refusal the Control Plane sends, each mapped to the sentence that names its fix. */
export const GOOGLE_CHAT_ERROR_KEYS = {
  GOOGLE_CHAT_PROJECT_NUMBER_INVALID: 'projectNumberInvalid',
  GOOGLE_CHAT_KEY_INVALID: 'keyInvalid',
  GOOGLE_CHAT_PROJECT_MISMATCH: 'projectMismatch',
  GOOGLE_CHAT_PROJECT_NUMBER_MISMATCH: 'projectNumberMismatch',
  GOOGLE_CHAT_CRM_DISABLED: 'crmDisabled',
  GOOGLE_CHAT_CRM_FORBIDDEN: 'crmForbidden',
  GOOGLE_CHAT_PROJECT_UNRESOLVED: 'projectUnresolved',
  GOOGLE_CHAT_KEY_REJECTED: 'keyRejected',
  GOOGLE_CHAT_APP_UNAVAILABLE: 'appUnavailable',
  GOOGLE_CHAT_UNREACHABLE: 'unreachable',
  GOOGLE_CHAT_DEPLOYMENT_APP: 'deploymentApp'
} as const

export type GoogleChatErrorKey = (typeof GOOGLE_CHAT_ERROR_KEYS)[keyof typeof GOOGLE_CHAT_ERROR_KEYS]

/** A failed call's message: the mapped sentence for a known code, else the Control Plane's own words. */
export function googleChatErrorMessage(error: unknown, translate: (key: `errors.${GoogleChatErrorKey}`) => string) {
  const code = error instanceof ApiError ? error.code : undefined
  const key =
    code && Object.hasOwn(GOOGLE_CHAT_ERROR_KEYS, code)
      ? GOOGLE_CHAT_ERROR_KEYS[code as keyof typeof GOOGLE_CHAT_ERROR_KEYS]
      : null
  if (key) return translate(`errors.${key}`)
  return error instanceof Error ? error.message : String(error)
}

/** What the console can honestly say about a new installation (§3): saved is not connected, and connected does not mean the app is anywhere yet. */
export interface GoogleChatSetupState {
  saved: boolean
  connected: boolean
  added: boolean
}

export function googleChatSetupState(input: {
  saved: boolean
  active: boolean
  credentialAttention: boolean
  relayAvailable: boolean
  agentReady: boolean
  conversations: number
}): GoogleChatSetupState {
  const connected =
    input.saved && input.active && !input.credentialAttention && input.relayAvailable && input.agentReady
  // A conversation row says the app is in a space or a DM (the daemon lists Spaces and observes traffic); it is not a delivered message.
  return { saved: input.saved, connected, added: connected && input.conversations > 0 }
}
