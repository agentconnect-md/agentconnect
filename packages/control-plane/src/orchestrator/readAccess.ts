// The console's own session visibility for whoever asks an agent a cross-platform read, and a console user's linked chat identity (assistant-mode.md §5.5).
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
  // Asked with `linkedOn`, every answer says which chat identity the asker's console user linked in that bot's workspace.
  const noLink = req.linkedOn ? { linkedMemberId: null } : {}
  const agent = await deps.agent.getUnscoped(AgentId(req.agentId))
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId)) return { ...unidentifiable, ...noLink }
  const viewer = await viewerOf(req, agent.orgId, deps)
  if (viewer === 'unlinked' || viewer === 'unidentifiable') return { asker: viewer, visibleSessionIds: [], ...noLink }
  const visibleSessionIds = req.sessionIds.length
    ? await deps.sessionsVisible(viewer, req.agentId, req.sessionIds, req.ownerOnly === true)
    : []
  const linked = req.linkedOn
    ? { linkedMemberId: await linkedMemberOn(req.agentId, req.linkedOn, viewer.userId, deps) }
    : {}
  return { asker: 'linked', visibleSessionIds, consoleUserId: viewer.userId, ...linked }
}

/** The agent's bot and the tenant its chat members are matched under (Slack's workspace, Feishu/Lark's region), or null. */
async function botTenant(
  agentId: string,
  integrationId: string,
  deps: ReadAccessDeps
): Promise<{ platform: string; tenant: string } | null> {
  const integration = (await deps.integration.activeForAgents([agentId])).find((i) => String(i.id) === integrationId)
  const tenantOf = integration ? deps.platforms.get(integration.platform)?.chatMemberTenant : undefined
  if (!integration || !tenantOf) return null
  const bot = await deps.bot.get(OrgId(integration.orgId), integration.botId)
  const tenant = bot ? tenantOf(bot) : null
  return tenant ? { platform: integration.platform, tenant } : null
}

/** The member id this console user linked in that bot's tenant, null for none; two there cannot be told apart, so it throws. */
async function linkedMemberOn(
  agentId: string,
  integrationId: string,
  userId: string,
  deps: ReadAccessDeps
): Promise<string | null> {
  const identity = deps.identity
  const on = identity ? await botTenant(agentId, integrationId, deps) : null
  const sub = identity && on ? await deps.users.getOidcSubject(userId) : null
  if (!identity || !on || !sub) return null
  const ids = new Set(
    (await identity.chatIdentitiesFor(sub))
      .filter((l) => l.platform === on.platform && l.tenant === on.tenant)
      .map((l) => l.memberId)
  )
  if (ids.size > 1) throw new Error('several linked chat identities in one workspace')
  return [...ids][0] ?? null
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
  const identity = deps.identity
  const on = identity ? await botTenant(req.agentId, integrationId, deps) : null
  if (!identity || !on) return 'unidentifiable'
  const members = await deps.users.listMembers(orgId)
  // An audience past the cap cannot be scanned, so nobody is told they are unlinked when they may not be.
  if (members.length > MAX_AUDIENCE) throw new Error('organization too large to resolve a linked identity')
  const linked = await mapLimited(members, AUDIENCE_CONCURRENCY, async (member) => {
    const sub = await deps.users.getOidcSubject(member.userId)
    const ids = sub ? await identity.chatIdentitiesFor(sub) : []
    return ids.some((l) => l.platform === on.platform && l.tenant === on.tenant && l.memberId === memberId)
      ? member
      : null
  })
  const matches = linked.filter((m) => m !== null)
  if (matches.length === 0) return 'unlinked'
  const [only] = matches
  return matches.length === 1 && only ? { orgId, userId: only.userId, role: only.role } : 'unidentifiable'
}
