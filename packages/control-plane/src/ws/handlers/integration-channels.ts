/**
 * `integration/channels` handler (per-conversation trigger config).
 *
 * A fire-and-forget EVT (no reply). Slack reports the full membership set; a
 * platform that cannot enumerate its chats reports `authoritative:false`, which
 * upserts observed conversations without deleting older rows. Both forms
 * PRESERVE each stored conversation's operator-chosen trigger. Channel ids/names
 * are control metadata — never message content (§1/§12). Every accepted report
 * also hot-pushes the derived collaboration routes without waiting for reconnect.
 *
 * `removed` is the one way a non-authoritative reporter can DELETE: its omissions
 * carry no meaning, so a conversation it has genuinely left has to be named. It
 * applies alongside the upsert, so one report can both refresh what remains and
 * retire what is gone.
 *
 * Scope check: the integration's owning agent must be placed on the REPORTING
 * daemon (the same daemon-scoped join as `register/ok.integrations[]`) — a daemon
 * can never write channel rows for another daemon's integration.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId } from '../../domain/ids.js'
import { isGatedAgent } from '../../orchestrator/placement.js'
import type { Handler } from './index.js'

export const handleIntegrationChannels: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/channels')(frame)) return
  const p = frame.payload
  const owned = await deps.integration.activeForDaemon(DaemonId(conn.daemonId))
  const integration = owned.find((i) => i.id === p.integrationId)
  if (!integration) return // unknown / just deleted / not this daemon's — drop silently
  // §4.2(4) session-access cross-check (session-access-cold-visit.md): a channel observed
  // private drops its cached `public` audience verdict. Invalidation only — never a written
  // verdict, absent/false `isPrivate` changes nothing — so it can run ahead of the mutation
  // gate (dropping a cache entry is safe even for a report that loses the gate).
  if (integration.platform === 'slack') {
    const privateChannels = p.channels.filter((c) => c.isPrivate === true).map((c) => c.id)
    if (privateChannels.length > 0) deps.slackSessionAccess?.dropPublicAudiences(integration.botId, privateChannels)
  }
  const release = deps.agentMutations.tryBeginMutation(integration.agentId)
  if (!release) return // a placement move owns this agent; its authoritative bundle wins
  try {
    // Ownership may have changed while the first repository read was in flight.
    // Re-check under the shared mutation lease before accepting this daemon's
    // latest-wins snapshot, otherwise a late source event can overwrite target
    // channel metadata after a cold move.
    const current = await deps.integration.activeForDaemon(DaemonId(conn.daemonId))
    if (!current.some((candidate) => candidate.id === integration.id && candidate.agentId === integration.agentId)) {
      return
    }
    // Conversation gating (resource-visibility.md §14): a gated (restricted-agent)
    // integration's fresh conversations start Off — an editor must enable them in
    // the console. Known rows keep their operator-chosen trigger either way.
    const owner = await deps.agent.getUnscoped(AgentId(integration.agentId))
    const defaultTrigger = owner && isGatedAgent(owner) ? ('off' as const) : undefined
    await deps.integrationChannel.replaceSnapshot(
      integration.id,
      p.channels,
      defaultTrigger || p.authoritative === false || p.removed?.length
        ? {
            ...(defaultTrigger ? { defaultTrigger } : {}),
            ...(p.authoritative === false ? { authoritative: false } : {}),
            ...(p.removed?.length ? { removed: p.removed } : {})
          }
        : undefined
    )
  } finally {
    release()
  }

  // Conversation availability is part of the effective agent-call edge. Refresh
  // relay and daemon collaboration snapshots immediately after accepting a report
  // so the data plane does not wait for an unrelated policy edit or reconnect.
  // Register baselines remain the durable backstop if this best-effort push fails.
  try {
    await deps.collabRoutes.broadcast(integration.orgId)
  } catch {
    // A later policy/placement change or reconnect rebuilds the snapshot.
  }
}
