// Slack's place-trust signals (assistant-mode.md §5.3), shared by the Socket Mode and relay HTTP arms; existing members are never enumerated.
import type { PlaceTrustDetection } from '@agentconnect.md/protocol'

/** The channel flags a `users.conversations` / `conversations.info` entry carries. */
export interface SlackChannelTrustFlags {
  is_ext_shared?: boolean
  is_pending_ext_shared?: boolean
}

/** The account flags a `users.info` answer carries. */
export interface SlackUserTrustFlags {
  is_restricted?: boolean
  is_ultra_restricted?: boolean
}

/** A listed channel's level: shared with another organization (or invited to be) is external, otherwise internal. */
export function slackListedChannelTrust(listed: object): PlaceTrustDetection {
  const channel = listed as SlackChannelTrustFlags
  return channel.is_ext_shared === true || channel.is_pending_ext_shared === true
    ? { level: 'external', reason: 'externallyShared' }
    : { level: 'internal', reason: 'verifiedInternal' }
}

/** A multi-channel or single-channel guest; full workspace members are neither. */
export function isSlackGuest(answer: object | undefined): boolean {
  const user = answer as SlackUserTrustFlags | undefined
  return user?.is_restricted === true || user?.is_ultra_restricted === true
}

/** The detection a `channel_shared` event makes for its channel. */
export const SLACK_CHANNEL_SHARED_TRUST: PlaceTrustDetection = { level: 'external', reason: 'channelShared' }

/** The detection a guest joining makes for the channel they joined. */
export const SLACK_GUEST_JOINED_TRUST: PlaceTrustDetection = { level: 'external', reason: 'guestJoined' }

/** Event detections overlaid once on the next successful listing, which may not show a fresh share yet. */
export class SlackPendingTrust {
  private readonly pending = new Map<string, PlaceTrustDetection>()

  /** Record an event detection for one channel. */
  note(channel: string, detection: PlaceTrustDetection): void {
    this.pending.set(channel, detection)
  }

  /** Overlay the pending detections on a successful listing, then forget them. */
  apply<T extends { id: string; trust?: PlaceTrustDetection }>(channels: T[]): T[] {
    if (this.pending.size === 0) return channels
    const out = channels.map((c) => {
      const detection = this.pending.get(c.id)
      return detection ? { ...c, trust: detection } : c
    })
    this.pending.clear()
    return out
  }
}
