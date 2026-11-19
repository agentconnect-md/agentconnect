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

export interface DeploymentConnectorMembers {
  memberSource: MemberSourceChoice
  domains: readonly string[]
  /** The organization new members join; null means the deployment's only one. */
  memberOrganization?: string | null
}

type TargetMiss = 'missing' | 'none' | 'several'

/** The deployment owns one connector: its domains join the organization it names, or else the deployment's only one. */
export class DeploymentMemberSource implements MemberSource {
  private readonly domains: ReadonlySet<string>
  private warned = false

  constructor(
    private readonly deps: {
      connector: DeploymentConnectorMembers
      orgs: Pick<OrgRepo, 'listIds' | 'slugById'>
      log: { warn(obj: object, msg: string): void }
    }
  ) {
    this.domains = new Set(deps.connector.domains.map((domain) => domain.toLowerCase()))
  }

  get choice(): MemberSourceChoice {
    return this.deps.connector.memberSource
  }

  /** The organization this connector's choice applies to, whatever the choice; null when there is none. */
  async target(): Promise<string | null> {
    const found = await this.resolve()
    return typeof found === 'string' ? found : found.orgId
  }

  async joinableOrg(domain: string): Promise<string | null> {
    if (this.deps.connector.memberSource !== 'domain' || !this.domains.has(domain.toLowerCase())) return null
    const found = await this.resolve()
    if (typeof found === 'string') return found
    if (!this.warned) {
      this.warned = true
      this.deps.log.warn(
        { organizations: found.miss },
        found.miss === 'missing'
          ? 'SSO sign-in joined no organization: the configured organization no longer exists'
          : 'SSO sign-in joined no organization: name one in Setup, or keep exactly one'
      )
    }
    return null
  }

  private async resolve(): Promise<string | { orgId: null; miss: TargetMiss }> {
    const configured = this.deps.connector.memberOrganization ?? null
    if (configured !== null) {
      return (await this.deps.orgs.slugById(configured)) !== null ? configured : { orgId: null, miss: 'missing' }
    }
    const ids = await this.deps.orgs.listIds(2)
    if (ids.length === 1) return ids[0]!
    return { orgId: null, miss: ids.length === 0 ? 'none' : 'several' }
  }
}

/** The single resolution point: the deployment's connector when it declares one, else its organizations' connections, else none. */
export function resolveMemberSource(input: {
  deploymentConnector: DeploymentConnectorMembers | null | undefined
  organizationDomains: { joinableOrg(domain: string): Promise<string | null> } | undefined
  orgs: Pick<OrgRepo, 'listIds' | 'slugById'>
  log: { warn(obj: object, msg: string): void }
}): MemberSource | undefined {
  if (input.deploymentConnector) {
    return new DeploymentMemberSource({ connector: input.deploymentConnector, orgs: input.orgs, log: input.log })
  }
  if (input.organizationDomains) return new OrganizationMemberSource(input.organizationDomains)
  return undefined
}
