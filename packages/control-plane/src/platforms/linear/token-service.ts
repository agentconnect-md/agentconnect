/**
 * `LinearTokenService` — the CP's custody of a connected workspace's OAuth grant
 * (docs/designs/linear-integration.md §4.4, §9.2).
 *
 * Linear access tokens expire in ~24 h and refresh ROTATES the refresh token, so a rotating
 * credential needs exactly one durable writer. That is this service, over Postgres, and it is why
 * the daemon never holds the client secret or the refresh token — it gets a ≤24 h access token in
 * its spec and re-requests over `linearcred` (§7.3, its own change).
 *
 * TWO PROPERTIES the design names, both load-bearing:
 *
 *  - SINGLE-FLIGHT per connection identity. Linear invalidates the old refresh token on rotate
 *    (behind a ~30 min replay grace), so N concurrent renewals firing N rotates would race to
 *    persist and could leave the row holding a superseded pair. One in-flight promise per identity
 *    collapses them into one upstream call, and each joiner gets the winner's answer.
 *  - PERSIST BEFORE REPLY. The rotated pair is written durably before any caller sees it. Replying
 *    first and persisting after is how a crash mid-rotation strands a workspace with a token only
 *    the daemon has and a refresh token Linear has already spent.
 *
 * ROTATE-AND-RETRY is the Slack config-token precedent (`http/slack-user-config.ts`): a rotate that
 * Linear DEFINITIVELY rejects may simply mean a peer CP instance rotated first, so the row is
 * reloaded once and a fresh pair found there is used. Only after that does the workspace count as
 * needing a reconnect. An unreachable Linear never spends the retry and never flips the state —
 * a blip is not proof the grant is dead.
 */
import type { LinearConnectionIdentity, LinearTokenRecord, LinearTokenStore } from '../../persistence/ports.js'
import type { LinearPlatformAppConfig } from '../../config/linear-platform.js'
import { systemClock, type Clock } from '../../domain/clock.js'
import type { LinearApiClient, LinearGrant, LinearViewer } from './api.js'

/** Refresh when under 2 h of access-token life remains — the daemon's own re-request margin (§4.4),
 *  so the CP has already renewed by the time a daemon asks. */
export const LINEAR_REFRESH_MARGIN_MS = 2 * 60 * 60 * 1000

export type LinearTokenResolution =
  | {
      ok: true
      accessToken: string
      expiresAt: Date
      /** True when this call reached the refresh path and it produced a pair NEWER than the one the
       *  stored row held on entry — either this rotate's or a peer's. The `linearcred` broker reads
       *  it as "every spec projecting this grant is now stale" and re-pushes (§7.3). */
      rotated: boolean
    }
  | {
      ok: false
      /** `not_connected` — no grant for this identity (never connected, or swept).
       *  `reconnect_required` — the grant is dead upstream; only the funnel can repair it.
       *  `unreachable` — Linear was unavailable; the caller should retry, not re-authorize. */
      reason: 'not_connected' | 'reconnect_required' | 'unreachable'
    }

export interface LinearTokenServiceDeps {
  /** Read PER CALL, never captured: the deployment app is optional and may be composed late. */
  readonly app?: LinearPlatformAppConfig
  tokens: LinearTokenStore
  api: LinearApiClient
  clock?: Clock
  log?: { warn(obj: unknown, msg?: string): void }
}

function keyOf(identity: LinearConnectionIdentity): string {
  return `${identity.orgId}\u0000${identity.clientId}\u0000${identity.organizationId}`
}

export class LinearTokenService {
  private readonly clock: Clock
  /** One in-flight refresh per connection identity — the single-flight itself. */
  private readonly inFlight = new Map<string, Promise<LinearTokenResolution>>()

  constructor(private readonly deps: LinearTokenServiceDeps) {
    this.clock = deps.clock ?? systemClock
  }

  /** §7.1's code exchange. Returns the grant WITHOUT persisting it: the callback owns the write,
   *  because the connection identity it is keyed by only exists once `viewer` has answered. */
  async exchangeCode(input: { code: string; redirectUri: string }) {
    const app = this.deps.app
    if (!app) return { ok: false as const, error: 'rejected' as const, detail: 'linear platform app not configured' }
    return this.deps.api.exchangeCode({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      code: input.code,
      redirectUri: input.redirectUri
    })
  }

  /** `viewer { id organization { id name } }` against a freshly exchanged grant. */
  viewer(accessToken: string): Promise<{ ok: true; result: LinearViewer } | { ok: false; error: string }> {
    return this.deps.api.viewer(accessToken).then((r) => (r.ok ? r : { ok: false as const, error: r.error }))
  }

