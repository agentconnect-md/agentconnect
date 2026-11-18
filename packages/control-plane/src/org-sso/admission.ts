/** The sign-in check organization SSO adds (organization-sso.md §5): an organization's connection speaks only for addresses in that organization's verified domains. */
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'
import type { OrgSsoDomainService } from './domains.js'
import type { OrgSsoIdp } from './idp.js'

/** The 403 a refused account answers with: the connection gave it no address in the organization's verified domains. */
export interface OrgSsoRefusal {
  code: 'SSO_ADDRESS_REQUIRED'
  message: string
  details: { attributes: string[]; addressAttributes: string[] }
}

const bounded = (names: readonly string[]): string[] =>
  names.slice(0, MAX_ATTRIBUTES).map((name) => name.slice(0, MAX_ATTRIBUTE_LENGTH))

// The names come from the provider, so a hostile one must not inflate the response.
const MAX_ATTRIBUTES = 50
const MAX_ATTRIBUTE_LENGTH = 200

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

  /** A refusal refuses the subject. An account that never reached this deployment is also removed from the identity service. */
  async admit(subject: string): Promise<true | OrgSsoRefusal> {
    const { connections, domains, idp, log } = this.deps
    const account = await idp.account(subject)
    if (!account || account.connectorIds.length === 0) return true
    const owned = await connections.findByConnectorIds(account.connectorIds)
    if (owned.length === 0) return true
    // No address is not an address inside the domains: the provider sent none, and the account would belong to nobody.
    const domain = account.primaryEmail === null ? null : domainOf(account.primaryEmail)
    for (const connection of owned) {
      const verified = await domains.verifiedDomains(connection.orgId)
      if (domain !== null && verified.includes(domain)) continue
      // Read before the account is removed: the names show the owner which attribute carries the address.
      const attributes = bounded(account.attributeNames[connection.logtoConnectorId] ?? [])
      const addressAttributes = bounded(
        (account.addressAttributes[connection.logtoConnectorId] ?? [])
          .filter((attribute) => verified.includes(attribute.domain))
          .map((attribute) => attribute.name)
      )
      // Only an account with nothing here is removed; one that already has a local user is refused and left for an administrator.
      const removed = !(await connections.subjectIsProvisioned(subject))
      if (removed) await idp.deleteAccount(subject)
      await connections.recordRefusal(connection.orgId, { connectionId: connection.id, subject, removed })
      log?.warn({ connectionId: connection.id, removed }, 'org sso: refused an account outside the verified domains')
      return {
        code: 'SSO_ADDRESS_REQUIRED',
        message: 'the organization connection gave this account no address in its verified domains',
        details: { attributes, addressAttributes }
      }
    }
    return true
  }
}
