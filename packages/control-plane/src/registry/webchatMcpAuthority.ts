import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { AgentId, OrgId } from '../domain/ids.js'
import { canView } from '../domain/visibility.js'
import type { AgentRepo, OrgRepo, PresetAgentStore, WebchatConversationRepo } from '../persistence/ports.js'

export type WebchatMcpAuthorityDenialReason =
  | 'conversation_binding'
  | 'membership_missing'
  | 'agent_not_visible'
  | 'preset_mismatch'
  | 'placement_mismatch'
  | 'daemon_unavailable'
  | 'daemon_feature_missing'

interface LiveDaemon {
  reachable: boolean
  state: string
  capabilities?: { features?: string[] }
}

export interface LiveWebchatMcpAuthorityDeps {
  conversations: Pick<WebchatConversationRepo, 'findOwner' | 'owns'>
  orgs: Pick<OrgRepo, 'roleOf'>
  agents: Pick<AgentRepo, 'get'>
  presets: Pick<PresetAgentStore, 'get'>
  daemons: { get(daemonId: string): LiveDaemon | undefined }
}

export type LiveWebchatMcpAuthorityResult =
  { ok: true; userId: string } | { ok: false; reason: WebchatMcpAuthorityDenialReason }

/** Shared live-fact policy used both when minting and when consuming an assertion. */
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

  const role = await deps.orgs.roleOf(input.orgId, owner)
  if (!role) return { ok: false, reason: 'membership_missing' }

  const agent = await deps.agents.get(AgentId(input.agentId))
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
  if (!daemon.capabilities?.features?.includes(DELEGATED_MCP_ASSERTION_FEATURE)) {
    return { ok: false, reason: 'daemon_feature_missing' }
  }
  return { ok: true, userId: owner }
}