  /** Persist a grant under its connection identity — §7.1's step 1 and the §7.4 reconnect arm are
   *  this same idempotent upsert. */
  put(identity: LinearConnectionIdentity, grant: LinearGrant): Promise<void> {
    return this.deps.tokens.put(identity, {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt
    })
  }

  /** A usable access token for one connected workspace, refreshing behind the single-flight when
   *  the stored one is near expiry. The `linearcred` broker's whole job (§7.3). */
  async accessToken(identity: LinearConnectionIdentity): Promise<LinearTokenResolution> {
    const row = await this.deps.tokens.get(identity)
    if (!row) return { ok: false, reason: 'not_connected' }
    if (this.fresh(row)) return { ok: true, accessToken: row.accessToken, expiresAt: row.expiresAt, rotated: false }
    return this.refresh(identity)
  }

  /**
   * Best-effort upstream revocation of one workspace's grant (§7.4). The CALLER decides whether
   * revoking is safe — the identity may still back another organization's live install — so this
   * only does the call, and answers false rather than throwing when it cannot.
   */
  async revoke(identity: LinearConnectionIdentity): Promise<boolean> {
    const row = await this.deps.tokens.get(identity)
    if (!row) return false
    return this.revokeAccessToken(row.accessToken, identity)
  }

  /**
   * Revoke one EXPLICIT access token. The sweep uses this rather than {@link revoke} because it has
   * already claimed the row and holds the token that claim removed — re-reading the store there
   * could hand back a grant that arrived after the snapshot, and revoking that would kill a live
   * install (§7.1's whole reason for the claim).
   */
  async revokeAccessToken(accessToken: string, identity?: LinearConnectionIdentity): Promise<boolean> {
    const res = await this.deps.api.revoke(accessToken)
    if (!res.ok) {
      this.deps.log?.warn(
        { orgId: identity?.orgId, organizationId: identity?.organizationId, error: res.error },
        'linear: upstream token revoke failed'
      )
    }
    return res.ok
  }

  private fresh(row: Pick<LinearTokenRecord, 'expiresAt'>): boolean {
    return row.expiresAt.getTime() - this.clock.now() > LINEAR_REFRESH_MARGIN_MS
  }

  private refresh(identity: LinearConnectionIdentity): Promise<LinearTokenResolution> {
    const key = keyOf(identity)
    const joined = this.inFlight.get(key)
    if (joined) return joined
    const flight = this.refreshOnce(identity).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, flight)
    return flight
  }

  private async refreshOnce(identity: LinearConnectionIdentity): Promise<LinearTokenResolution> {
    const app = this.deps.app
    if (!app) return { ok: false, reason: 'reconnect_required' }
    // Re-read inside the flight: a refresh that finished while this one was queued already wrote a
    // fresh pair, and rotating again would spend a token nobody needed spent.
    const row = await this.deps.tokens.get(identity)
    if (!row) return { ok: false, reason: 'not_connected' }
    // Fresh HERE but stale to the caller's read ⇒ a peer rotated between them; the answer is new to it.
    if (this.fresh(row)) return { ok: true, accessToken: row.accessToken, expiresAt: row.expiresAt, rotated: true }
    if (!row.refreshToken) return { ok: false, reason: 'reconnect_required' }

    const rotated = await this.deps.api.refresh({
      clientId: app.clientId,
      clientSecret: app.clientSecret,
      refreshToken: row.refreshToken
    })
    if (rotated.ok) {
      // Durable BEFORE the reply — see the single-writer note at the top of this file.
      await this.put(identity, rotated.result)
      return { ok: true, accessToken: rotated.result.accessToken, expiresAt: rotated.result.expiresAt, rotated: true }
    }
    if (rotated.error === 'unreachable') return { ok: false, reason: 'unreachable' }

    // Rejected. The refresh token may simply have been spent by another CP instance that already
    // persisted the rotated pair — reload once and use what it wrote.
    const reloaded = await this.deps.tokens.get(identity)
    if (reloaded && this.fresh(reloaded)) {
      return { ok: true, accessToken: reloaded.accessToken, expiresAt: reloaded.expiresAt, rotated: true }
    }
    this.deps.log?.warn(
      { orgId: identity.orgId, organizationId: identity.organizationId },
      'linear: token refresh rejected — workspace needs reconnecting'
    )
    return { ok: false, reason: 'reconnect_required' }
  }
}
