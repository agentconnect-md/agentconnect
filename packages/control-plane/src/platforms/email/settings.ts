// An address's two settings (email-integration.md §4.1), kept in its bot row's public bag: one address is one bot and one integration, never shared.
import { EmailWhoMayWrite } from '@agentconnect.md/protocol'
import type { BotRecord, IntegrationRecord, UserRepo } from '../../persistence/ports.js'

/** Where a session a non-member's message opens goes: the organization, or private to one member, unset once that member is gone. */
export type EmailOutsideSessions = { kind: 'org' } | { kind: 'member'; userId: string | null }

export interface EmailAddressSettings {
  whoMayWrite: EmailWhoMayWrite
  outsideSessions: EmailOutsideSessions
}

const WHO_MAY_WRITE_KEY = 'whoMayWrite'
const OUTSIDE_SESSIONS_KEY = 'outsideSessions'
const USER_PREFIX = 'user:'

/** The stored settings, defaulted: Members, and outside senders' sessions private to the member who added the address. */
export function emailAddressSettings(
  bot: Pick<BotRecord, 'platformConfig'>,
  integration: Pick<IntegrationRecord, 'createdByUserId'> | undefined
): EmailAddressSettings {
  const bag = bot.platformConfig ?? {}
  const whoMayWrite = EmailWhoMayWrite.safeParse(bag[WHO_MAY_WRITE_KEY]).data ?? 'members'
  const stored = typeof bag[OUTSIDE_SESSIONS_KEY] === 'string' ? bag[OUTSIDE_SESSIONS_KEY] : undefined
  const outsideSessions: EmailOutsideSessions =
    stored === 'org'
      ? { kind: 'org' }
      : stored?.startsWith(USER_PREFIX) && stored.length > USER_PREFIX.length
        ? { kind: 'member', userId: stored.slice(USER_PREFIX.length) }
        : { kind: 'member', userId: integration?.createdByUserId ?? null }
  return { whoMayWrite, outsideSessions }
}

/** The bag entries that store a choice; each setting is one key, so a new choice replaces the old one whole. */
export function emailSettingsEntries(settings: {
  whoMayWrite: EmailWhoMayWrite
  outsideSessions: { kind: 'org' } | { kind: 'member'; userId: string }
}): Record<string, string> {
  return {
    [WHO_MAY_WRITE_KEY]: settings.whoMayWrite,
    [OUTSIDE_SESSIONS_KEY]:
      settings.outsideSessions.kind === 'org' ? 'org' : `${USER_PREFIX}${settings.outsideSessions.userId}`
  }
}

/** Where a non-member's session goes now: the organization, the picked member while they are an active member, else nowhere, which refuses the message (§4.1). */
export async function emailOutsideSessionOwner(
  orgId: string,
  settings: EmailAddressSettings,
  users: Pick<UserRepo, 'activeMember'>
): Promise<{ org: true } | { ownerUserId: string } | null> {
  if (settings.outsideSessions.kind === 'org') return { org: true }
  const { userId } = settings.outsideSessions
  if (!userId) return null
  return (await users.activeMember(orgId, userId)) ? { ownerUserId: userId } : null
}
