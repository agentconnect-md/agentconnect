// An address's two settings (email-integration.md §4.1), kept in its bot row's public bag: one address is one bot and one integration, never shared.
import { EmailWhoMayWrite } from '@agentconnect.md/protocol'
import type { BotRecord, UserRepo } from '../../persistence/ports.js'

/** Where a session a non-member's message opens goes: whoever can edit the agent when it is read, the organization, or private to one member. */
export type EmailOutsideSessions = { kind: 'editors' } | { kind: 'org' } | { kind: 'member'; userId: string }

export interface EmailAddressSettings {
  whoMayWrite: EmailWhoMayWrite
  outsideSessions: EmailOutsideSessions
}

const WHO_MAY_WRITE_KEY = 'whoMayWrite'
const OUTSIDE_SESSIONS_KEY = 'outsideSessions'
const EDITORS = 'editors'
const USER_PREFIX = 'user:'

/** The stored settings, defaulted: Members, and outside senders' sessions seen by the agent's editors. */
export function emailAddressSettings(bot: Pick<BotRecord, 'platformConfig'>): EmailAddressSettings {
  const bag = bot.platformConfig ?? {}
  const whoMayWrite = EmailWhoMayWrite.safeParse(bag[WHO_MAY_WRITE_KEY]).data ?? 'members'
  const stored = typeof bag[OUTSIDE_SESSIONS_KEY] === 'string' ? bag[OUTSIDE_SESSIONS_KEY] : undefined
  const outsideSessions: EmailOutsideSessions =
    stored === 'org'
      ? { kind: 'org' }
      : stored?.startsWith(USER_PREFIX) && stored.length > USER_PREFIX.length
        ? { kind: 'member', userId: stored.slice(USER_PREFIX.length) }
        : { kind: 'editors' }
  return { whoMayWrite, outsideSessions }
}

/** The bag entries that store a choice; each setting is one key, so a new choice replaces the old one whole. */
export function emailSettingsEntries(settings: EmailAddressSettings): Record<string, string> {
  const outside = settings.outsideSessions
  return {
    [WHO_MAY_WRITE_KEY]: settings.whoMayWrite,
    [OUTSIDE_SESSIONS_KEY]:
      outside.kind === 'member' ? `${USER_PREFIX}${outside.userId}` : outside.kind === 'org' ? 'org' : EDITORS
  }
}

/** Where a non-member's session goes now: the agent's editors, the organization, the picked member while they are an active member, else nowhere, which refuses the message (§4.1). */
export async function emailOutsideSessionOwner(
  orgId: string,
  settings: EmailAddressSettings,
  users: Pick<UserRepo, 'activeMember'>
): Promise<{ editors: true } | { org: true } | { ownerUserId: string } | null> {
  const outside = settings.outsideSessions
  if (outside.kind === 'editors') return { editors: true }
  if (outside.kind === 'org') return { org: true }
  return (await users.activeMember(orgId, outside.userId)) ? { ownerUserId: outside.userId } : null
}
