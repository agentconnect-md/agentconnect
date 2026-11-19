/** The login page's lookup (organization-sso.md §4.2): which connector an address's domain signs in through. */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'

export const ORG_SSO_LOOKUP_TTL_MS = 15_000

export interface OrgSsoSignInConnector {
  connectorId: string
}

/** An organization's active connection and the verified domains it holds. */
export interface OrgSsoActiveConnection extends OrgSsoSignInConnector {
  domains: ReadonlySet<string>
  /** Members inside the domains must reach the organization from a session signed in through it (§4.5). */
  enforced: boolean
}

interface Snapshot {
  at: number
  byDomain: Map<string, OrgSsoSignInConnector>
  byOrg: Map<string, OrgSsoActiveConnection>
}

/** Anonymous callers are answered from a snapshot of the active domains, so a request costs no query. */
export class OrgSsoSignInLookup {
  private snapshot: Snapshot | null = null
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly deps: {
      connections: OrgSsoConnectionRepo
      clock: Clock
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  /** Decides by the domain alone, never by whether the address has an account. */
  async find(email: string): Promise<OrgSsoSignInConnector | null> {
    const at = email.lastIndexOf('@')
    if (at <= 0) return null
    const domain = email
      .slice(at + 1)
      .trim()
      .toLowerCase()
    if (!domain) return null
    return (await this.current()).byDomain.get(domain) ?? null
  }

  /** The organization's active connection, from the same snapshot; null when it has none. */
  async activeFor(orgId: string): Promise<OrgSsoActiveConnection | null> {
    return (await this.current()).byOrg.get(orgId) ?? null
  }

  private async current(): Promise<Snapshot> {
    const now = this.deps.clock.now()
    if (!this.snapshot || now - this.snapshot.at >= ORG_SSO_LOOKUP_TTL_MS) {
      this.refreshing ??= this.refresh(now).finally(() => (this.refreshing = null))
      // A stale snapshot keeps answering through a failed refresh; only a first load has nothing to fall back on.
      await this.refreshing.catch((err: unknown) => {
        if (!this.snapshot) throw err
        this.deps.log?.warn({ err }, 'org sso: sign-in lookup kept a stale snapshot')
      })
    }
    return this.snapshot!
  }

  private async refresh(now: number): Promise<void> {
    const byDomain = new Map<string, OrgSsoSignInConnector>()
    const byOrg = new Map<string, OrgSsoActiveConnection & { domains: Set<string> }>()
    for (const row of await this.deps.connections.listActiveDomains()) {
      byDomain.set(row.domain, { connectorId: row.connectorId })
      const org = byOrg.get(row.orgId) ?? {
        connectorId: row.connectorId,
        enforced: row.enforced,
        domains: new Set<string>()
      }
      org.domains.add(row.domain)
      byOrg.set(row.orgId, org)
    }
    this.snapshot = { at: now, byDomain, byOrg }
  }
}
