/**
 * `http/readiness.ts` — the CP process readiness gate for zero-downtime rolling
 * updates (issue #240).
 *
 * Kubernetes rolls a Deployment by starting the new pod and waiting for its
 * readiness probe before routing traffic, then SIGTERMs the old pod. Two probes
 * with distinct meanings:
 *
 *   - **liveness** (`/livez`) — "is the process alive?" Static; it must stay
 *     green through graceful shutdown, or the kubelet would SIGKILL the pod
 *     mid-drain and cut in-flight requests.
 *   - **readiness** (`/readyz`) — "should this pod receive traffic?" Goes red
 *     when the DB is unreachable (a pod that can't reach Postgres would only
 *     serve 500s) AND the instant shutdown begins — so K8s removes the pod from
 *     the Service endpoints *before* we start closing sockets, closing the
 *     window where a terminating pod still gets new requests.
 *
 * The holder is a tiny mutable seam: the composition root owns the DB ping, the
 * `/readyz` route reads it, and the bootstrap flips `beginShutdown()` at the
 * top of the SIGTERM handler (before `drainWs()`).
 */

/** Probe the DB — resolve if reachable, reject otherwise. */
export type DbPing = () => Promise<void>

export interface Readiness {
  /** True once graceful shutdown has begun; `/readyz` then reports 503. */
  isShuttingDown(): boolean
  /** Flip to "shutting down" — idempotent. Called at the start of SIGTERM. */
  beginShutdown(): void
  /** Verify the DB is reachable (`SELECT 1`); rejects when it is not. */
  pingDb: DbPing
}

/** Build a readiness holder over a DB ping. */
export function createReadiness(pingDb: DbPing): Readiness {
  let shuttingDown = false
  return {
    isShuttingDown: () => shuttingDown,
    beginShutdown: () => {
      shuttingDown = true
    },
    pingDb
  }
}
