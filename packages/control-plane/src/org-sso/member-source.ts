/** Which organization, if any, an address's domain makes its account a member of (organization-sso.md §4.3). */
import type { OrgRepo } from '../persistence/ports.js'

export type MemberSourceChoice = 'invite' | 'domain'

/** One source answers for the whole deployment: its own SSO connector's, or its organizations'. */
export interface MemberSource {
  /** The organization a lower-cased domain joins its accounts to, or null. */
  joinableOrg(domain: string): Promise<string | null>
}

/** Organizations own their connections: the one that verified the domain and takes members by domain. */
export class OrganizationMemberSource implements MemberSource {
  constructor(private readonly domains: { joinableOrg(domain: string): Promise<string | null> }) {}

  joinableOrg(domain: string): Promise<string | null> {
    return this.domains.joinableOrg(domain)
  }
}

/** The deployment owns one connector: its domains join the deployment's only organization. */
export class DeploymentMemberSource implements MemberSource {
  private readonly domains: ReadonlySet<string>
  private warned = false

  constructor(
    private readonly deps: {
      connector: { memberSource: MemberSourceChoice; domains: readonly string[] }
      orgs: Pick<OrgRepo, 'listIds'>
      log: { warn(obj: object, msg: string): void }
    }
  ) {
    this.domains = new Set(deps.connector.domains.map((domain) => domain.toLowerCase()))
  }

  async joinableOrg(domain: string): Promise<string | null> {
    if (this.deps.connector.memberSource !== 'domain' || !this.domains.has(domain.toLowerCase())) return null
    const ids = await this.deps.orgs.listIds(2)
    if (ids.length === 1) return ids[0]!
    if (!this.warned) {
      this.warned = true
      this.deps.log.warn(
        { organizations: ids.length === 0 ? 'none' : 'several' },
        'SSO sign-in joined no organization: the deployment needs exactly one'
      )
    }
    return null
  }
}

/** The single resolution point: the deployment's connector when it declares one, else its organizations' connections, else none. */
export function resolveMemberSource(input: {
  deploymentConnector: { memberSource: MemberSourceChoice; domains: readonly string[] } | null | undefined
  organizationDomains: { joinableOrg(domain: string): Promise<string | null> } | undefined
  orgs: Pick<OrgRepo, 'listIds'>
  log: { warn(obj: object, msg: string): void }
}): MemberSource | undefined {
  if (input.deploymentConnector) {
    return new DeploymentMemberSource({ connector: input.deploymentConnector, orgs: input.orgs, log: input.log })
  }
  if (input.organizationDomains) return new OrganizationMemberSource(input.organizationDomains)
  return undefined
}
