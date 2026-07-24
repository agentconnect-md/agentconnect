/**
 * `DaemonAuthService` — implements the C4 `DaemonAuth` port (design §2.3, §4.6;
 * protocol §3.1; daemon-api-key-auth.md §5).
 *
 * `authenticate` is the server side of the first frame on the socket:
 *   1. parse the presented `apiKey` offline (prefix/role/charset/CRC) — malformed
 *      → close `4401` (`AUTH_FAILED`), no DB call, no side effects;
 *   2. look the key up by its peppered hash; missing / revoked / expired / not a
 *      `daemon`-principal key → `4401`, NO epoch bump;
 *   3. on success → mint the next monotonic `sessionEpoch` via `EpochService`
 *      (persisted in C6) and return the `auth/ok` frame.
 *
 * A DB error during lookup or the epoch bump closes `1011` (SERVER_INTERNAL) so the
 * daemon backs off and retries rather than treating a transient blip as a dead
 * credential. The service is transport-free: it returns an `AuthResult` the WS
 * handler turns into `replyTo(..., "auth/ok", ...)` or `transport.close(...)`.
 */
import type { AuthReq, AuthOk } from '@agentconnect.md/protocol'
import type { AuthResult, ClientCtx, DaemonAuth } from '../ports.js'
import type { ApiKeyRepo, OrgRepo } from '../persistence/ports.js'
import type { EpochService } from '../orchestrator/epoch.js'
import type { Clock } from '../domain/clock.js'
import { DaemonId } from '../domain/ids.js'
import { ApiKeyCodec } from './apiKey.js'

/** Config slice the auth service needs. */
export interface AuthServiceConfig {
  HEARTBEAT_SEC: number
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
    private readonly orgs: Pick<OrgRepo, 'slugById'>
  ) {}

  async authenticate(req: AuthReq, _ctx: ClientCtx): Promise<AuthResult> {
    const nowMs = this.clock.now()

    // 1. Parse offline. Malformed → 4401 with NO DB call / NO side effects.
    const parsed = this.codec.parse(req.apiKey)
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
    //    A persistence failure must NOT crash the connection: 1011 → daemon retries.
    let sessionEpoch: bigint
    try {
      ;({ sessionEpoch } = await this.epoch.bumpSessionEpoch({
        daemonId,
        orgId,
        agentVersion: req.agentVersion,
        ...(req.machineId ? { machineId: req.machineId } : {}),
        tokenFp: row.id // audit: ties this connection to the specific ApiKey row
      }))
    } catch {
      return { ok: false, closeCode: 1011, reason: 'SERVER_INTERNAL' }
    }

    // Throttle-free best-effort liveness touch — never blocks or fails the handshake.
    void this.apiKeys.touchLastUsed(row.id, new Date(nowMs)).catch(() => {})

    // The org slug for the org-scoped console deep link. Best-effort: a DB blip here must
    // not fail an otherwise-good auth — the daemon just omits the org segment if absent.
    const orgSlug = await this.orgs.slugById(orgId).catch(() => null)

    const okFrame: AuthOk = {
      daemonId, // authoritative id (the key's daemonId) — the daemon adopts this
      sessionEpoch: Number(sessionEpoch), // wire is a JS number; DB stores bigint
      heartbeatSec: this.config.HEARTBEAT_SEC,
      serverTime: new Date(nowMs).toISOString(),
      ...(this.config.WEB_APP_URL ? { webAppUrl: this.config.WEB_APP_URL } : {}),
      ...(orgSlug ? { orgSlug } : {}),
      // A reconnecting daemon (resume present) is told to do a full register reconcile.
      ...(req.resume ? { resume: { accepted: false } } : {})
    }

    return { ok: true, daemonId: DaemonId(daemonId), okFrame }
  }
}
