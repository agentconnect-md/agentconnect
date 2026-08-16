/**
 * `DaemonAuthService` — implements the C4 `DaemonAuth` port (design §2.3, §4.6;
 * protocol §3.1; daemon-api-key-auth.md §5).
 *
 * `authenticate` is the server side of the first frame on the socket. Two credentials
 * reach it and each is simple on its own — an in-cluster daemon presents the projected
 * ServiceAccount token its pod was born with, and a daemon on someone's laptop, which has
 * no Kubernetes identity, presents the API key it always did.
 *
 * The key path:
 *   1. parse the presented `apiKey` offline (prefix/role/charset/CRC) — malformed
 *      → close `4401` (`AUTH_FAILED`), no DB call, no side effects;
 *   2. look the key up by its peppered hash; missing / revoked / expired / not a
 *      `daemon`-principal key → `4401`, NO epoch bump;
 *   3. on success → mint the next monotonic `sessionEpoch` via `EpochService`
 *      (persisted in C6) and return the `auth/ok` frame.
 *
 * TokenReview resolves an envelope to one org or a pool member Pod to one install-wide member.
 *
 * A DB error during lookup or the epoch bump closes `1011` (SERVER_INTERNAL) so the
 * daemon backs off and retries rather than treating a transient blip as a dead
 * credential. The service is transport-free: it returns an `AuthResult` the WS
 * handler turns into `replyTo(..., "auth/ok", ...)` or `transport.close(...)`.
 */
import type { AuthReq, AuthOk } from '@agentconnect.md/protocol'
import type { AuthResult, ClientCtx, ClusterDaemonIdentity, DaemonAuth, VerifiedClusterDaemon } from '../ports.js'
import type { ApiKeyRepo, MemberSetRepo, OrgRepo } from '../persistence/ports.js'
import type { EpochService } from '../orchestrator/epoch.js'
import type { Clock } from '../domain/clock.js'
import { DaemonId, OrgId } from '../domain/ids.js'
import { ApiKeyCodec } from './apiKey.js'

/** Config slice the auth service needs. */
export interface AuthServiceConfig {
  HEARTBEAT_SEC: number
  /** Duty lease horizon handed to the daemon so its self-fence tracks THIS CP's
   *  `DUTY_LEASE_DEFAULTS.leaseMs` instead of a duplicated constant. */
  DUTY_LEASE_MS: number
  /** Web App console origin sent to daemons on `auth/ok` for session deep links.
   *  Undefined ⇒ no `webAppUrl` in the reply (daemon falls back to its own config). */
  WEB_APP_URL?: string
}

export class DaemonAuthService implements DaemonAuth {
  constructor(
    private readonly codec: ApiKeyCodec,
    private readonly apiKeys: ApiKeyRepo,
    private readonly epoch: EpochService,
    private readonly clock: Clock,
    private readonly config: AuthServiceConfig,
    // Resolves the daemon's org slug for the org-scoped session deep link. Only `slugById`
    // is used; a failed lookup degrades to no `orgSlug` (never fails the handshake).
    private readonly orgs: Pick<OrgRepo, 'slugById'>,
    /** The set this connection may claim within (daemon-groups.md §3), announced on `auth/ok`.
     *  NOT optional: a missing reader would hand every member `auth/ok` with no set, and the whole
     *  duty ledger would go quiet — a wiring hole must not be able to look like an empty pool. */
    private readonly memberSets: Pick<MemberSetRepo, 'setOf'>,
    /** Absent when this deployment provisions no clusters — then only the key path exists. */
    private readonly clusterIdentity?: ClusterDaemonIdentity
  ) {}

  async authenticate(req: AuthReq, ctx: ClientCtx): Promise<AuthResult> {
    if (req.serviceAccountToken) return this.authenticateClusterDaemon(req, ctx)
    return this.authenticateApiKey(req)
  }

  /**
   * An in-cluster daemon: one TokenReview, then the same epoch mint the key path does. The
   * verifier answers null for every refusal, so nothing here distinguishes an unknown org
   * from a wrong audience — a rejection names no namespace, org, or check.
   */
  private async authenticateClusterDaemon(req: AuthReq, _ctx: ClientCtx): Promise<AuthResult> {
    if (!this.clusterIdentity) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    let verified: VerifiedClusterDaemon | null
    try {
      verified = await this.clusterIdentity.verify(req.serviceAccountToken!, {
        ...(req.daemonId ? { daemonId: req.daemonId } : {})
      })
    } catch {
      // The API server or the database blinked. Transient, like a failed key lookup: 1011
      // makes the daemon back off and retry instead of treating it as a dead identity.
      return { ok: false, closeCode: 1011, reason: 'SERVER_INTERNAL' }
    }
    if (!verified) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    // An echoed id must match what the identity resolves to; the token, never the echo, decides.
    if (req.daemonId && req.daemonId !== verified.daemonId) {
      return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    }
    return this.mintEpoch(req, verified.daemonId, verified.scope === 'org' ? verified.orgId : null)
  }

