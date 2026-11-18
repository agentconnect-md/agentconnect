/** Membership on a first sign-in through an organization's active connection (organization-sso.md §4.3). */
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
    const account = await idp.account(subject)
    if (!account || account.primaryEmail === null || account.connectorIds.length === 0) return []
    const domain = account.primaryEmail.slice(account.primaryEmail.lastIndexOf('@') + 1).toLowerCase()
    const joined: string[] = []
    for (const connection of await connections.findByConnectorIds(account.connectorIds)) {
      // Only an active connection grants membership, and only for an address in the organization's verified domains.
      if (connection.activatedAt === null) continue
      if (!(await domains.verifiedDomains(connection.orgId)).includes(domain)) continue
      const outcome = await connections.joinOnce(connection.orgId, userId, connection.id, new Date(clock.now()))
      if (outcome === 'joined') joined.push(connection.orgId)
    }
    return joined
  }
}
