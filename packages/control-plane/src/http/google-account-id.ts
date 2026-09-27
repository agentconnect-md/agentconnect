// Records a console user's Google account id from the identity provider, never from the console token (google-chat-integration.md §10.6).
import type { UserRepo } from '../persistence/ports.js'

/** The identity provider's read of a subject's linked Google identity; the composition root passes the Logto service. */
export interface GoogleAccountIdentity {
  googleAccountIdFor(sub: string, fresh?: boolean): Promise<string | null>
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
