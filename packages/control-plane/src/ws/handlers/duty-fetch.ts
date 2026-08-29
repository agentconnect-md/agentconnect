// `duty/fetch` handler — a duty grant opens the SERVING gate, it does not
// install. A member that won a duty for an agent it has never had pulls that
// agent's complete definition here, so grants stay thin and a member asks only
// for what it lacks. Holding the duty IS the authorization: the CP answers only
// for an agent this daemon currently holds an unexpired lease on.
import { isFrame, type DutyAgentBundle } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { encodeSpecWorkspaceForPeer } from '../../domain/daemon-features.js'
import type { DaemonWsDeps } from '../deps.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleDutyFetch: Handler = async (frame, conn, deps) => {
  if (!isFrame('duty/fetch')(frame)) return
  // The ledger's door (daemon-groups.md §3): membership in a member set, not install-wideness.
  if (conn.setId === null) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'duty ledger requires membership in a member set', false)
    return
  }
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  // Fenced on the frame's org, so an asker can only fetch a bundle inside the org it named.
  const agent = await deps.agent.get(orgId, agentId)
  // Unknown agent, no duty, or no assembler wired: all answer "install nothing".
  // An empty reply, never an error frame — the member's behavior is the same.
  if (!agent || !deps.agentBundle) {
    conn.replyTo(frame, 'duty/fetch/ok', {})
    return
  }
  if (!(await deps.dutyLease.holdsAgent(DaemonId(conn.daemonId), agentId))) {
    conn.replyTo(frame, 'duty/fetch/ok', {})
    return
  }
  const bundle = await deps.agentBundle(agent)
  rememberScopes(conn.daemonId, deps, bundle)
  // Workspace dual-encoded per the asking member's advertised features (§8).
  const features = deps.connReg.get(conn.daemonId)?.capabilities?.features
  conn.replyTo(frame, 'duty/fetch/ok', {
    bundle: { ...bundle, spec: encodeSpecWorkspaceForPeer(bundle.spec, features) }
  })
}

/**
 * Teach this connection which org the fetched resources belong to.
 *
 * The id→org maps are otherwise built ONLY from the `register` reconcile
 * snapshot, so a resource a member acquires mid-session through `duty/fetch` is
 * absent from them until its next reconnect. Any later C→D frame whose payload
 * carries a bare id — a session/workspace/memory read keyed on `agentId`,
 * `cron/run`, `integration/forget` — then has no org to resolve on an
 * install-wide connection and raises SCOPE_DENIED before it is sent.
 *
 * This is a scoping HINT, never an authorization: holding the duty is what
 * authorizes, and a frame for a resource the member declined to install still
 * fails on the member. Recording it optimistically is therefore safe, and it
 * also lets the inbound gate cross-check the org the member claims.
 *
 * The removal frames do NOT rely on this — they carry an explicit org, which is
 * authoritative and local to the send. This only covers the frames that cannot.
 */
function rememberScopes(daemonId: string, deps: DaemonWsDeps, bundle: DutyAgentBundle): void {
  const state = deps.connReg.get(daemonId)
  if (!state) return
  const orgId = bundle.spec.orgId
  if (orgId) state.orgByAgent?.set(bundle.agentId, orgId)
  for (const i of bundle.integrations) if (i.orgId) state.orgByIntegration?.set(i.integrationId, i.orgId)
  for (const c of bundle.crons) if (c.orgId) state.orgByCron?.set(c.cronId, c.orgId)
}
