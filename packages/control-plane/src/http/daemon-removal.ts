/**
 * `http/daemon-removal.ts` — detaching one daemon, completely.
 *
 * The foreign key does half the job and none of the visible half: `Agent.daemonId`
 * is SetNull, but nothing touches `Agent.status`, so a bare delete leaves agents
 * that read `active` with nowhere to run, relays holding collaboration entries
 * that name a dead daemon, and compiled hook rules that fail every delivery with
 * `daemon_offline` until a re-register replays them.
 *
 * Three callers need the whole sequence — `DELETE /daemons/:id`, organization deletion
 * (which retires the cluster envelope's own daemon), and the pool-member reaper — and a
 * partial copy in any of them is a bug that only shows up in the console days later. So it
 * lives here rather than in whichever route wrote it first.
 *
 * The two paths differ in ONE thing, deliberately: who decides. An operator's detach has
 * already decided, so it unplaces first and then deletes — and a crash between the two leaves
 * a live daemon with unplaced agents, which converges. The reaper's decision is a guess about
 * a row it read moments ago, so its delete comes FIRST as a fenced claim, which puts the
 * cascade before the settlement and makes the pair a transaction (`retirePoolMember`) rather
 * than an ordering.
 */
import type { FastifyBaseLogger } from 'fastify'
import type { AgentId, DaemonId, OrgId } from '../domain/ids.js'
import { UNPLACED } from '../domain/placement.js'
import type { HttpDeps } from './deps.js'

/** Just enough of an agent to re-converge what pointed at it. */
type UnplacedAgent = { id: AgentId; orgId: OrgId }

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
  for (const agent of placedAgents) await deps.repos.agent.setPlacement(agent.id, UNPLACED)
  await deps.registry.remove(orgId, daemonId)
  await settleAfterRemoval(deps, daemonId, placedAgents, log)
}

/**
 * Retire one install-wide pool member whose Pod is gone
 * (`orchestrator/poolMemberReaper.ts`). No org owns the row, so the org-fenced delete
 * cannot reach it — and its placements may span every organization, which is the whole
 * reason it goes through this sequence instead of a bare delete.
 *
 * `fence` re-checks, inside the delete statement itself, the staleness that put this member on
 * the worklist plus the `sessionEpoch` observed there; a member that heartbeated or
 * re-authenticated in between simply does not match, and false comes back with NOTHING
 * written. The alternative — unplacing first and checking after — deactivates a live member's
 * agents across every organization before it discovers the member is alive.
 *
 * What follows the transaction is only the out-of-database convergence, which is best-effort
 * by nature and backstopped by `register/ok` on the next reconnect.
 */
export async function retirePoolMember(
  deps: DaemonRemovalDeps,
  member: { daemonId: DaemonId; sessionEpoch: bigint },
  retiredBefore: Date,
  log: FastifyBaseLogger
): Promise<boolean> {
  const { daemonId, sessionEpoch } = member
  // One transaction for both database halves — the delete and the unplacement it cascades —
  // so nothing here can be interrupted into leaving an agent active with nowhere to run.
  const { deleted, settled } = await deps.registry.retirePoolMember(daemonId, { retiredBefore, sessionEpoch })
  if (!deleted) return false
  await settleAfterRemoval(deps, daemonId, settled, log)
  return true
}

/** Everything outside the database that pointed at the daemon. Re-converges from current
 *  state, so it is safe to run once the row is gone — and runs ONLY then. */
async function settleAfterRemoval(
  deps: DaemonRemovalDeps,
  daemonId: DaemonId,
  unplacedAgents: UnplacedAgent[],
  log: FastifyBaseLogger
): Promise<void> {
  // The daemon (and its FK-cascaded keys) is gone — tell relays to drop it (§9).
  deps.relayControl.daemonRevoke(daemonId)
  // Those agents just left the collaboration snapshot — but only if we push one.
  // Every other holder (relay + remaining daemons) otherwise keeps flat `agents[]`
  // entries naming this dead daemonId, and `admits()` keeps admitting wakes the
  // relay can only answer 'offline' to. Best-effort, after the row is already
  // gone; `register/ok` carries the corrected directory as the reconnect backstop.
  // Which organizations need one is derived from the placements the row held, because a
  // pool member's agents are not one org's.
  for (const orgId of new Set(unplacedAgents.map((agent) => agent.orgId))) {
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
  for (const agent of unplacedAgents) {
    void deps.hooks
      .rebroadcastForAgent(agent.id)
      .catch((err: unknown) => log.warn({ agentId: agent.id, err }, 'daemon delete: hook re-converge failed'))
  }
}
