// Records what a console user's linked sign-in methods say about the stored address, read from the identity provider and never from the console token.
import type { Clock } from '../domain/clock.js'
import type { UserRepo } from '../persistence/ports.js'

/** The identity provider's read of a subject's linked sign-in methods; the composition root passes the Logto service. */
export interface VerifiedEmailIdentity {
  /** Addresses the linked social sign-in methods report. */
  socialEmailsFor(sub: string): Promise<string[]>
  /** The SSO identities the account holds, each with the address its connector asserted. */
  ssoIdentitiesFor(sub: string, fresh?: boolean): Promise<{ connectorId: string; email?: string }[]>
}

/** The deployment's own connector as its configuration describes it. */
export interface DeploymentSsoConnector {
  connectorId: string
  protocol: 'oidc' | 'saml'
  oidc: { trustUnverifiedEmail: boolean } | null
}

/** The deployment connector's id when it passes on only addresses its provider marks verified; SAML carries no such mark, so it never qualifies. */
export function verifyingConnectorId(connector: DeploymentSsoConnector | null | undefined): string | null {
  if (!connector || connector.protocol !== 'oidc' || !connector.oidc) return null
  return connector.oidc.trustUnverifiedEmail ? null : connector.connectorId
}

/** Read what the linked sign-in methods say and record it against the stored address. */
export async function syncEmailVerification(
  deps: {
    identity: VerifiedEmailIdentity
    users: Pick<UserRepo, 'recordEmailEvidence'>
    clock: Pick<Clock, 'now'>
    /** `verifyingConnectorId` of the deployment's connector. */
    verifyingConnectorId?: string | null
  },
  input: { userId: string; oidcSubject: string }
): Promise<void> {
  const [social, identities] = await Promise.all([
    deps.identity.socialEmailsFor(input.oidcSubject),
    // Read afresh: a sign-in through a connector new to the account is what brings this sync back.
    deps.identity.ssoIdentitiesFor(input.oidcSubject, true)
  ])
  const asserted = identities.flatMap(({ connectorId, email }) => (email ? [{ connectorId, email }] : []))
  const verifying = deps.verifyingConnectorId ?? null
  const verified = [
    ...social,
    ...asserted.filter((identity) => identity.connectorId === verifying).map((identity) => identity.email)
  ]
  await deps.users.recordEmailEvidence(input.userId, { verified, asserted }, new Date(deps.clock.now()))
}
