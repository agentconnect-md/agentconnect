// Pick one approval recipient by preference, or revalidate their authority (edit, or a Computer's membership) and linked chat identity.
import type { AgentApprovalRoute, AgentApprovalRouted, ApprovalRouteTarget } from '@agentconnect.md/protocol'
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type {
  AgentRepo,
  BotRecord,
  BotRepo,
  ComputerRepo,
  IntegrationRecord,
  IntegrationRepo,
  OrgMemberRecord,
  SessionRepo,
  UserRepo
} from '../persistence/ports.js'
import { AgentId, ComputerId, OrgId, SessionId } from '../domain/ids.js'
import { withOwnerMember } from '../domain/computer.js'
import { AUDIENCE_CONCURRENCY, MAX_AUDIENCE, mapLimited } from './linkedDm.js'
import { canEdit } from '../authorization/policy.js'
import { assistantResponsibleUser } from '../agents/assistant-mode.js'

export interface ApprovalRouteDeps {
  agent: Pick<AgentRepo, 'getUnscoped'>
  session: Pick<SessionRepo, 'getUnscoped'>
  integration: Pick<IntegrationRepo, 'activeForAgents'>
  bot: Pick<BotRepo, 'get'>
  users: Pick<UserRepo, 'listMembers' | 'getOidcSubject'>
  /** A computer-use approval's Computer, whose allowed members stand in for the agent's editors (computer-use.md §4.2). */
  computer?: Pick<ComputerRepo, 'getUnscoped'>
  /** Each platform's provider says whether, and under which tenant, its chat members can be matched (`chatMemberTenant`). */
  platforms: Pick<CpPlatformRegistry, 'get'>
  /** Absent when the deployment has no sign-in configured — then nothing is linked. */
  identity?: { chatIdentitiesFor(sub: string): Promise<LinkedChatIdentity[]> }
  log?: { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void }
}

/** How one platform's chat members are matched: the bot's tenant, and the member ids a console user linked under it. */
interface ChatMemberMatcher {
  tenantOf(bot: BotRecord): string | null
  linkedIds(sub: string, tenant: string): Promise<string[]>
}

/** The seam the WS handler holds; the composition root knows it is Logto-backed. */
export type ApprovalRouteResolver = (req: AgentApprovalRoute, expectedOrgId?: string) => Promise<AgentApprovalRouted>

