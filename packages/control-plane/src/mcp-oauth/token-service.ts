/**
 * `McpProviderTokenService` — the CP's custody of one provider's upstream OAuth grant
 * (docs/designs/mcp-provider-oauth.md).
 *
 * The `LinearTokenService` shape, because the hazard is identical: an access token expires,
 * refreshing it MAY rotate the refresh token, and a rotated refresh token spent twice leaves
 * the organization holding a credential the authorization server has already invalidated.
 *
 * THREE properties, all load-bearing:
 *
 *  - SINGLE-FLIGHT per provider. N concurrent callers wanting a fresh token must produce ONE
 *    upstream refresh; every joiner takes the winner's answer.
 *  - DURABLE SINGLE-WRITER. The in-process flight is not enough on its own: a refresh token
 *    outlives the process, so one writer is elected through a database lease and the commit
 *    lands under a `tokenVersion` CAS. A crash mid-rotation must not strand the org.
 *  - PERSIST BEFORE REPLY. The rotated pair is durable before any caller sees it. Replying
 *    first is how a crash leaves a token only the caller has and a refresh token the server
 *    has already spent.
 *
 * A LOST CAS and a DEFINITIVE refusal are different events and take different arms. A lost
 * CAS means someone moved this grant on — reload and use what they wrote. A refusal means the
 * grant is dead and only re-authorization repairs it. An UNREACHABLE authorization server is
 * neither: a blip is not proof a grant is dead, so the status is left exactly as it was.
 *
 * REFRESH MARGIN scales with the token's own lifetime. A fixed skew is fine for a two-hour
 * token and useless for a five-minute one, and short-lived tokens are common among MCP
 * servers — so the margin is half the observed lifetime, floored at a minute.
 *
 * SECURITY: nothing this file reads or writes may be logged.
 */
import { randomUUID } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { systemClock } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type { McpProviderOauthRecord, McpProviderOauthRepo, McpProviderOauthSecretStore } from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import type { Dial } from './discovery.js'
import { refreshGrant, type TokenClient, type TokenGrant } from './token-endpoint.js'

/** Never renew later than this before expiry, however short the token's life. */
export const MIN_REFRESH_MARGIN_MS = 60_000
/** The lease a refreshing process holds. Long enough for one upstream round-trip. */
export const REFRESH_LEASE_MS = 30_000

/** Renew when under half the token's observed lifetime remains, never under a minute. */
export function refreshMarginMs(issuedAt: number, expiresAt: Date | null): number {
  if (expiresAt === null) return MIN_REFRESH_MARGIN_MS
  const lifetime = expiresAt.getTime() - issuedAt
  return Math.max(MIN_REFRESH_MARGIN_MS, Math.floor(lifetime / 2))
}

/**
 * Whether a grant has entered its renewal margin. The ONE definition of "due": the resolve
 * path and the refresher sweep both ask this, so a token can never be due for one and not
 * the other. A grant with no advertised expiry is never due — there is nothing to pre-empt.
 */
export function refreshDue(grant: { accessExpiresAt: Date | null; updatedAt: Date }, now: number): boolean {
  if (grant.accessExpiresAt === null) return false
  return grant.accessExpiresAt.getTime() - now <= refreshMarginMs(grant.updatedAt.getTime(), grant.accessExpiresAt)
}

export type TokenResolution =
  | { ok: true; accessToken: string; expiresAt: Date | null; rotated: boolean }
  | {
      ok: false
      /** `not_connected` — no grant (never authorized, or disconnected).
       *  `reauth_required` — the grant is dead upstream; only the funnel repairs it.
       *  `unreachable` — the authorization server was unavailable; retry, do not re-authorize. */
      reason: 'not_connected' | 'reauth_required' | 'unreachable'
    }

export interface McpProviderTokenServiceDeps {
  oauth: McpProviderOauthRepo
  secrets: McpProviderOauthSecretStore
  cipher: SecretCipher
  dial: Dial
  clock?: Clock
  /** Identifies this process in the refresh lease. Defaults to a per-instance id. */
  owner?: string
}

export class McpProviderTokenService {
  private readonly clock: Clock
  private readonly owner: string
  /** One in-flight refresh per provider — the single-flight itself. */
  private readonly inFlight = new Map<string, Promise<TokenResolution>>()

  constructor(private readonly deps: McpProviderTokenServiceDeps) {
    this.clock = deps.clock ?? systemClock
    this.owner = deps.owner ?? `cp-${randomUUID()}`
  }

  /**
   * The current access token for a provider, refreshed first when it is close enough to
   * expiry to matter. `allowNetwork: false` serves whatever is stored without ever dialing —
   * the mode relay replay uses, so a cold start cannot turn into N serial round-trips to
   * third-party authorization servers inside relay registration.
   */
  async resolve(orgId: OrgId, providerId: string, opts: { allowNetwork?: boolean } = {}): Promise<TokenResolution> {
    const row = await this.deps.oauth.get(orgId, providerId)
    if (row === null || row.status === 'pending') return { ok: false, reason: 'not_connected' }
    const sealed = await this.deps.secrets.get(orgId, providerId)
    if (!sealed?.accessToken) {
      return { ok: false, reason: row.status === 'reauth_required' ? 'reauth_required' : 'not_connected' }
    }
    const scope = orgScope(orgId)
    const accessToken = await this.deps.cipher.open(sealed.accessToken, scope)

    const allowNetwork = opts.allowNetwork ?? true
    if (!allowNetwork || row.status === 'reauth_required') {
      // A dead grant still hands back its last token: it may work, and after the relay's
      // 401 containment a failure is an opaque 502 rather than something the agent chases.
      return { ok: true, accessToken, expiresAt: row.accessExpiresAt, rotated: false }
    }
    if (!this.due(row)) return { ok: true, accessToken, expiresAt: row.accessExpiresAt, rotated: false }

    const existing = this.inFlight.get(providerId)
    if (existing) return existing
    const flight = this.refreshOnce(orgId, providerId, row).finally(() => this.inFlight.delete(providerId))
    this.inFlight.set(providerId, flight)
    return flight
  }

