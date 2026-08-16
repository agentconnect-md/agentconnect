import { WEBCHAT_REMOTE_MCP_FEATURE } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import { canView } from '../authorization/policy.js'
import type { PlacementRef } from '../domain/placement.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type { AgentRepo, OrgRepo, PresetAgentStore, WebchatConversationRepo } from '../persistence/ports.js'

export type WebchatMcpAuthorityDenialReason =
  | 'conversation_binding'
  | 'membership_missing'
  | 'agent_not_visible'
  | 'preset_mismatch'
  | 'placement_mismatch'
  | 'daemon_unavailable'
  | 'daemon_feature_missing'
  | 'multi_agent_conversation'

interface LiveDaemon {
  reachable: boolean
  state: string
  capabilities?: { features?: string[] }
}

export interface LiveWebchatMcpAuthorityDeps {
  conversations: Pick<WebchatConversationRepo, 'findOwner' | 'owns' | 'participants'>
  orgs: Pick<OrgRepo, 'roleOf'>
  agents: Pick<AgentRepo, 'getUnscoped'>
  presets: Pick<PresetAgentStore, 'get'>
  daemons: { get(daemonId: string): LiveDaemon | undefined }
  /** The only answer to "which daemons serve this agent" / "may this one act for it". */
  placement: Pick<PlacementResolver, 'mayAct' | 'servingDaemons'>
}

export type LiveWebchatMcpAuthorityResult =
  | { ok: true; userId: string; daemonId: string; placement: PlacementRef }
  | { ok: false; reason: WebchatMcpAuthorityDenialReason }

/** Shared live-fact policy used both when issuing and when consuming a remote-MCP grant. */
export async function resolveLiveWebchatMcpAuthority(
  deps: LiveWebchatMcpAuthorityDeps,
  input: {
    conversationId: string
    expectedUserId: string
    orgId: string
    agentId: string
    /** The daemon asking to act. Absent where the caller carries no daemon identity (a grant
     *  redeemed over HTTP), and then any serving daemon satisfies the live check. */
    actingDaemonId?: string
  }
): Promise<LiveWebchatMcpAuthorityResult> {
  const owner = await deps.conversations.findOwner(input.conversationId, AgentId(input.agentId))
  if (
    owner === null ||
    owner !== input.expectedUserId ||
    !(await deps.conversations.owns({
      conversationId: input.conversationId,
      userId: owner,
      orgId: OrgId(input.orgId),
      agentId: AgentId(input.agentId)
    }))
  ) {
    return { ok: false, reason: 'conversation_binding' }
  }

  // Delegated administration is a single-participant privilege
  // (webchat-multi-agents.md §10.3). Checked LIVE — a participant added
  // mid-conversation suspends the catalog on the very next request, without
  // waiting for grant expiry. An empty roster is a pre-backfill conversation
  // and stays admissible (the single-agent shape).
  const roster = await deps.conversations.participants(OrgId(input.orgId), input.conversationId)
  if (roster.length > 1) return { ok: false, reason: 'multi_agent_conversation' }

  const role = await deps.orgs.roleOf(input.orgId, owner)
  if (!role) return { ok: false, reason: 'membership_missing' }

  const agent = await deps.agents.getUnscoped(AgentId(input.agentId))
  if (!agent || agent.id !== input.agentId || agent.orgId !== input.orgId || !canView(agent, { userId: owner, role })) {
    return { ok: false, reason: 'agent_not_visible' }
  }

  const preset = await deps.presets.get(OrgId(input.orgId), 'general')
  if (preset?.agentId !== input.agentId) return { ok: false, reason: 'preset_mismatch' }

  // Placement is the resolver's answer, never the column: a pool agent names no machine, and the
  // member serving it is whoever holds its duty at this moment.
  const candidates = input.actingDaemonId
    ? (await deps.placement.mayAct(agent, input.actingDaemonId))
      ? [input.actingDaemonId]
      : []
    : await deps.placement.servingDaemons(agent)
  if (candidates.length === 0) return { ok: false, reason: 'placement_mismatch' }

  const live = candidates
    .map((daemonId) => ({ daemonId, daemon: deps.daemons.get(daemonId) }))
    .filter(({ daemon }) => daemon?.reachable && daemon.state === 'READY')
  if (live.length === 0) return { ok: false, reason: 'daemon_unavailable' }
  const featured = live.find(({ daemon }) => daemon!.capabilities?.features?.includes(WEBCHAT_REMOTE_MCP_FEATURE))
  if (!featured) return { ok: false, reason: 'daemon_feature_missing' }
  return { ok: true, userId: owner, daemonId: featured.daemonId, placement: agent }
}
