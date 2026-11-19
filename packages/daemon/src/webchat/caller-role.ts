import type { ChatCallerRole } from '@agentconnect.md/protocol'

/** What a webchat author whose role may not change runtime settings is told, on their own browser only. */
export const WEBCHAT_SETTINGS_REFUSAL =
  'Only an Agent editor or this conversation’s owner can change its runtime settings.'

/** What a webchat author whose role may not start the conversation over is told. */
export const WEBCHAT_NEW_SESSION_REFUSAL = 'Only an Agent editor or this conversation’s owner can start it over.'

/** Whether a webchat author may change the conversation's runtime settings once the level allows it: its editors and its owner; with no verified role (an older relay or Control Plane), today's rule. */
export function webchatRoleChangesSettings(role: ChatCallerRole | undefined): boolean {
  return role !== 'participant'
}
