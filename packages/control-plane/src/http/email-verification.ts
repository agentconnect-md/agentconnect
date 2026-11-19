// Records whether a console user's stored address is one a sign-in method verified, read from the identity provider and never from the console token.
import type { Clock } from '../domain/clock.js'
import type { UserRepo } from '../persistence/ports.js'

/** The identity provider's read of the addresses a subject's linked social sign-in methods report; the composition root passes the Logto service. */
export interface VerifiedEmailIdentity {
  socialEmailsFor(sub: string): Promise<string[]>
}

/** Read what the linked sign-in methods vouch for and record whether the stored address is among it. */
export async function syncEmailVerification(
  deps: { identity: VerifiedEmailIdentity; users: Pick<UserRepo, 'recordVerifiedEmails'>; clock: Pick<Clock, 'now'> },
  input: { userId: string; oidcSubject: string }
): Promise<void> {
  const emails = await deps.identity.socialEmailsFor(input.oidcSubject)
  await deps.users.recordVerifiedEmails(input.userId, emails, new Date(deps.clock.now()))
}
