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
  FOLLOW_UP_WATCH_FEATURE,
  CAPABILITY_REQUESTS_FEATURE,
  CAPABILITY_REQUESTS_V2_FEATURE,
  FRAME_FRAGMENTS_FEATURE,
  DECISION_TOOLS_V1_FEATURE,
  DECISION_MODEL_SELECTION_V1_FEATURE,
  DECISION_CHAIN_V1_FEATURE,
  WEBCHAT_IMAGES_FEATURE,
  MEMORY_TRANSACTION_V1_FEATURE,
  PROVIDER_CREDENTIALS_V1_FEATURE,
  REPO_CANDIDATES_V1_FEATURE,
  REPO_CANDIDATES_ALL_V1_FEATURE,
  MEMORY_CAPTURE_FENCE_V1_FEATURE,
  isFrame,
  AGENT_EXISTS_FEATURE,
  COMPUTER_LEASE_FEATURE,
  COMPUTER_LEASE_QUEUE_FEATURE,
  COMPUTER_POOL_FEATURE,
  COMPUTER_CHANNEL_FEATURE,
  AGENT_PLACEMENT_FEATURE,
  AGENT_MEMORY_HISTORY_READ_V1_FEATURE,
  AGENT_MEMORY_STORE_OPERATION_ID_V1_FEATURE,
  AGENT_MEMORY_STORE_V1_FEATURE,
  APPROVAL_DM_ROUTE_V1_FEATURE,
  ASSISTANT_RESPONSIBLE_ROUTE_V1_FEATURE,
  CHAT_ACTOR_V1_FEATURE,
  READ_ACCESS_V1_FEATURE,
  READ_ACCESS_LINKED_V1_FEATURE,
  READ_ACCESS_BATCH_V1_FEATURE,
  CODEHOST_NOTE_PROJECTION_V1_FEATURE,
  CODEHOST_REVIEW_V1_FEATURE,
  CRON_REPORT_ACK_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  KNOWLEDGE_RECORD_FEATURE,
  AGENT_SKILL_STATUS_V1_FEATURE,
  GITCRED_GITHUB_V2_FEATURE,
  GITCRED_PROVIDER_V2_FEATURE,
  GITEA_V1_FEATURE,
  GITLAB_EFFECT_V1_FEATURE,
  INTEGRATION_REVOKED_FEATURE,
  INTEGRATION_TENANT_FEATURE,
  SESSION_EXECUTORS_V1_FEATURE,
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

  // register/ok grows with the daemon's agents and the org's conversations, so it is the first frame that may need fragments.
  if (req.capabilities.features.includes(FRAME_FRAGMENTS_FEATURE)) conn.enableFrameFragments()
  conn.state = 'READY'
  conn.replyTo(frame, 'register/ok', {
    ...snap,
    relays,
    ...(gitCommitIdentity ? { gitCommitIdentity } : {}),
    // A shared image picks its original's home at publication, before any signing (webchat-generated-images.md §5).
    ...(deps.fileTransfer ? { fileTransfer: { maxBytes: deps.fileTransfer.maxBytes } } : {}),
    // `agent-directory-org-scope-v1`: this CP accepts a `channel/agents` REQ with NO
    // channel (the org-wide, policy-filtered peer directory) and ships the flat
    // `collabRoutes.agents[]`. A daemon that does not see it must keep substituting the
    // caller's current channel, because an older CP rejects a channel-less payload.
    serverFeatures: [
      'gitcred-actions-v1',
      ...(deps.providerKey ? [PROVIDER_CREDENTIALS_V1_FEATURE] : []),
      // multi-repository-workspaces.md, The selector: this CP answers `repo-candidates/request` from its installation rosters.
      ...(deps.repoCandidates ? [REPO_CANDIDATES_V1_FEATURE] : []),
      // …and every grant's roster for organization research (assistant-mode.md §5.15).
      ...(deps.repoCandidates ? [REPO_CANDIDATES_ALL_V1_FEATURE] : []),
      ...(deps.decision
        ? [DECISION_TOOLS_V1_FEATURE, DECISION_MODEL_SELECTION_V1_FEATURE, DECISION_CHAIN_V1_FEATURE]
        : []),
      // §17.1: this CP decodes provider-qualified gitcred v2 requests. A daemon
      // may name provider 'gitlab' only after seeing this.
      GITCRED_PROVIDER_V2_FEATURE,
      // §17.3: …and decodes an explicitly github-qualified request, echoing the provider back so a
      // daemon can verify a GitHub grant the same way it verifies every other provider's.
      GITCRED_GITHUB_V2_FEATURE,
      // §14.2: …and decodes purpose 'gitlab_effect', the broker's action-time effect lease.
      GITLAB_EFFECT_V1_FEATURE,
      // gitea-integration.md §11: gitea gitcred purposes, the gitea hook/start arm, and the review and commit-status surfaces.
      GITEA_V1_FEATURE,
      // §15.1/§17.2: this CP serves the provider-neutral review authorization, the
      // publication lease with its operation ledger, and the body-free result.
      CODEHOST_REVIEW_V1_FEATURE,
      // §16/§17.2: …and drives the run-projection ledger end to end, including the gitlab arm of
      // `hook/start` that records the started head and opens `running`. A daemon must not send
      // that arm before seeing this: a provider member an older CP cannot route is a fatal frame.
      CODEHOST_NOTE_PROJECTION_V1_FEATURE,
      'agent-directory-org-scope-v1',
      // webchat-generated-images.md §5: this CP signs `image/original/put|get` and proxies `image/original/resolve`.
      WEBCHAT_IMAGES_FEATURE,
      SESSION_LIVE_TAIL_FEATURE,
      SESSION_METADATA_ACK_FEATURE,
      SESSION_PURGE_FEATURE,
      SESSION_VISIBILITY_FEATURE,
      // high-availability.md: this CP ACKs a terminal cron outcome, so the daemon keeps it until then.
      CRON_REPORT_ACK_FEATURE,
      ORGANIZATION_KNOWLEDGE_FEATURE,
      // assistant-mode.md §5.16: this CP serves `knowledge/record/*` and honours `withOutsiders` on the knowledge reads.
      ...(deps.organizationRecord ? [KNOWLEDGE_RECORD_FEATURE] : []),
      // source-cache.md §11: this CP stores `agent/skill-status`; a daemon sends none without it.
      ...(deps.agentSkillSourceStatus ? [AGENT_SKILL_STATUS_V1_FEATURE] : []),
      AGENT_EXISTS_FEATURE,
      // k8s-daemon-pool.md §4: …and says WHERE a surviving agent is placed, so the pool's
      // reconciler can tell one that is gone from one that moved off the set.
      AGENT_PLACEMENT_FEATURE,
      // computer-use.md §4.4: this CP grants Computer control leases.
      ...(deps.computerLeases ? [COMPUTER_LEASE_FEATURE] : []),
      // …and queues an acquire that carries `waitMs` first come, first served.
      ...(deps.computerLeases ? [COMPUTER_LEASE_QUEUE_FEATURE] : []),
      // computer-use.md §3.7: this CP issues per-session data-plane tokens.
      ...(deps.computerChannelGrants ? [COMPUTER_CHANNEL_FEATURE] : []),
      // computer-use.md §15.1: this CP allocates and wakes managed computers in the pool.
      ...(deps.computerPool ? [COMPUTER_POOL_FEATURE] : []),
      // slack-approval-dm.md §4.2: this CP resolves and revalidates approval-DM recipients.
      APPROVAL_DM_ROUTE_V1_FEATURE,
      // …and tells whether a chat member is any editor's linked identity, for a synced integration's chat actions.
      CHAT_ACTOR_V1_FEATURE,
      // …and names an assistant-mode agent's derived responsible user (assistant-mode.md §5.1).
      ASSISTANT_RESPONSIBLE_ROUTE_V1_FEATURE,
      // …and gives the console's session visibility for whoever asks a cross-platform read.
      READ_ACCESS_V1_FEATURE,
      // …and the chat identity a console user linked in a bot's workspace, which a read or write through it is judged as.
      READ_ACCESS_LINKED_V1_FEATURE,
      // …and answers that for up to 64 sessions at once, which `recall` lists a person's own conversations by.
      READ_ACCESS_BATCH_V1_FEATURE,
      // memory-evolution.md §3.2.1: this CP serves the whole `memory/store` family, the migration completion included.
      AGENT_MEMORY_STORE_V1_FEATURE,
      AGENT_MEMORY_HISTORY_READ_V1_FEATURE,
      // high-availability.md: a `memory/store` write re-sent under its operation id is answered, not applied twice.
      ...(deps.agentMemoryStore?.deduplicatesOperations() ? [AGENT_MEMORY_STORE_OPERATION_ID_V1_FEATURE] : []),
      MEMORY_TRANSACTION_V1_FEATURE,
      MEMORY_CAPTURE_FENCE_V1_FEATURE,
      // session-executors.md §6: this CP serves `executor/candidates` and relays `executor/prepare`; a holder must not send either before seeing this.
      SESSION_EXECUTORS_V1_FEATURE,
      // assistant-mode.md §5.14: this CP takes follow-up watches and sends their wakes.
      ...(deps.followUpWatch ? [FOLLOW_UP_WATCH_FEATURE] : []),
      // capability-requests.md: this CP takes `capability/*` and sends `session/capability-settled`.
      ...(deps.capabilityRequests ? [CAPABILITY_REQUESTS_FEATURE] : []),
      // …and its repository, connection and MCP-header secret kinds, with `agent/mcp-rebound`.
      ...(deps.capabilityRequests ? [CAPABILITY_REQUESTS_V2_FEATURE] : []),
      // A daemon socket reports explicit credential-lifecycle events only to a CP that applies them.
      ...(deps.socketBotRevocation ? [INTEGRATION_REVOKED_FEATURE] : []),
      // A daemon socket reports the tenant its traffic named only to a CP that records it.
      ...(deps.socketBotTenant ? [INTEGRATION_TENANT_FEATURE] : [])
    ]
  })
  deps.connReg.markReady(conn.daemonId, conn)
  deps.pullRequestFeedback?.kick()
  deps.followUpWatch?.kick()
  deps.capabilityRequests?.daemonReady(
    conn.daemonId,
    snap.agents.map((agent) => agent.agentId)
  )
  void deps.httpBotDaemonReady?.(conn.daemonId).catch(() => {})

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
