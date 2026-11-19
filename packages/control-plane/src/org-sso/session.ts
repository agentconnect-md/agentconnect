/** Per-session enforcement (organization-sso.md §4.5): once an owner enforces it, every member reaches the organization only from a session signed in through its connection. */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoIdp } from './idp.js'
import type { OrgSsoSignInConnector, OrgSsoSignInLookup } from './lookup.js'

/** How long a connector's presence is reused; the sign-in method itself is never cached. */
export const ORG_SSO_SESSION_CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 10_000

/** The interactive session a request came from: its OIDC subject and the SSO connector its latest sign-in went through. */
export interface OrgSsoSession {
  subject: string
  ssoConnectorId: string | null
}

export class OrgSsoSessionRule {
  private readonly connectors = new Map<string, { at: number; present: boolean }>()

  constructor(
    private readonly deps: {
      lookup: OrgSsoSignInLookup
      idp: OrgSsoIdp
      clock: Clock
      log?: { warn(obj: object, msg: string): void }
    }
  ) {}

  /** The connection this session must sign in through before it reaches the organization, or null when it may. */
  async requirement(orgId: string, session: OrgSsoSession): Promise<OrgSsoSignInConnector | null> {
    const active = await this.deps.lookup.activeFor(orgId)
    if (!active?.enforced || session.ssoConnectorId === active.connectorId) return null
    // A connector gone from the identity service needs configuring again; nobody can sign in through it, so it does not lock anyone out.
    if (!(await this.present(active.connectorId))) return null
    return { connectorId: active.connectorId }
  }

  private async present(connectorId: string): Promise<boolean> {
    const now = this.deps.clock.now()
    const cached = this.connectors.get(connectorId)
    if (cached && now - cached.at < ORG_SSO_SESSION_CACHE_TTL_MS) return cached.present
    try {
      const present = (await this.deps.idp.connector(connectorId)) !== 'missing'
      if (this.connectors.size >= CACHE_LIMIT) this.connectors.clear()
      this.connectors.set(connectorId, { at: now, present })
      return present
    } catch (err) {
      // Unknown means the rule applies: the connection is enforced.
      this.deps.log?.warn({ err }, 'org sso: could not confirm the connector, enforcing')
      return cached?.present ?? true
    }
  }
}
