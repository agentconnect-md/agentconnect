// Who a transcript's sender is to the signed-in reader: the one reading the session page, its thread panel and the sessions list share.
import { useMemo } from 'react'
import { memberDisplayName, type MeDto, type MemberDto } from '@/lib/api'
import { isSelfSender } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { sessionSenderLabel } from '@/lib/session-trigger'

/** A sender's reading; `sender` is the identity a row is known by (`senderIdentity`), not its raw platform id. */
export interface SenderPeople {
  /** The signed-in reader wrote it. */
  isSelf(sender?: string | null): boolean
  /** "You", an agent's or a member's console name, else what the platform called them. */
  label(sender: string | null | undefined, fallback?: string): string
  /** A member's console photo. */
  pictureOf(sender: string): string | undefined
  /** The reader's own face. */
  viewer: { picture?: string | null; initials?: string }
}

/** Members by the identities a row can carry: their user id, and the email older rows hold. */
export function memberNamesByIdentity(members: readonly MemberDto[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const member of members) {
    const label = memberDisplayName(member)
    names.set(member.userId, label)
    if (member.email) names.set(member.email, label)
  }
  return names
}

function memberPictures(members: readonly MemberDto[]): Map<string, string> {
  const pictures = new Map<string, string>()
  for (const member of members) {
    if (!member.picture) continue
    pictures.set(member.userId, member.picture)
    if (member.email) pictures.set(member.email, member.picture)
  }
  // Webchat rows once held the author's display name: a last resort after the identity keys, first writer wins, never an access input.
  for (const member of members) {
    if (!member.picture) continue
    const label = memberDisplayName(member)
    if (!pictures.has(label)) pictures.set(label, member.picture)
  }
  return pictures
}

export function senderPeople(
  members: readonly MemberDto[],
  me: MeDto | null,
  viewer: SenderPeople['viewer'],
  agentNameById: ReadonlyMap<string, string>
): SenderPeople {
  const names = memberNamesByIdentity(members)
  const pictures = memberPictures(members)
  return {
    isSelf: (sender) => isSelfSender(sender, me),
    label: (sender, fallback) => sessionSenderLabel(sender, fallback, agentNameById, names, me),
    pictureOf: (sender) => pictures.get(sender),
    viewer
  }
}

export function useSenderPeople(agentNameById: ReadonlyMap<string, string>): SenderPeople {
  const { members } = useConsoleData()
  const { user: viewer, me } = useProfile()
  return useMemo(() => senderPeople(members, me, viewer, agentNameById), [members, me, viewer, agentNameById])
}
