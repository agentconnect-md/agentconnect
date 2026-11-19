/** Per-session enforcement (organization-sso.md §4.5): once an owner enforces it, an address in the organization's verified domains reaches it only from a session signed in through its connection. */
import type { Clock } from '../domain/clock.js'
import type { OrgSsoIdp } from './idp.js'
import type { OrgSsoSignInConnector, OrgSsoSignInLookup } from './lookup.js'

/** How long an account's address and a connector's presence are reused; the sign-in method itself is never cached. */
export const ORG_SSO_SESSION_CACHE_TTL_MS = 60_000
const CACHE_LIMIT = 10_000

/** The interactive session a request came from: its OIDC subject and the SSO connector its latest sign-in went through. */
export interface OrgSsoSession {
  subject: string
  ssoConnectorId: string | null
}

const domainOf = (email: string): string => email.slice(email.lastIndexOf('@') + 1).toLowerCase()

export class OrgSsoSessionRule {
  private readonly addresses = new Map<string, { at: number; email: string | null }>()
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
    const email = await this.address(session.subject)
    if (email === null || !active.domains.has(domainOf(email))) return null
    // A connector gone from the identity service needs configuring again; nobody can sign in through it, so it does not lock anyone out.
    if (!(await this.present(active.connectorId))) return null
    return { connectorId: active.connectorId }
  }

  private async address(subject: string): Promise<string | null> {
    const now = this.deps.clock.now()
    const cached = this.addresses.get(subject)
    if (cached && now - cached.at < ORG_SSO_SESSION_CACHE_TTL_MS) return cached.email
    try {
      const email = (await this.deps.idp.account(subject))?.primaryEmail ?? null
      remember(this.addresses, subject, { at: now, email }, now)
      return email
    } catch (err) {
      // A stale address keeps answering through an identity-service blip; with none, the caller answers 503.
      if (!cached) throw err
      this.deps.log?.warn({ err }, 'org sso: kept a stale account address')
      return cached.email
    }
  }

  private async present(connectorId: string): Promise<boolean> {
    const now = this.deps.clock.now()
    const cached = this.connectors.get(connectorId)
    if (cached && now - cached.at < ORG_SSO_SESSION_CACHE_TTL_MS) return cached.present
    try {
      const present = (await this.deps.idp.connector(connectorId)) !== 'missing'
      remember(this.connectors, connectorId, { at: now, present }, now)
      return present
    } catch (err) {
      // Unknown means the rule applies: the connection is active.
      this.deps.log?.warn({ err }, 'org sso: could not confirm the connector, enforcing')
      return cached?.present ?? true
    }
  }
}

function remember<V extends { at: number }>(cache: Map<string, V>, key: string, value: V, now: number): void {
  if (cache.size >= CACHE_LIMIT) {
    for (const [k, v] of cache) if (now - v.at >= ORG_SSO_SESSION_CACHE_TTL_MS) cache.delete(k)
    if (cache.size >= CACHE_LIMIT) cache.clear()
  }
  cache.set(key, value)
}
