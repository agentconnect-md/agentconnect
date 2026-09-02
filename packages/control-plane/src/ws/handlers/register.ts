/**
 * `register` → `register/ok` handler (design §4.6, protocol §3.3).
 *
 * The convergence point: records capabilities (C4), then asks the C3 reconcile
 * service for the authoritative snapshot built from the C6 routing table. The
 * connection advances to READY (the only state in which the CP issues control),
 * the owned sessions are bound in the `ConnectionRegistry`, and the `register/ok`
 * REP (`corr` = the `register` frame id) is sent.
 *
 * Idempotent: re-sending `register` re-runs reconcile and yields the same
 * snapshot (CP wins all conflicts) — reconnect is convergence, not replay.
 */
import {
  isFrame,
  AGENT_EXISTS_FEATURE,
  APPROVAL_DM_ROUTE_V1_FEATURE,
  CODEHOST_NOTE_PROJECTION_V1_FEATURE,
  CODEHOST_REVIEW_V1_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  GITCRED_GITHUB_V2_FEATURE,
  GITCRED_PROVIDER_V2_FEATURE,
  GITLAB_EFFECT_V1_FEATURE,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_METADATA_ACK_FEATURE,
  SESSION_PURGE_FEATURE,
  SESSION_VISIBILITY_FEATURE
} from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import type { Handler } from './index.js'
import { clearAwaitingApprovals } from '../approval-waits.js'

export const handleRegister: Handler = async (frame, conn, deps) => {
  if (!isFrame('register')(frame)) return
  const req = frame.payload
  const did = DaemonId(conn.daemonId)

  // An observer (`reconcile --once`) is admitted on the identity a member presents but is not one:
  // it serves nothing, so it must hold no membership the duty ledger could grant against. Refused
  // on an org-scoped connection — that credential is an operator's daemon key, not a job's identity.
  if (req.observer === true) {
    if (conn.orgId !== null) {
      conn.sendError(frame.id, 'SCOPE_DENIED', 'observer registration requires an install-wide connection', false)
      return
    }
    await deps.registry.withdrawObserver(did)
  }

  await deps.registry.upsertOnRegister(did, req)
  // A fresh registration clears the member's draining declaration (frames/duty.ts).
  deps.dutyLease.onRegister(did)
  // Silent reset of the daemon's approval waits ahead of its replay (§7): a superseded socket's
  // late `awaiting_permission` or a skipped close clear must not outlive the connection that made it.
  void deps.connReg.runApprovalMutation(conn.daemonId, () => clearAwaitingApprovals(deps, conn.daemonId, false))
  const snap = await deps.orchestrator.reconcile(did, req)

  // Update the live index: capabilities/maxAgents + the bound session set.
  const state = deps.connReg.get(conn.daemonId)
  if (state) {
    state.capabilities = req.capabilities
    state.maxAgents = req.maxAgents
    state.assignments.clear()
    state.orgByAgent = new Map(snap.agents.flatMap((agent) => (agent.orgId ? [[agent.agentId, agent.orgId]] : [])))
    state.orgByIntegration = new Map(
      snap.integrations.flatMap((integration) =>
        integration.orgId ? [[integration.integrationId, integration.orgId]] : []
      )
    )
    state.orgByCron = new Map(snap.crons.flatMap((cron) => (cron.orgId ? [[cron.cronId, cron.orgId]] : [])))
    state.orgByMcpServer = new Map(
      snap.mcpServers.flatMap((server) => (server.orgId ? [[server.name, server.orgId]] : []))
    )
    state.orgByMemoryConnection = new Map(
      snap.memoryConnections.flatMap((memory) => (memory.orgId ? [[memory.connectionId, memory.orgId]] : []))
    )
  }
  for (const a of snap.assignments) {
    deps.connReg.bindSession(a.sessionKey, conn.daemonId)
  }

  // Inject the current relay roster so the daemon converges to the relays it should
  // dial (shared-bot-relay.md §5). Hot changes ride the `relay/roster` EVT.
  const [relays, gitCommitIdentity] = await Promise.all([deps.relayRoster(), deps.github?.getGitCommitIdentity()])

  conn.state = 'READY'
  conn.replyTo(frame, 'register/ok', {
    ...snap,
    relays,
    ...(gitCommitIdentity ? { gitCommitIdentity } : {}),
    // `agent-directory-org-scope-v1`: this CP accepts a `channel/agents` REQ with NO
    // channel (the org-wide, policy-filtered peer directory) and ships the flat
    // `collabRoutes.agents[]`. A daemon that does not see it must keep substituting the
    // caller's current channel, because an older CP rejects a channel-less payload.
    serverFeatures: [
      'gitcred-actions-v1',
      // §17.1: this CP decodes provider-qualified gitcred v2 requests. A daemon
      // may name provider 'gitlab' only after seeing this.
      GITCRED_PROVIDER_V2_FEATURE,
      // §17.3: …and decodes an explicitly github-qualified request, echoing the provider back so a
      // daemon can verify a GitHub grant the same way it verifies every other provider's.
      GITCRED_GITHUB_V2_FEATURE,
      // §14.2: …and decodes purpose 'gitlab_effect', the broker's action-time effect lease.
      GITLAB_EFFECT_V1_FEATURE,
      // §15.1/§17.2: this CP serves the provider-neutral review authorization, the
      // publication lease with its operation ledger, and the body-free result.
      CODEHOST_REVIEW_V1_FEATURE,
      // §16/§17.2: …and drives the run-projection ledger end to end, including the gitlab arm of
      // `hook/start` that records the started head and opens `running`. A daemon must not send
      // that arm before seeing this: a provider member an older CP cannot route is a fatal frame.
      CODEHOST_NOTE_PROJECTION_V1_FEATURE,
      'agent-directory-org-scope-v1',
      SESSION_LIVE_TAIL_FEATURE,
      SESSION_METADATA_ACK_FEATURE,
      SESSION_PURGE_FEATURE,
      SESSION_VISIBILITY_FEATURE,
      ORGANIZATION_KNOWLEDGE_FEATURE,
      AGENT_EXISTS_FEATURE,
      // slack-approval-dm.md §4.2: this CP resolves and revalidates approval-DM recipients.
      APPROVAL_DM_ROUTE_V1_FEATURE
    ]
  })
  deps.connReg.markReady(conn.daemonId, conn)
  deps.pullRequestFeedback?.kick()

  // Converge the per-session memory-capture gates (session-visibility.md §5.1).
  // A visibility change committed while this daemon was offline was never
  // delivered — the live push is connection-scoped — so the snapshot, not the
  // push, is what ultimately closes the bypass. Best-effort: the daemon fails
  // closed (unknown gate ⇒ capture excluded) until it lands, and the next
  // register retries.
  await deps.visibilityPush?.replayTo(did).catch(() => {})

  // Now that this connection has actually reached READY (reconcile succeeded above),
  // close any CP-commanded restart/upgrade op it was relaunching for (§7). Best-effort
  // — register/ok is already sent, so a settle failure must not disrupt registration.
  await deps.registry.settleLifecycleOpOnReady(did).catch(() => {})

  // A socket can disappear after daemon-side detach/activate work but before its
  // ACK reaches the request that initiated it. The durable staging fence rides
  // reconnect registration; resume it only after register/ok made this socket
  // READY. AgentMoveService waits behind that request's mutation gate and
  // re-checks current DB placement before activating anything.
  await Promise.all(
    req.localState.stagedAgents.map(({ agentId, moveId }) =>
      moveId ? deps.recoverStagedAgent(AgentId(agentId), did, moveId) : Promise.resolve()
    )
  )
}
