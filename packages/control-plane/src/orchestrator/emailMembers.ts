// Which addresses are members who may write to an agent by mail (email-integration.md §4 step 3): a verified sign-in email of the agent's organization that the agent's visibility admits.
import { EMAIL_PLATFORM, type AgentEmailMembers, type AgentEmailMembersOk } from '@agentconnect.md/protocol'
import type { AgentRepo, IntegrationRepo, UserRepo } from '../persistence/ports.js'
import { AgentId } from '../domain/ids.js'
import { canView } from '../authorization/policy.js'

export interface EmailMembersDeps {
  agent: Pick<AgentRepo, 'getUnscoped'>
  integration: Pick<IntegrationRepo, 'activeForAgents'>
  users: Pick<UserRepo, 'memberByVerifiedEmail'>
}

/** The seam the WS handler holds. */
export type EmailMembersResolver = (req: AgentEmailMembers, expectedOrgId?: string) => Promise<AgentEmailMembersOk>

const nobody: AgentEmailMembersOk = { members: [] }

export async function resolveEmailMembers(
  req: AgentEmailMembers,
  deps: EmailMembersDeps,
  expectedOrgId?: string
): Promise<AgentEmailMembersOk> {
  const agent = await deps.agent.getUnscoped(AgentId(req.agentId))
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId)) return nobody
  // Only an agent that has an address is asked about: no other agent's daemon learns who an address belongs to.
  const installs = await deps.integration.activeForAgents([req.agentId])
  if (!installs.some((install) => install.platform === EMAIL_PLATFORM)) return nobody
  const members: AgentEmailMembersOk['members'] = []
  for (const address of new Set(req.addresses)) {
    const member = await deps.users.memberByVerifiedEmail(agent.orgId, address)
    // Unknown, another organization's, unverified and not on the agent's list all read the same: left out.
    if (member && canView(agent, member)) members.push({ address, consoleUserId: member.userId })
  }
  return { members }
}
