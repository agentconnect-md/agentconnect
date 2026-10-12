// How a synced platform's chat member is matched to a console account (§7.4): by the id they act under, or by a cross-app id their events carry beside it.
import type { InteractionActor } from './contract.js'

/** Platforms whose events name a person by an app-scoped id, so a match needs the cross-app `memberId` instead (Feishu/Lark: open_id vs union_id). */
const MATCHED_BY_MEMBER_ID = new Set(['feishu'])

/** The id `actor` is matched to a console account by on `platform`; undefined when the platform needs one the actor does not carry. */
export function chatMemberKey(platform: string, actor: InteractionActor): string | undefined {
  return MATCHED_BY_MEMBER_ID.has(platform) ? actor.memberId : actor.userId
}