  /** Force a renewal regardless of expiry — what the refresher sweep and a reconnect use. */
  async refresh(orgId: OrgId, providerId: string): Promise<TokenResolution> {
    const existing = this.inFlight.get(providerId)
    if (existing) return existing
    const row = await this.deps.oauth.get(orgId, providerId)
    if (row === null || row.status !== 'connected') {
      return { ok: false, reason: row?.status === 'reauth_required' ? 'reauth_required' : 'not_connected' }
    }
    const flight = this.refreshOnce(orgId, providerId, row).finally(() => this.inFlight.delete(providerId))
    this.inFlight.set(providerId, flight)
    return flight
  }

  private due(row: McpProviderOauthRecord): boolean {
    return refreshDue(row, this.clock.now())
  }

  private async refreshOnce(orgId: OrgId, providerId: string, row: McpProviderOauthRecord): Promise<TokenResolution> {
    const scope = orgScope(orgId)
    const now = this.clock.now()
    const claimed = await this.deps.oauth.claimRefreshLease(
      providerId,
      this.owner,
      new Date(now + REFRESH_LEASE_MS),
      new Date(now)
    )
    // Someone else is refreshing right now. Serve what is stored rather than racing them
    // into a second rotate: this token is still valid, that is why there is a margin.
    if (!claimed) return this.serveStored(orgId, providerId)

    try {
      const sealed = await this.deps.secrets.get(orgId, providerId)
      if (!sealed?.refreshToken) {
        await this.deps.oauth.markReauthRequired(providerId, row.tokenVersion)
        return { ok: false, reason: 'reauth_required' }
      }
      const client: TokenClient = {
        tokenEndpoint: row.tokenEndpoint,
        clientId: row.clientId,
        ...(sealed.clientSecret ? { clientSecret: await this.deps.cipher.open(sealed.clientSecret, scope) } : {}),
        resource: row.resource
      }
      const result = await refreshGrant(
        this.deps.dial,
        client,
        await this.deps.cipher.open(sealed.refreshToken, scope),
        this.clock.now()
      )
      if (!result.ok) {
        // An unreachable server proves nothing about the grant — leave the status alone.
        if (result.failure === 'unreachable') return { ok: false, reason: 'unreachable' }
        await this.deps.oauth.markReauthRequired(providerId, row.tokenVersion)
        return { ok: false, reason: 'reauth_required' }
      }
      return await this.commit(orgId, providerId, row, result.grant, scope)
    } finally {
      await this.deps.oauth.releaseRefreshLease(providerId, this.owner)
    }
  }

  /**
   * Persist the rotated pair before replying. A server that declines to rotate the refresh
   * token keeps the one we hold; a server that rotates replaces it, and losing that write
   * would strand the org on a spent credential.
   */
  private async commit(
    orgId: OrgId,
    providerId: string,
    row: McpProviderOauthRecord,
    grant: TokenGrant,
    scope: ReturnType<typeof orgScope>
  ): Promise<TokenResolution> {
    const sealed = await this.deps.secrets.get(orgId, providerId)
    // The store OPENS everything it returns, so the retained token is plaintext here. It has
    // to be re-sealed like a fresh one — writing it back as-is would silently strip its
    // at-rest encryption the first time a server declines to rotate.
    const keptRefresh = grant.refreshToken ?? sealed?.refreshToken ?? null
    const sealedRefresh = keptRefresh === null ? null : await this.deps.cipher.seal(keptRefresh, scope)
    if (sealedRefresh === null) {
      // Nothing left to renew with next time: better to say so now than to hand back a
      // token that will expire into a provider nobody can repair without noticing.
      await this.deps.oauth.markReauthRequired(providerId, row.tokenVersion)
      return { ok: false, reason: 'reauth_required' }
    }
    const committed = await this.deps.oauth.commitRefresh(providerId, row.tokenVersion, grant.expiresAt, {
      accessToken: await this.deps.cipher.seal(grant.accessToken, scope),
      refreshToken: sealedRefresh
    })
    // Lost the CAS: a peer, a reconnect or a disconnect moved this grant on while the
    // upstream call was in flight. Their write is the truth — never re-apply ours.
    if (!committed) return this.serveStored(orgId, providerId)
    return { ok: true, accessToken: grant.accessToken, expiresAt: grant.expiresAt, rotated: true }
  }

  /** Re-read and serve whatever is durably stored, without dialing. */
  private async serveStored(orgId: OrgId, providerId: string): Promise<TokenResolution> {
    const fresh = await this.deps.oauth.get(orgId, providerId)
    const sealed = await this.deps.secrets.get(orgId, providerId)
    if (fresh === null || !sealed?.accessToken) {
      return { ok: false, reason: fresh?.status === 'reauth_required' ? 'reauth_required' : 'not_connected' }
    }
    return {
      ok: true,
      accessToken: await this.deps.cipher.open(sealed.accessToken, orgScope(orgId)),
      expiresAt: fresh.accessExpiresAt,
      rotated: false
    }
  }
}
