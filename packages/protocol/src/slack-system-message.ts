/** Slack's platform-defined sender for system notifications such as membership changes. */
const SLACK_SYSTEM_USER_ID = 'USLACK'

/** System notifications are not user turns and must never enter agent routing. */
export function isSlackSystemMessage(message: { user?: unknown }): boolean {
  return message.user === SLACK_SYSTEM_USER_ID
}
