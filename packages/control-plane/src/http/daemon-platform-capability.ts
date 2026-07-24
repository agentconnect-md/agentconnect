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
import { canView } from './visibility.js'

export type IntegrationPlatform = 'slack' | 'telegram' | 'discord' | 'feishu'
export type DaemonPlatformAvailability = 'available' | 'not_found' | 'unsupported'

/**
 * Resolve a visible daemon and check the capability it last registered. A
 * hidden/cross-org/missing daemon deliberately reads as not found to avoid an
 * existence oracle, following the rest of the HTTP resource guards.
 */
export async function integrationPlatformAvailability(
  deps: HttpDeps,
  input: { daemonId: string; orgId: OrgId; viewer: ViewCtx; platform: IntegrationPlatform }
): Promise<DaemonPlatformAvailability> {
  const daemon = await deps.registry.get(DaemonId(input.daemonId))
  if (!daemon || daemon.orgId !== input.orgId || !canView(daemon, input.viewer)) return 'not_found'
  return daemon.capabilities.platforms.includes(input.platform) ? 'available' : 'unsupported'
}
