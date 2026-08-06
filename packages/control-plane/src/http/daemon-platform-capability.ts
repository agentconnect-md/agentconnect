/**
 * Daemon-platform capability checks shared by integration write paths.
 *
 * A placed agent's daemon is the authority for which bot adapters can run.
 * Keep this separate from live connectivity: a disconnected daemon still has
 * its most recently registered capabilities and will reconcile later.
 */
import { DaemonId, type OrgId } from '../domain/ids.js'
import type { ViewCtx } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { canView } from '../authorization/policy.js'

export type DaemonPlatformAvailability = 'available' | 'not_found' | 'unsupported'

/**
 * Resolve a visible daemon and check the capability it last registered. A
 * hidden/cross-org/missing daemon deliberately reads as not found to avoid an
 * existence oracle, following the rest of the HTTP resource guards.
 *
 * `platform` is an OPEN id (integration-plugin-architecture.md §9): the caller's
 * value already came from `deps.platforms` — the registry is the single
 * platform-set authority — and the daemon's advertised list is the authority for
 * what it can actually run. The hand-copied closed union that used to live here
 * (one of the audit's six, Appendix A) added no safety: it could only ever
 * re-state the registry's ids, and a fifth registered platform would have needed
 * an edit here to be checkable at all.
 */
export async function integrationPlatformAvailability(
  deps: HttpDeps,
  input: { daemonId: string; orgId: OrgId; viewer: ViewCtx; platform: string }
): Promise<DaemonPlatformAvailability> {
  // Org-fenced read (org-scoped-data-layer.md §3): a cross-org daemon id reads
  // as absent, so only the visibility policy check remains here.
  const daemon = await deps.registry.get(input.orgId, DaemonId(input.daemonId))
  if (!daemon || !canView(daemon, input.viewer)) return 'not_found'
  return daemon.capabilities.platforms.includes(input.platform) ? 'available' : 'unsupported'
}
