// Slack's external-place signal (assistant-mode.md §5.3), read from the membership listing both Slack arms already make.
import type { PlaceExternalReason } from '@agentconnect.md/protocol'

/** The flags a `users.conversations` entry carries for a channel shared with another organization. */
interface SlackSharedFlags {
  is_ext_shared?: boolean
  is_pending_ext_shared?: boolean
}

/** A Slack Connect channel (or one invited to become one) is external; null means the listing found no share. */
export function slackExternalReason(listed: object): PlaceExternalReason | null {
  const channel = listed as SlackSharedFlags
  return channel.is_ext_shared === true || channel.is_pending_ext_shared === true ? 'externallyShared' : null
}
