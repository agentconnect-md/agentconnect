// Who in an organization linked a chat identity, found from the chat side: one provider read instead of one per member.
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import type { OrgMemberRecord } from '../persistence/ports.js'

export interface LinkedMemberDeps {
  /** Absent on an identity service that cannot look a link up from the chat side. */
  identity: { subjectsLinkedTo?(identity: LinkedChatIdentity): Promise<string[] | undefined> }
  users: { memberByOidcSubject(orgId: string, oidcSubject: string): Promise<OrgMemberRecord | null> }
}

/** The active members who linked this chat identity; undefined when only a scan of the members can tell (the platform keeps the id elsewhere, or the provider gave no answer). */
export async function membersLinkedTo(
  orgId: string,
  identity: LinkedChatIdentity,
  deps: LinkedMemberDeps
): Promise<OrgMemberRecord[] | undefined> {
  const subs = await deps.identity.subjectsLinkedTo?.(identity)
  if (!subs) return undefined
  const members = await Promise.all(subs.map((sub) => deps.users.memberByOidcSubject(orgId, sub)))
  return members.filter((member): member is OrgMemberRecord => member !== null)
}
