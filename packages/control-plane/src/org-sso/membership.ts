/** Membership by an address on a domain the deployment's member source names (organization-sso.md §4.3). */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'
import type { OrgSsoIdp } from './idp.js'
import type { MemberSource } from './member-source.js'

export class OrgSsoMembership {
  constructor(
    private readonly deps: {
      connections: Pick<OrgSsoConnectionRepo, 'joinOnce'>
      source: MemberSource
      idp: Pick<OrgSsoIdp, 'account'>
      clock: Clock
    }
  ) {}

  /** The organizations the caller just became a member of. Reads the identity service afresh, and is idempotent on the join record. */
  async join(subject: string, userId: string): Promise<string[]> {
    const { connections, source, idp, clock } = this.deps
    const email = (await idp.account(subject))?.primaryEmail ?? null
    if (email === null) return []
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    const orgId = await source.joinableOrg(domain)
    if (orgId === null) return []
    const outcome = await connections.joinOnce(orgId, userId, domain, new Date(clock.now()))
    return outcome === 'joined' ? [orgId] : []
  }
}
