/** The login page's lookup (organization-sso.md §4.2): which connector an address's domain signs in through. */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoConnectionRepo } from '../persistence/ports.js'

export const ORG_SSO_LOOKUP_TTL_MS = 15_000

export interface OrgSsoSignInConnector {
  connectorId: string
  name: string
}

/** Anonymous callers are answered from a snapshot of the active domains, so a request costs no query. */
export class OrgSsoSignInLookup {
  private snapshot: { at: number; byDomain: Map<string, OrgSsoSignInConnector> } | null = null
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
    const now = this.deps.clock.now()
    if (!this.snapshot || now - this.snapshot.at >= ORG_SSO_LOOKUP_TTL_MS) {
      this.refreshing ??= this.refresh(now).finally(() => (this.refreshing = null))
      // A stale snapshot keeps answering through a failed refresh; only a first load has nothing to fall back on.
      await this.refreshing.catch((err: unknown) => {
        if (!this.snapshot) throw err
        this.deps.log?.warn({ err }, 'org sso: sign-in lookup kept a stale snapshot')
      })
    }
    return this.snapshot?.byDomain.get(domain) ?? null
  }

  private async refresh(now: number): Promise<void> {
    const byDomain = new Map<string, OrgSsoSignInConnector>()
    for (const row of await this.deps.connections.listActiveDomains()) {
      byDomain.set(row.domain, { connectorId: row.connectorId, name: row.name })
    }
    this.snapshot = { at: now, byDomain }
  }
}
