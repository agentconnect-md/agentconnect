// No 'use client' here: pure rules shared by the wizard pane and the settings fragment.

import { ApiError } from '@/lib/api'

// The protocol's MSTEAMS_MESSAGES_PATH, restated because the console may value-import only leaf protocol modules; setup.test.ts keeps them equal.
export const MSTEAMS_MESSAGES_PATH = '/msteams/messages'

/** The file name the Control Plane gives the package. */
export const MSTEAMS_APP_PACKAGE_FILENAME = 'agentconnect-teams.zip'

/** The Teams Developer Portal's bot management page, where a bot is registered without an Azure subscription. */
export const MSTEAMS_BOT_PORTAL_URL = 'https://dev.teams.microsoft.com/tools/bots'

/** The Teams admin center's Manage apps page, where the package is uploaded. */
export const MSTEAMS_ADMIN_APPS_URL = 'https://admin.teams.microsoft.com/policies/manage-apps'

/** The messaging endpoint to paste into the bot registration: the relay's public origin plus the module route. */
export function msTeamsMessagesUrl(relayPublicUrl: string | null): string | null {
  return relayPublicUrl ? `${relayPublicUrl.replace(/\/+$/, '')}${MSTEAMS_MESSAGES_PATH}` : null
}

// The Control Plane's own GUID rule for both IDs, in any case.
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function guidOk(value: string): boolean {
  return GUID.test(value.trim())
}

/** Every `MSTEAMS_*` refusal the Control Plane sends, each mapped to the sentence that names its fix. */
export const MSTEAMS_ERROR_KEYS = {
  MSTEAMS_SECRET_INVALID: 'secretInvalid',
  MSTEAMS_APP_NOT_FOUND: 'appNotFound',
  MSTEAMS_TENANT_NOT_FOUND: 'tenantNotFound',
  MSTEAMS_CREDENTIALS_INVALID: 'credentialsInvalid',
  MSTEAMS_CHECK_UNAVAILABLE: 'unavailable',
  MSTEAMS_RELAY_ORIGIN_MISSING: 'relayOriginMissing'
} as const

export type MsTeamsErrorKey = (typeof MSTEAMS_ERROR_KEYS)[keyof typeof MSTEAMS_ERROR_KEYS] | 'appTaken'

/** A failed call's message: the mapped sentence for a known code (a code-less 409 is the taken bot), else the Control Plane's own words. */
export function msTeamsErrorMessage(error: unknown, translate: (key: `errors.${MsTeamsErrorKey}`) => string): string {
  if (error instanceof ApiError) {
    const code = error.code
    if (code && Object.hasOwn(MSTEAMS_ERROR_KEYS, code)) {
      return translate(`errors.${MSTEAMS_ERROR_KEYS[code as keyof typeof MSTEAMS_ERROR_KEYS]}`)
    }
    if (error.status === 409 && !code) return translate('errors.appTaken')
  }
  return error instanceof Error ? error.message : String(error)
}
