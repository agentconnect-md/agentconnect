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
 * Scope check: the integration's owning agent must be SERVED by the reporting
 * daemon — the same `pinned-to-me ∪ duties I hold` union `register/ok.integrations[]`
 * ships under, so a duty holder may write for what it was given and nothing else.
 * A daemon can never write channel rows for another daemon's integration.
 */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { gatesNewConversations } from '../../orchestrator/placement.js'
import { servedAgents } from '../../orchestrator/servedAgents.js'
import type { DaemonWsDeps } from '../deps.js'
import type { AgentRecord, ChannelTrigger, IntegrationRecord } from '../../persistence/ports.js'
import type { Handler } from './index.js'

/** Active integrations of the agents this daemon serves — a pool member is the placement of
 *  none of them, so `activeForDaemon` alone discarded every one of its reports. */
async function activeForServedAgents(daemonId: DaemonId, deps: DaemonWsDeps): Promise<IntegrationRecord[]> {
  const { agents } = await servedAgents(daemonId, {
    agents: deps.agent,
    ...(deps.dutyLease ? { duties: deps.dutyLease } : {}),
    now: new Date(deps.clock.now())
  })
  return deps.integration.activeForAgents(agents.map((agent) => agent.id))
}

export const handleIntegrationChannels: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/channels')(frame)) return
  const p = frame.payload
  const owned = await activeForServedAgents(DaemonId(conn.daemonId), deps)
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
  // Read after the lease releases, to decide whether the report opened anything (§14.8).
  let owner: AgentRecord | null = null
  let seeded: ReadonlyMap<string, ChannelTrigger> | undefined
  try {
    // Ownership may have changed while the first repository read was in flight.
    // Re-check under the shared mutation lease before accepting this daemon's
    // latest-wins snapshot, otherwise a late source event can overwrite target
    // channel metadata after a cold move.
    const current = await activeForServedAgents(DaemonId(conn.daemonId), deps)
    if (!current.some((candidate) => candidate.id === integration.id && candidate.agentId === integration.agentId)) {
      return
    }
    // Conversation gating (resource-visibility.md §14): a gated (restricted-agent)
    // integration's fresh conversations start Off — an editor must enable them in
    // the console — unless the platform's install already granted them (§5). Known
    // rows keep their operator-chosen trigger either way.
    // Fenced on the org of the integration row this daemon just proved it owns.
    owner = await deps.agent.get(OrgId(integration.orgId), AgentId(integration.agentId))
    const defaultTrigger = owner && gatesNewConversations(integration.platform, owner) ? ('off' as const) : undefined
    // §14.8: a gated DM whose counterpart is already in the agent's audience seeds to
    // the ordinary DM default instead. Only the gated arm asks — a public install has
    // no Off to override — and a resolver that answers nothing leaves §14.2 intact.
    const bot = defaultTrigger && deps.bot ? await deps.bot.get(OrgId(integration.orgId), integration.botId) : null
    seeded = owner && bot && deps.gatedDmSeeds ? await deps.gatedDmSeeds(p.channels, owner, bot) : undefined
    await deps.integrationChannel.replaceSnapshot(
      integration.id,
      p.channels,
      defaultTrigger || p.authoritative === false || p.removed?.length
        ? {
            ...(defaultTrigger ? { defaultTrigger } : {}),
            ...(seeded?.size ? { defaultTriggerByChannel: seeded } : {}),
            ...(p.authoritative === false ? { authoritative: false } : {}),
            ...(p.removed?.length ? { removed: p.removed } : {})
          }
        : undefined
    )
  } finally {
    release()
  }

  // §14.8 is the one path where a REPORT can create an ENABLED row, so it is also the
  // only one that has to push: the reporting daemon still holds bindRules assembled
  // before this write, and it has already cached the conversation, so no later message
  // re-reports and repairs it. Outside the mutation lease and best-effort — the
  // register snapshot remains the durable backstop.
  if (seeded?.size && owner && deps.integrationConverge) {
    try {
      await deps.integrationConverge(owner)
    } catch {
      // The daemon converges on its next register snapshot.
    }
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
