// Reset a daemon's approval waits (slack-approval-dm.md §7); every caller queues this on the registry's per-daemon tail.
import { DaemonId } from '../domain/ids.js'
import type { DaemonWsDeps } from './deps.js'

/** Clear the daemon's `awaiting_permission` rows; `publish` tells SSE, which a register-time clear skips so the replay that follows in milliseconds does not flap the bell. */
export async function clearAwaitingApprovals(
  deps: Pick<DaemonWsDeps, 'session' | 'events' | 'clock'>,
  daemonId: string,
  publish: boolean
): Promise<void> {
  try {
    const ts = new Date(deps.clock.now()).toISOString()
    for (const row of await deps.session.clearAwaitingPermissionForDaemon(DaemonId(daemonId))) {
      if (!publish) continue
      deps.events.publishState(DaemonId(daemonId), { agentId: row.agentId, sessionId: row.id, state: 'idle', ts })
    }
  } catch {
    // Best-effort: a refused write only delays the bell until the daemon's replay or the next reset.
  }
}
