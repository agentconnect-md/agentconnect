import { WEBCHAT_REMOTE_MCP_FEATURE } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import { canView } from '../authorization/policy.js'
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
}

export type LiveWebchatMcpAuthorityResult =
  { ok: true; userId: string } | { ok: false; reason: WebchatMcpAuthorityDenialReason }

/** Shared live-fact policy used both when issuing and when consuming a remote-MCP grant. */
export async function resolveLiveWebchatMcpAuthority(
  deps: LiveWebchatMcpAuthorityDeps,
  input: {
    conversationId: string
    expectedUserId: string
    orgId: string
    agentId: string
    daemonId: string
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
  const roster = await deps.conversations.participants(input.conversationId)
  if (roster.length > 1) return { ok: false, reason: 'multi_agent_conversation' }

  const role = await deps.orgs.roleOf(input.orgId, owner)
  if (!role) return { ok: false, reason: 'membership_missing' }

  const agent = await deps.agents.getUnscoped(AgentId(input.agentId))
  if (!agent || agent.id !== input.agentId || agent.orgId !== input.orgId || !canView(agent, { userId: owner, role })) {
    return { ok: false, reason: 'agent_not_visible' }
  }

  const preset = await deps.presets.get(OrgId(input.orgId), 'general')
  if (preset?.agentId !== input.agentId) return { ok: false, reason: 'preset_mismatch' }
  if (!agent.daemonId || agent.daemonId !== input.daemonId) {
    return { ok: false, reason: 'placement_mismatch' }
  }

  const daemon = deps.daemons.get(input.daemonId)
  if (!daemon?.reachable || daemon.state !== 'READY') {
    return { ok: false, reason: 'daemon_unavailable' }
  }
  if (!daemon.capabilities?.features?.includes(WEBCHAT_REMOTE_MCP_FEATURE)) {
    return { ok: false, reason: 'daemon_feature_missing' }
  }
  return { ok: true, userId: owner }
}
