/** The sign-in check organization SSO adds (organization-sso.md §5): an organization's connection speaks only for addresses in that organization's verified domains. */
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'
import type { OrgSsoDomainService } from './domains.js'
import type { OrgSsoIdp } from './idp.js'

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

export class OrgSsoAdmission {
  constructor(
    private readonly deps: {
      connections: OrgSsoConnectionRepo
      domains: OrgSsoDomainService
      idp: OrgSsoIdp
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  /** False refuses the subject. An account that never reached this deployment is also removed from the identity service. */
  async admit(subject: string): Promise<boolean> {
    const { connections, domains, idp, log } = this.deps
    const account = await idp.account(subject)
    if (!account || account.connectorIds.length === 0) return true
    const owned = await connections.findByConnectorIds(account.connectorIds)
    if (owned.length === 0) return true
    // No address is not an address inside the domains: the provider withheld it or sent it unverified, and the account would belong to nobody.
    const domain = account.primaryEmail === null ? null : domainOf(account.primaryEmail)
    for (const connection of owned) {
      if (domain !== null && (await domains.verifiedDomains(connection.orgId)).includes(domain)) continue
      // Only an account with nothing here is removed; one that already has a local user is refused and left for an administrator.
      const removed = !(await connections.subjectIsProvisioned(subject))
      if (removed) await idp.deleteAccount(subject)
      await connections.recordRefusal(connection.orgId, { connectionId: connection.id, subject, removed })
      log?.warn({ connectionId: connection.id, removed }, 'org sso: refused an account outside the verified domains')
      return false
    }
    return true
  }
}
