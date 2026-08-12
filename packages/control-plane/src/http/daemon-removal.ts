/**
 * `http/daemon-removal.ts` — detaching one daemon, completely.
 *
 * The foreign key does half the job and none of the visible half: `Agent.daemonId`
 * is SetNull, but nothing touches `Agent.status`, so a bare delete leaves agents
 * that read `active` with nowhere to run, relays holding collaboration entries
 * that name a dead daemon, and compiled hook rules that fail every delivery with
 * `daemon_offline` until a re-register replays them.
 *
 * Two callers need the whole sequence — `DELETE /daemons/:id`, and organization
 * deletion, which retires the cluster envelope's own daemon — and a partial copy
 * in either is a bug that only shows up in the console days later. So it lives
 * here rather than in whichever route wrote it first.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { DaemonId, OrgId } from '../domain/ids.js'
import type { HttpDeps } from './deps.js'

/** What the sequence touches — narrow, so a caller cannot pass half a graph. */
export type DaemonRemovalDeps = Pick<HttpDeps, 'repos' | 'registry' | 'relayControl' | 'collabRoutes' | 'hooks'>

/**
 * Remove `daemonId` and settle everything that pointed at it. Route-level
 * refusals (online, RBAC, existence) belong to the caller; by the time this runs
 * the decision to detach has been made.
 */
export async function detachDaemon(
  deps: DaemonRemovalDeps,
  orgId: OrgId,
  daemonId: DaemonId,
  log: FastifyBaseLogger
): Promise<void> {
  // Captured BEFORE the delete: the FK is SetNull, so the placement disappears
  // with the row and nothing afterwards could name these agents.
  const placedAgents = await deps.repos.agent.listForDaemon(daemonId)
  // Unplaced EXPLICITLY, because `setPlacement` is the only writer that pairs
  // `daemonId` with `status` — and going through the repo is also what revokes
  // the agents' webchat MCP delegations and bumps their hook dispatchRevision,
  // exactly as an operator-initiated unplacement would.
  for (const agent of placedAgents) await deps.repos.agent.setPlacement(agent.id, null)
  await deps.registry.remove(orgId, daemonId)
  // The daemon (and its FK-cascaded keys) is gone — tell relays to drop it (§9).
  deps.relayControl.daemonRevoke(daemonId)
  // Those agents just left the collaboration snapshot — but only if we push one.
  // Every other holder (relay + remaining daemons) otherwise keeps flat `agents[]`
  // entries naming this dead daemonId, and `admits()` keeps admitting wakes the
  // relay can only answer 'offline' to. Best-effort, after the row is already
  // gone; `register/ok` carries the corrected directory as the reconnect backstop.
  if (placedAgents.length > 0) {
    try {
      await deps.collabRoutes.broadcast(orgId)
    } catch (err) {
      log.warn(
        { err, daemonId, orgId },
        'collaboration routes push failed after daemon delete (backstop: reconnect snapshot)'
      )
    }
  }
  // Re-converge the unplaced agents' hook rules NOW: their compiled rules still
  // name the dead daemonId in every relay's table. Unplaced ⇒ compile() returns
  // null ⇒ pool-wide hook-remove.
  for (const agent of placedAgents) {
    void deps.hooks
      .rebroadcastForAgent(agent.id)
      .catch((err: unknown) => log.warn({ agentId: agent.id, err }, 'daemon delete: hook re-converge failed'))
  }
}