  private async authenticateApiKey(req: AuthReq): Promise<AuthResult> {
    const nowMs = this.clock.now()

    // 1. Parse offline. Malformed (or absent) → 4401 with NO DB call / NO side effects.
    const parsed = req.apiKey ? this.codec.parse(req.apiKey) : undefined
    if (!parsed) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }

    // 2. Look up by the unique peppered hash. A DB error here is transient → 1011.
    let row
    try {
      row = await this.apiKeys.findByHash(this.codec.hash(parsed.secret))
    } catch {
      return { ok: false, closeCode: 1011, reason: 'SERVER_INTERNAL' }
    }
    // Unknown / revoked / expired / wrong-principal / unbound → 4401, no epoch bump.
    if (!row) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    if (row.revokedAt) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    if (row.expiresAt && row.expiresAt.getTime() <= nowMs) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }
    if (row.principalType !== 'daemon') return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' } // user/relay key on WS
    if (!row.daemonId) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' } // key not bound to a daemon
    if (!row.orgId) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' } // daemon keys are always org-scoped
    const daemonId = row.daemonId
    const orgId = row.orgId
    // Optional echoed-id must match the daemonId the key resolves to.
    if (req.daemonId && req.daemonId !== daemonId) return { ok: false, closeCode: 4401, reason: 'AUTH_FAILED' }

    // 3. Success → mint the next monotonic sessionEpoch (persisted in C6). The
    //    provisioned row already exists (epoch 0), so this hits the increment branch.
    const result = await this.mintEpoch(req, daemonId, orgId, row.id)

    // Throttle-free best-effort liveness touch — never blocks or fails the handshake.
    if (result.ok) void this.apiKeys.touchLastUsed(row.id, new Date(nowMs)).catch(() => {})

    return result
  }

  /** The shared tail of both credentials: bump the fencing root and build `auth/ok`.
   *  A persistence failure must NOT crash the connection: 1011 → daemon retries. */
  private async mintEpoch(req: AuthReq, daemonId: string, orgId: string | null, tokenFp?: string): Promise<AuthResult> {
    const nowMs = this.clock.now()
    let sessionEpoch: bigint
    try {
      ;({ sessionEpoch } = await this.epoch.bumpSessionEpoch({
        daemonId: DaemonId(daemonId),
        orgId: orgId ? OrgId(orgId) : null,
        agentVersion: req.agentVersion,
        ...(req.machineId ? { machineId: req.machineId } : {}),
        // Audit: ties this connection to the specific ApiKey row. A cluster daemon has no
        // key, and its identity is re-derived from its token each connect, so it has none.
        ...(tokenFp ? { tokenFp } : {})
      }))
    } catch {
      return { ok: false, closeCode: 1011, reason: 'SERVER_INTERNAL' }
    }

    // The org slug for the org-scoped console deep link. Best-effort: a DB blip here must
    // not fail an otherwise-good auth — the daemon just omits the org segment if absent.
    const orgSlug = orgId ? await this.orgs.slugById(OrgId(orgId)).catch(() => null) : null

    // The daemon's member set (daemon-groups.md §3). NOT best-effort: an unread membership would
    // hand a set member `auth/ok` with no set, and it would then serve its agents outright instead
    // of only what it holds a lease for. A blip is 1011 — the daemon retries.
    let memberSet
    try {
      memberSet = await this.memberSets.setOf(DaemonId(daemonId))
    } catch {
      return { ok: false, closeCode: 1011, reason: 'SERVER_INTERNAL' }
    }

    const okFrame: AuthOk = {
      daemonId, // authoritative id (what the credential resolves to) — the daemon adopts this
      sessionEpoch: Number(sessionEpoch), // wire is a JS number; DB stores bigint
      heartbeatSec: this.config.HEARTBEAT_SEC,
      // The daemon's duty self-fence deadline is derived from this, so it can never
      // outlive the vacancy window this same CP reassigns on.
      dutyLeaseMs: this.config.DUTY_LEASE_MS,
      serverTime: new Date(nowMs).toISOString(),
      organizationMode: orgId ? 'connection' : 'frame',
      ...(this.config.WEB_APP_URL ? { webAppUrl: this.config.WEB_APP_URL } : {}),
      ...(orgSlug ? { orgSlug } : {}),
      ...(memberSet ? { memberSet: { setId: memberSet.id, name: memberSet.name } } : {}),
      // A reconnecting daemon (resume present) is told to do a full register reconcile.
      ...(req.resume ? { resume: { accepted: false } } : {})
    }

    return {
      ok: true,
      daemonId: DaemonId(daemonId),
      orgId: orgId ? OrgId(orgId) : null,
      setId: memberSet?.id ?? null,
      okFrame
    }
  }
}
