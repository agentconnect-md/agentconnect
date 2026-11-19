/** Membership by an address on an organization's verified domain (organization-sso.md §4.3). */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'
import type { OrgSsoDomainService } from './domains.js'
import type { OrgSsoIdp } from './idp.js'

export class OrgSsoMembership {
  constructor(
    private readonly deps: {
      connections: OrgSsoConnectionRepo
      domains: OrgSsoDomainService
      idp: OrgSsoIdp
      clock: Clock
    }
  ) {}

  /** The organizations the caller just became a member of. Reads the identity service afresh, and is idempotent on the join record. */
  async join(subject: string, userId: string): Promise<string[]> {
    const { connections, domains, idp, clock } = this.deps
    const email = (await idp.account(subject))?.primaryEmail ?? null
    if (email === null) return []
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
    // A domain is verified by one organization, and only one that takes its domains' addresses as members grants this.
    const orgId = await domains.joinableOrg(domain)
    if (orgId === null) return []
    const outcome = await connections.joinOnce(orgId, userId, domain, new Date(clock.now()))
    return outcome === 'joined' ? [orgId] : []
  }
}
