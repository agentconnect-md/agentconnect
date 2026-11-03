// A leaf, so the task listing reads a coordinator message id without importing the coordinator's prompt.

/** A delivered message's id is its platform id behind this prefix, so a bare timestamp is never read as a number (§4.3). */
export const COORDINATOR_MESSAGE_ID_PREFIX = 'msg-'

/** The id the coordinator names a delivered platform message by. */
export function coordinatorMessageId(platformMessageId: string): string {
  return `${COORDINATOR_MESSAGE_ID_PREFIX}${platformMessageId}`
}

/** The platform's own id behind a coordinator message id, or undefined for an id of another shape. */
export function platformMessageIdOf(messageId: string): string | undefined {
  return messageId.startsWith(COORDINATOR_MESSAGE_ID_PREFIX)
    ? messageId.slice(COORDINATOR_MESSAGE_ID_PREFIX.length) || undefined
    : undefined
}
