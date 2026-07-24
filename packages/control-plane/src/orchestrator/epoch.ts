/**
 * `EpochService` (design §2.4 / §4.8 `orchestrator/epoch.ts`).
 *
 * Owns the minting of fencing tokens: the per-daemon monotonic `sessionEpoch`
 * (bumped on every successful (re)auth) and the per-daemon `routingEpoch`. Both
 * are persisted in C6 (so they survive a CP restart and a rebalance) and
 * allocated inside the repo's own transaction — `EpochService` is the policy
 * seam the auth handler and `ControlSender` call, kept transport-free and
 * Clock-injected.
 */
import type { AuthReqInput, DaemonRepo } from '../persistence/ports.js'
import type { DaemonId } from '../domain/ids.js'
import type { Clock } from '../domain/clock.js'

export class EpochService {
  constructor(
    private readonly daemons: DaemonRepo,
    private readonly clock: Clock
  ) {}

  /**
   * Mint the next monotonic `sessionEpoch` for a daemon on successful auth.
   * Delegates to `DaemonRepo.upsertOnAuth`, which bumps the counter atomically
   * (`SET sessionEpoch = sessionEpoch + 1` in one transaction, §3.13). The first
   * auth for a daemon mints epoch 1; each later auth is strictly greater.
   */
  async bumpSessionEpoch(
    input: AuthReqInput
  ): Promise<{ sessionEpoch: bigint; daemon: Awaited<ReturnType<DaemonRepo['upsertOnAuth']>>['daemon'] }> {
    const { daemon, sessionEpoch } = await this.daemons.upsertOnAuth(input)
    return { sessionEpoch, daemon }
  }

  /**
   * Bump a daemon's `routingEpoch` — the version of its assignment set. Stamped
   * on a fresh `route/assign` so a reassigned session is fenced under a new
   * routing-table version (§4.11).
   */
  bumpRoutingEpoch(daemonId: DaemonId): Promise<bigint> {
    return this.daemons.bumpRoutingEpoch(daemonId)
  }
}