export async function resolveApprovalRoute(
  req: AgentApprovalRoute,
  deps: ApprovalRouteDeps,
  expectedOrgId?: string
): Promise<AgentApprovalRouted> {
  const none: AgentApprovalRouted = req.verify
    ? { requestId: req.requestId, allowed: false }
    : { requestId: req.requestId }
  const agent = await deps.agent.getUnscoped(AgentId(req.agentId))
  const identity = deps.identity
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId) || !identity) return none

  // The agent's integrations whose chat members can be matched to console accounts, each with how its platform does it.
  const owned = await deps.integration.activeForAgents([req.agentId])
  const matchable = new Map<string, { integration: IntegrationRecord; matcher: ChatMemberMatcher }>()
  for (const integration of owned) {
    const tenantOf = deps.platforms.get(integration.platform)?.chatMemberTenant
    if (!tenantOf) continue
    const matcher: ChatMemberMatcher = {
      tenantOf,
      linkedIds: async (sub, tenant) =>
        (await identity.chatIdentitiesFor(sub))
          .filter((linked) => linked.platform === integration.platform && linked.tenant === tenant)
          .map((linked) => linked.memberId)
    }
    matchable.set(String(integration.id), { integration, matcher })
  }
  if (matchable.size === 0) return none

  const members = await deps.users.listMembers(agent.orgId)
  // A computer-use approval's authority is the Computer's allowed members, else the agent's editors, organization owners included.
  let editors: OrgMemberRecord[]
  if (req.computerId) {
    const computer = await deps.computer?.getUnscoped(ComputerId(req.computerId))
    if (!computer || computer.orgId !== agent.orgId || computer.revokedAt) return none
    const allowed = new Set(withOwnerMember(computer.policy, computer.ownerUserId).allowedMembers)
    editors = members.filter((member) => allowed.has(member.userId))
  } else editors = members.filter((member) => canEdit(agent, member))
  if (editors.length === 0) return none

  // The integration's tenant anchor (Slack's workspace, Feishu/Lark's region), as its platform reads it off the bot.
  const tenantFor = async (integrationId: string): Promise<string | null> => {
    const owned = matchable.get(integrationId)
    if (!owned) return null
    const bot = await deps.bot.get(OrgId(owned.integration.orgId), owned.integration.botId)
    return bot ? owned.matcher.tenantOf(bot) : null
  }
  // One member's lookup failing costs that member a match, never the whole answer.
  const idsOf = async (userId: string, matcher: ChatMemberMatcher, tenant: string): Promise<string[]> => {
    try {
      const sub = await deps.users.getOidcSubject(userId)
      return sub ? await matcher.linkedIds(sub, tenant) : []
    } catch (err) {
      deps.log?.warn({ err, userId }, 'approval route: linked-identity lookup failed — treating as unlinked')
      return []
    }
  }

  // A chat member on a synced integration (chat-actor-v1): an editor linked to them, else whether any member is; over the cap refuses.
  const verifyChatActor = async (
    requestId: string,
    userId: string,
    matcher: ChatMemberMatcher,
    tenant: string
  ): Promise<AgentApprovalRouted> => {
    if (editors.length > MAX_AUDIENCE) return none
    const scanned = members.length <= MAX_AUDIENCE ? members : editors
    const matches = await mapLimited(scanned, AUDIENCE_CONCURRENCY, async (m) =>
      (await idsOf(m.userId, matcher, tenant)).includes(userId) ? m : null
    )
    const linked = matches.filter((m): m is OrgMemberRecord => m !== null)
    const editor = linked.find((m) => editors.includes(m))
    if (editor) return { requestId, allowed: true, ...(editor.displayName ? { displayName: editor.displayName } : {}) }
    return { requestId, allowed: false, ...(scanned === members ? { linked: linked.length > 0 } : {}) }
  }

  if (req.verify) {
    const v = req.verify
    const tenant = await tenantFor(v.integrationId)
    const matcher = matchable.get(v.integrationId)?.matcher
    if (!tenant || !matcher || (v.teamId !== undefined && tenant !== v.teamId)) return none
    if (v.consoleUserId === undefined) return await verifyChatActor(req.requestId, v.userId, matcher, tenant)
    if (v.teamId === undefined) return none
    // Recheck current membership and edit authority before verifying the linked actor pair.
    const member = editors.find((m) => m.userId === v.consoleUserId)
    if (!member) return none
    const allowed = (await idsOf(member.userId, matcher, tenant)).includes(v.userId)
    return {
      requestId: req.requestId,
      allowed,
      ...(allowed && member.displayName ? { displayName: member.displayName } : {})
    }
  }

  // One named console user or the derived responsible user, never the chain: linked to one of the given tenants, or nobody.
  if (req.consoleUserId || req.responsible) {
    const member = req.consoleUserId
      ? editors.find((m) => m.userId === req.consoleUserId)
      : assistantResponsibleUser(agent, editors)
    if (!member) return none
    for (const integrationId of req.integrationIds) {
      const tenant = await tenantFor(integrationId)
      const matcher = matchable.get(integrationId)?.matcher
      if (!tenant || !matcher) continue
      const [uid] = await idsOf(member.userId, matcher, tenant)
      if (uid) {
        const target: ApprovalRouteTarget = {
          integrationId,
          teamId: tenant,
          userId: uid,
          consoleUserId: member.userId,
          ...(member.displayName ? { displayName: member.displayName } : {})
        }
        return { requestId: req.requestId, target }
      }
    }
    return none
  }

  const session = req.sessionId ? await deps.session.getUnscoped(SessionId(req.sessionId)) : null
  const ownerIdentity = session && session.agentId === req.agentId ? session.ownerIdentity : null
  const capped = editors.length > MAX_AUDIENCE
  if (capped) {
    deps.log?.debug({ editors: editors.length }, 'approval route: editor set over cap — member-id rungs skipped')
  }
  // Rung 5's order: owners first, then by join date and user id, so retries pick the same person; capped, owners only.
  const fallbackOrder = editors
    .filter((m) => !capped || m.role === 'owner')
    .sort(
      (a, b) =>
        Number(b.role === 'owner') - Number(a.role === 'owner') ||
        a.joinedAt.getTime() - b.joinedAt.getTime() ||
        (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
    )
  const fallbacks: Array<() => Promise<AgentApprovalRouted | null>> = []

  for (const integrationId of req.integrationIds) {
    const teamId = await tenantFor(integrationId)
    const matcher = matchable.get(integrationId)?.matcher
    if (!teamId || !matcher) continue
    const firstId = async (m: OrgMemberRecord): Promise<string | null> =>
      (await idsOf(m.userId, matcher, teamId))[0] ?? null
    // The one forward scan (§3): editors linked to THIS tenant, both directions.
    let byMemberId: Map<string, OrgMemberRecord> | null = null
    let idByConsole: Map<string, string> | null = null
    if (!capped) {
      const linked = await mapLimited(editors, AUDIENCE_CONCURRENCY, async (m) => {
        const uid = await firstId(m)
        return uid ? ([uid, m] as const) : null
      })
      byMemberId = new Map(linked.filter((entry): entry is readonly [string, OrgMemberRecord] => entry !== null))
      idByConsole = new Map([...byMemberId].map(([uid, m]) => [m.userId, uid]))
    }
    const hit = (member: OrgMemberRecord, uid: string): AgentApprovalRouted => {
      const target: ApprovalRouteTarget = {
        integrationId,
        teamId,
        userId: uid,
        consoleUserId: member.userId,
        ...(member.displayName ? { displayName: member.displayName } : {})
      }
      return { requestId: req.requestId, target }
    }
    // Console-user rungs run even capped: resolve that one member's link directly.
    const singleLookup = async (member: OrgMemberRecord): Promise<AgentApprovalRouted | null> => {
      const uid = idByConsole ? (idByConsole.get(member.userId) ?? null) : await firstId(member)
      return uid ? hit(member, uid) : null
    }

    // Rung 1 — conversation turn owner (a chat member id; needs the scan).
    const turnOwner = req.requesterId ? byMemberId?.get(req.requesterId) : undefined
    if (turnOwner && req.requesterId) return hit(turnOwner, req.requesterId)
    // Rung 2 — session owner: `user:<id>` is a console user, `slack:T:U` needs the scan.
    if (ownerIdentity) {
      const parts = ownerIdentity.split(':')
      if (parts.length === 2 && parts[0] === 'user') {
        const member = editors.find((m) => m.userId === parts[1])
        const routed = member ? await singleLookup(member) : null
        if (routed) return routed
      } else if (parts.length === 3 && parts[0] === 'slack' && parts[1] === teamId) {
        const member = byMemberId?.get(parts[2]!)
        if (member) return hit(member, parts[2]!)
      }
    }
    // Rung 3 — restricted audience, in sharedWith order (stable tie-break).
    if (agent.visibility === 'restricted' && idByConsole && byMemberId) {
      for (const userId of agent.sharedWith) {
        const uid = idByConsole.get(userId)
        if (uid) return hit(byMemberId.get(uid)!, uid)
      }
    }
    // Rung 4 — agent creator (a console user; no implicit rights, must be an editor).
    if (agent.createdByUserId) {
      const member = editors.find((m) => m.userId === agent.createdByUserId)
      const routed = member ? await singleLookup(member) : null
      if (routed) return routed
    }
    fallbacks.push(async () => {
      for (const member of fallbackOrder) {
        const routed = await singleLookup(member)
        if (routed) return routed
      }
      return null
    })
  }
  // Rung 5 — when no integration's rungs 1–4 hit: one editor linked there, in the order offered.
  for (const fallback of fallbacks) {
    const routed = await fallback()
    if (routed) return routed
  }
  return none
}
