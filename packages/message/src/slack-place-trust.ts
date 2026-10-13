// Slack's external-place signals (assistant-mode.md §5.3), shared by the Socket Mode and HTTP arms.
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

/** Whether an Events API envelope says its event happened in a Slack Connect channel (`is_ext_shared_channel`). */
export function slackEnvelopeExternallyShared(envelope: unknown): boolean {
  return (envelope as { is_ext_shared_channel?: unknown } | undefined)?.is_ext_shared_channel === true
}

/** The installing organization, as `auth.test` names it: its workspace and, on Enterprise Grid, its enterprise. */
export interface SlackHomeOrganization {
  teamId?: string
  enterpriseId?: string
}

/** The `users.info` fields that say whether someone is a full member of the installing organization. */
interface SlackMemberFlags {
  is_restricted?: boolean
  is_ultra_restricted?: boolean
  is_stranger?: boolean
  is_bot?: boolean
  deleted?: boolean
  team_id?: string
  enterprise_user?: { enterprise_id?: string }
}

/** A guest, or a member of another organization, makes the place they joined external; null for a full member. */
export function slackMemberExternalReason(user: object, home: SlackHomeOrganization): PlaceExternalReason | null {
  const member = user as SlackMemberFlags
  if (member.is_restricted === true || member.is_ultra_restricted === true) return 'guestMember'
  // Another workspace of the same Enterprise Grid organization is still the same organization.
  const enterprise = member.enterprise_user?.enterprise_id
  if (home.enterpriseId && enterprise) return enterprise === home.enterpriseId ? null : 'externalMember'
  return home.teamId && member.team_id && member.team_id !== home.teamId ? 'externalMember' : null
}

/** A full member of the installing workspace, who may approve a draft (assistant-mode.md §5.5): stricter than the reason above, so another Grid workspace's member is not one. */
export function slackFullMember(user: object, home: SlackHomeOrganization): boolean {
  const member = user as SlackMemberFlags
  return (
    home.teamId !== undefined &&
    home.teamId !== '' &&
    member.team_id === home.teamId &&
    member.is_restricted !== true &&
    member.is_ultra_restricted !== true &&
    member.is_stranger !== true &&
    member.is_bot !== true &&
    member.deleted !== true
  )
}
