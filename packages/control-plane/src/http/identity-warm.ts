/**
 * Identity warm-at-touch (session-access-cold-visit.md §3, Phase 1).
 *
 * The Logto identity projection is the serial head of every cold session read:
 * `viewerFor` needs the caller's linked identities before the SQL predicate can
 * run, and an infrequent visitor's entry is always expired. But `/sessions` is
 * never the visit's first authenticated request — so the auth plane fires this
 * trigger on EVERY successful authentication, and by the time the session read
 * arrives the entry is fresh or the lookup is already in flight.
 *
 * Fires on both auth paths (§9 Q2 decided as "every authenticated request"):
 * OIDC requests carry the sub for free; API-key requests (agent-assistant MCP
 * reads pay the same Logto hop through `users.getOidcSubject`) resolve it here,
 * behind the per-principal throttle and a process-lifetime memo, so steady-state
 * API-key traffic costs no extra reads. The upstream ceiling is owned by the
 * service's dueness gate; this module only bounds its own bookkeeping.
 */
import type { Clock } from '../domain/clock.js'

/** Structural deps — the composition root passes LogtoIdentityService + PgUserRepo. */
export interface IdentityWarmDeps {
  identity: { ensureIdentityFresh(sub: string): void }
  users: { getOidcSubject(userId: string): Promise<string | null> }
  clock: Clock
  log?: { debug(obj: object, msg: string): void }
}

// Per-principal re-check cadence: half the 60 s refresh-ahead band, so a due warm
// fires at most 30 s late while API-key sub resolution stays ≤ 2 reads/principal/min.
const WARM_THROTTLE_MS = 30_000
// Caps both maps below, enforced per entry by {@link boundedSet}.
const MAX_TRACKED_PRINCIPALS = 10_000

// Recency-ordered bounded write: refresh the key's position, evict only the
// least-recently-written entry on overflow. A wholesale clear would let a working
// set just past the cap defeat the throttle and the memo continuously; per-entry
// eviction costs one early re-check for the evicted principal and nothing else.
function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_TRACKED_PRINCIPALS) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
}

/** Build the trigger the auth plugin fires after each successful authentication.
 *  Fire-and-forget by contract: it never throws and never surfaces a rejection. */
export function createIdentityWarmTrigger(
  deps: IdentityWarmDeps
): (principal: { userId: string; oidcSubject?: string }) => void {
  const lastCheckedAt = new Map<string, number>()
  // userId → OIDC sub. Immutable once bound (JIT provisioning and invite claims only
  // ever set it), so positives memoize for the process lifetime; a subless account
  // (devAuth-era row) is retried once per throttle window instead.
  const subs = new Map<string, string>()
  const remember = (userId: string, sub: string) => boundedSet(subs, userId, sub)
  return ({ userId, oidcSubject }) => {
    const now = deps.clock.now()
    const last = lastCheckedAt.get(userId)
    if (last !== undefined && now - last < WARM_THROTTLE_MS) return
    boundedSet(lastCheckedAt, userId, now)
    const sub = oidcSubject ?? subs.get(userId)
    if (sub !== undefined) {
      remember(userId, sub)
      deps.identity.ensureIdentityFresh(sub)
      return
    }
    // API-key path: one indexed PK read (throttled above); swallowed on failure —
    // the warm must never delay or fail the request it rides behind.
    void deps.users
      .getOidcSubject(userId)
      .then((resolved) => {
        if (resolved === null) return
        remember(userId, resolved)
        deps.identity.ensureIdentityFresh(resolved)
      })
      .catch((err: unknown) => deps.log?.debug({ err, userId }, 'identity warm sub lookup failed'))
  }
}
