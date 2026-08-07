/**
 * `cache.ts` — the one way this process builds an in-memory cache.
 *
 * Every cache here is bounded, expires on the injected clock, and (where it
 * fronts a provider call) coalesces concurrent readers through `LRUCache#fetch`.
 * Before this existed the same twenty lines were hand-written per call site with
 * quietly different semantics — some unbounded, most evicting oldest-INSERTED
 * rather than least-recently-used, each deciding for itself whether a failure
 * or a negative answer was worth caching.
 *
 * NOT for caches whose invalidation is more than a TTL. `LogtoIdentityService`
 * and `InstallationTokenService` fence in-flight reads on a per-subject epoch so
 * a read that began before an unlink cannot write the removed identity back
 * after it; `fetch` has no such notion, and expressing those here would drop a
 * deliberate authorization property. They stay hand-written on purpose.
 */
import type { Clock } from './domain/clock.js'

/**
 * Shared `LRUCache` wiring.
 *
 * `perf` is THE time seam — without it the cache would read the wall clock
 * while everything around it reads the injected one. `ttlResolution: 0` turns
 * off lru-cache's 1 ms `now()` debounce, which is driven by a real timer a
 * `FakeClock` cannot advance; expiry is evaluated lazily on read, so no
 * background timer exists either way.
 *
 * The clock MUST report real epoch milliseconds, as `Clock` documents. lru-cache
 * stores an entry's start time and treats a falsy one as "no TTL recorded", so an
 * entry written at time 0 would never expire. Production passes `Date.now()`;
 * a test clock has to be seeded with an epoch rather than left at 0.
 */
export function cacheOptions(clock: Clock, max: number) {
  return { max, ttlResolution: 0, perf: clock } as const
}
