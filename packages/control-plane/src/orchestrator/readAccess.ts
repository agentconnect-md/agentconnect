// The console's own session visibility for whoever asks an agent a cross-platform read (assistant-mode.md §5.5).
import type { AgentReadAccess, AgentReadAccessOk } from '@agentconnect.md/protocol'
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type { AgentRepo, BotRepo, IntegrationRepo, OrgMemberRole, OrgRepo, UserRepo } from '../persistence/ports.js'
import { AgentId, OrgId } from '../domain/ids.js'
import { AUDIENCE_CONCURRENCY, MAX_AUDIENCE, mapLimited } from './linkedDm.js'

/** A console user as the visibility predicate takes them. */
export interface ReadAccessViewer {
  orgId: string
  userId: string
  role: OrgMemberRole
}

export interface ReadAccessDeps {
  agent: Pick<AgentRepo, 'getUnscoped'>
  integration: Pick<IntegrationRepo, 'activeForAgents'>
  bot: Pick<BotRepo, 'get'>
  org: Pick<OrgRepo, 'roleOf'>
  users: Pick<UserRepo, 'listMembers' | 'getOidcSubject'>
  /** Each platform's provider says whether, and under which tenant, its chat members can be matched (`chatMemberTenant`). */
  platforms: Pick<CpPlatformRegistry, 'get'>
  /** Absent when the deployment has no sign-in configured — then no chat member is linked. */
  identity?: { chatIdentitiesFor(sub: string): Promise<LinkedChatIdentity[]> }
  /** The agent's sessions among `sessionIds` this viewer could see in the console; `ownerOnly` keeps only those they own. */
  sessionsVisible(
    viewer: ReadAccessViewer,
    agentId: string,
    sessionIds: readonly string[],
    ownerOnly: boolean
  ): Promise<string[]>
}

/** The seam the WS handler holds. */
export type ReadAccessResolver = (req: AgentReadAccess, expectedOrgId?: string) => Promise<AgentReadAccessOk>

const unidentifiable: AgentReadAccessOk = { asker: 'unidentifiable', visibleSessionIds: [] }

export async function resolveReadAccess(
  req: AgentReadAccess,
  deps: ReadAccessDeps,
  expectedOrgId?: string
): Promise<AgentReadAccessOk> {
  const agent = await deps.agent.getUnscoped(AgentId(req.agentId))
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId)) return unidentifiable
  const viewer = await viewerOf(req, agent.orgId, deps)
  if (viewer === 'unlinked' || viewer === 'unidentifiable') return { asker: viewer, visibleSessionIds: [] }
  const visibleSessionIds = req.sessionIds.length
    ? await deps.sessionsVisible(viewer, req.agentId, req.sessionIds, req.ownerOnly === true)
    : []
  return { asker: 'linked', visibleSessionIds, consoleUserId: viewer.userId }
}

/** The console user behind the asker: a current member named directly, or the one member who linked that chat identity. */
async function viewerOf(
  req: AgentReadAccess,
  orgId: string,
  deps: ReadAccessDeps
): Promise<ReadAccessViewer | 'unlinked' | 'unidentifiable'> {
  if ('consoleUserId' in req.asker) {
    const role = await deps.org.roleOf(orgId, req.asker.consoleUserId)
    return role ? { orgId, userId: req.asker.consoleUserId, role } : 'unidentifiable'
  }
  const { integrationId, memberId } = req.asker
  const integration = (await deps.integration.activeForAgents([req.agentId])).find(
    (i) => String(i.id) === integrationId
  )
  const tenantOf = integration ? deps.platforms.get(integration.platform)?.chatMemberTenant : undefined
  const identity = deps.identity
  if (!integration || !tenantOf || !identity) return 'unidentifiable'
  const bot = await deps.bot.get(OrgId(integration.orgId), integration.botId)
  const tenant = bot ? tenantOf(bot) : null
  if (!tenant) return 'unidentifiable'
  const members = await deps.users.listMembers(orgId)
  // An audience past the cap cannot be scanned, so nobody is told they are unlinked when they may not be.
  if (members.length > MAX_AUDIENCE) throw new Error('organization too large to resolve a linked identity')
  const linked = await mapLimited(members, AUDIENCE_CONCURRENCY, async (member) => {
    const sub = await deps.users.getOidcSubject(member.userId)
    const ids = sub ? await identity.chatIdentitiesFor(sub) : []
    return ids.some((l) => l.platform === integration.platform && l.tenant === tenant && l.memberId === memberId)
      ? member
      : null
  })
  const matches = linked.filter((m) => m !== null)
  if (matches.length === 0) return 'unlinked'
  const [only] = matches
  return matches.length === 1 && only ? { orgId, userId: only.userId, role: only.role } : 'unidentifiable'
}
