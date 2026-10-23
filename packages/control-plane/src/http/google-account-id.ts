// Records a console user's Google account id from the identity provider, never from the console token (google-chat-integration.md §10.6).
import type { UserRepo } from '../persistence/ports.js'

/** The identity provider's read of a subject's linked Google identity; the composition root passes the Logto service. */
export interface GoogleAccountIdentity {
  googleAccountIdFor(sub: string, fresh?: boolean): Promise<string | null>
  /** The linked Google identity's email; absent ⇒ a claimed Workspace is not named. */
  googleAccountEmailFor?(sub: string): Promise<string | null>
}

// Consumer Google accounts share these domains, so they name no Workspace.
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/** A Workspace label from a Google account email: its lowercase domain, or undefined for a consumer or malformed address. */
export function googleWorkspaceDomainOf(email: string | null | undefined): string | undefined {
  const domain = email?.split('@')[1]?.trim().toLowerCase()
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || CONSUMER_GOOGLE_DOMAINS.has(domain)) return undefined
  return domain
}

/** Read the linked Google identity, store it when it changed, and return what the provider reported. */
export async function syncGoogleAccountId(
  deps: { identity: GoogleAccountIdentity; users: Pick<UserRepo, 'getGoogleAccountId' | 'setGoogleAccountId'> },
  input: { userId: string; oidcSubject: string; fresh?: boolean }
): Promise<string | null> {
  const [reported, recorded] = await Promise.all([
    deps.identity.googleAccountIdFor(input.oidcSubject, input.fresh),
    deps.users.getGoogleAccountId(input.userId)
  ])
  if (reported !== recorded) await deps.users.setGoogleAccountId(input.userId, reported)
  return reported
}
