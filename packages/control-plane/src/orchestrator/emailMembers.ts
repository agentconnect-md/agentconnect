// Which addresses may write to an agent by mail (email-integration.md §4 step 3, §4.1): its members, and under Anyone the senders no member holds.
import { EMAIL_PLATFORM, type AgentEmailMembers, type AgentEmailMembersOk } from '@agentconnect.md/protocol'
import type { AgentRepo, BotRepo, IntegrationRepo, UserRepo } from '../persistence/ports.js'
import { AgentId, BotId } from '../domain/ids.js'
import { canView } from '../authorization/policy.js'
import { emailAddressSettings, emailOutsideSessionOwner } from '../platforms/email/settings.js'

export interface EmailMembersDeps {
  agent: Pick<AgentRepo, 'getUnscoped'>
  integration: Pick<IntegrationRepo, 'activeForAgents'>
  bot: Pick<BotRepo, 'getUnscoped'>
  users: Pick<UserRepo, 'verifiedEmailHolders' | 'activeMember'>
}

/** The seam the WS handler holds. */
export type EmailMembersResolver = (req: AgentEmailMembers, expectedOrgId?: string) => Promise<AgentEmailMembersOk>

const nobody: AgentEmailMembersOk = { members: [], outsiders: [], outsideSenders: 'refused' }

export async function resolveEmailMembers(
  req: AgentEmailMembers,
  deps: EmailMembersDeps,
  expectedOrgId?: string
): Promise<AgentEmailMembersOk> {
  const agent = await deps.agent.getUnscoped(AgentId(req.agentId))
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId)) return nobody
  // Only an agent that has an address is asked about: no other agent's daemon learns who an address belongs to.
  const install = (await deps.integration.activeForAgents([req.agentId])).find(
    (candidate) => candidate.platform === EMAIL_PLATFORM
  )
  const bot = install ? await deps.bot.getUnscoped(BotId(install.botId)) : null
  if (!install || !bot) return nobody
  const settings = emailAddressSettings(bot, install)
  const anyone = settings.whoMayWrite === 'anyone'
  const members: AgentEmailMembersOk['members'] = []
  const outsiders: string[] = []
  for (const address of new Set(req.addresses)) {
    const holders = await deps.users.verifiedEmailHolders(agent.orgId, address)
    if (holders.length === 0) outsiders.push(address)
    // Under Anyone the agent's list gates no mail, so a member is recognized as one; two holders name neither of them.
    else if (holders.length === 1 && (anyone || canView(agent, holders[0]!)))
      members.push({ address, consoleUserId: holders[0]!.userId })
  }
  // A departed member's choice never becomes the organization's: with nowhere to go, outsiders are refused (§4.1).
  const owner = anyone ? await emailOutsideSessionOwner(agent.orgId, settings, deps.users) : null
  return { members, outsiders, outsideSenders: owner ? 'admitted' : 'refused' }
}
