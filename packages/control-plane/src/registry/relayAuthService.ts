/**
 * `RelayAuthService` — the relay plane's credential verifier (shared-bot-relay.md §8/§9).
 *
 * Two jobs, both answering "is this credential valid?" for the DB-less relay:
 *
 *  1. `authenticate` — the relay's OWN `rc/auth` first frame, dual-mode:
 *     - `token`  : a deployment-shared secret (`RELAY_TOKEN`), constant-time compared.
 *                  Unset ⇒ this mode is OFF (self-hosted picks one; managed uses apikey).
 *     - `apikey` : a per-relay `principalType='relay'` ApiKey, looked up by its peppered
 *                  hash and checked for revoke/expiry — the daemon-key mechanism minus
 *                  the org (relay keys are org-less infra).
 *  2. `verifyDaemonKey` — the DELEGATED `rc/verify(daemon-key)` check: a daemon dialing
 *     the relay presents its existing daemon key on `rd/hello`; the relay has no DB, so it
 *     asks the CP. Read-only — NO epoch bump, NO lastUsed touch (unlike
 *     `DaemonAuthService.authenticate`), because it is a validity question, not the start
 *     of a fenced control session.
 *
 * A rejected caller never learns WHY beyond a generic reason (no existence oracle).
 * The credential is secret material — this service NEVER logs it.
 */
import { timingSafeEqual } from 'node:crypto'
import type { RcAuth } from '@agentconnect.md/protocol'
import type { ApiKeyRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import type { ClusterDaemonIdentity } from '../ports.js'
import { ApiKeyCodec } from './apiKey.js'

/** Config slice: the shared token (unset ⇒ token mode off) + the heartbeat cadence to advertise. */
export interface RelayAuthConfig {
  RELAY_TOKEN?: string
  HEARTBEAT_SEC: number
}

/** Verdict of `RelayAuthService.authenticate`. `identity` is for audit/logging only —
 *  a relay's durable identity is its `rc/register.name`, not the auth credential. */
export type RelayAuthResult = { ok: true; identity: string } | { ok: false; reason: string }

export class RelayAuthService {
  constructor(
    private readonly codec: ApiKeyCodec,
    private readonly apiKeys: ApiKeyRepo,
    private readonly clock: Clock,
    private readonly config: RelayAuthConfig,
    /** Absent when this deployment provisions no clusters — then only the key path exists. */
    private readonly clusterIdentity?: ClusterDaemonIdentity
  ) {}

  /** The heartbeat cadence advertised in `rc/auth/ok`. */
  get heartbeatSec(): number {
    return this.config.HEARTBEAT_SEC
  }

  async authenticate(auth: RcAuth): Promise<RelayAuthResult> {
    return auth.method === 'token' ? this.authToken(auth.credential) : this.authApiKey(auth.credential)
  }

  /**
   * Resolve a DAEMON key to its {daemonId, orgId} for `rc/verify(daemon-key)` — the
   * relay-delegated check on a daemon's `rd/hello` (§9). Read-only + side-effect-free:
   * no epoch bump, no lastUsed touch. Returns null on any fail-closed reason (unknown /
   * not-a-daemon-key / unbound / org-less / revoked / expired). A store error PROPAGATES
   * so the caller can answer a retryable error rather than a false "invalid credential".
   */
  async verifyDaemonKey(credential: string): Promise<{ daemonId: string; orgId: string } | null> {
    const parsed = this.codec.parse(credential)
    if (!parsed) return null
    const row = await this.apiKeys.findByHash(this.codec.hash(parsed.secret))
    if (!row) return null
    if (row.principalType !== 'daemon') return null // relay/user key ≠ daemon
    if (!row.daemonId) return null // key not bound to a daemon
    if (!row.orgId) return null // daemon keys are always org-scoped
    if (row.revokedAt) return null
    if (row.expiresAt && row.expiresAt.getTime() <= this.clock.now()) return null
    return { daemonId: row.daemonId, orgId: row.orgId }
  }

  /**
   * Resolve an in-cluster daemon's projected ServiceAccount token to the same
   * `{daemonId, orgId}` for `rc/verify(daemon-token)`. One TokenReview, exactly the check
   * the daemon's own CP socket runs — the relay hop must not be a weaker door than the
   * control socket. Null when this deployment provisions no clusters, or the token fails
   * any of the audience / ServiceAccount / namespace checks; a cluster or store error
   * PROPAGATES so the caller answers retryable rather than "invalid credential".
   *
   * `claimedDaemonId` is the id the daemon put on `rd/hello`, forwarded unverified. A cloud
   * daemon holds one record per org, so it is the only thing that says which record this
   * token is being presented for — and the verifier refuses a claim on a record the identity
   * does not own, which is why forwarding an unverified id is safe. This never CREATES a
   * record: an org's first record is minted on the CP socket, which is the one door that
   * knows the org outright.
   */
  async verifyDaemonToken(
    credential: string,
    claimedDaemonId?: string
  ): Promise<{ daemonId: string; orgId: string } | null> {
    if (!this.clusterIdentity) return null
    const verified = await this.clusterIdentity.verify(
      credential,
      claimedDaemonId ? { daemonId: claimedDaemonId } : undefined
    )
    return verified ? { daemonId: verified.daemonId, orgId: verified.orgId } : null
  }

  private authToken(credential: string): RelayAuthResult {
    const expected = this.config.RELAY_TOKEN
    if (!expected) return { ok: false, reason: 'token auth not configured' } // mode off ⇒ closed
    const a = Buffer.from(credential)
    const b = Buffer.from(expected)
    // Length check first (timingSafeEqual requires equal length); the token length is
    // not the secret. A mismatch on either length or bytes is a generic rejection.
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'invalid relay token' }
    return { ok: true, identity: 'shared-token' }
  }

  private async authApiKey(credential: string): Promise<RelayAuthResult> {
    const parsed = this.codec.parse(credential)
    if (!parsed) return { ok: false, reason: 'invalid api key' }
    const row = await this.apiKeys.findByHash(this.codec.hash(parsed.secret))
    // Fail closed: unknown / not-a-relay-key / revoked / expired → generic rejection.
    if (!row) return { ok: false, reason: 'invalid api key' }
    if (row.principalType !== 'relay') return { ok: false, reason: 'invalid api key' } // daemon/user key ≠ relay
    if (row.revokedAt) return { ok: false, reason: 'invalid api key' }
    const nowMs = this.clock.now()
    if (row.expiresAt && row.expiresAt.getTime() <= nowMs) return { ok: false, reason: 'invalid api key' }
    void this.apiKeys.touchLastUsed(row.id, new Date(nowMs)).catch(() => {})
    return { ok: true, identity: row.id }
  }
}
