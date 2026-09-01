/**
 * slack-approval-dm.md §3–§4 — pick, or revalidate, the one human a pending
 * approval DMs.
 *
 * Both forms of `agent/approval-route` land here. The ROUTE form walks the §3
 * preference chain — turn owner → session owner → restricted audience →
 * creator — once per candidate Slack workspace, in the daemon's order, and
 * answers with the first hit; every rung must name a console user who can
 * edit the agent (§2's authority gate) AND whose Logto-linked Slack identity
 * lives in that workspace (the identity gate). The VERIFY form re-asks both
 * gates for one `(consoleUserId, teamId, userId)` binding at click time.
 *
 * There is deliberately no reverse Slack→console index (slack-identity.md),
 * so Slack-id rungs resolve by the same forward scan linkedDm.ts uses,
 * bounded by MAX_AUDIENCE over the eligible-editor set; past the cap those
 * rungs are skipped fail-closed while console-user rungs (a `user:<id>`
 * session owner, the creator) stay single lookups. Everything here fails
 * CLOSED to "no DM" / "click refused" — no sign-in configured, an upstream
 * that cannot answer, an unknown agent, a workspace mismatch.
 */
import type { AgentApprovalRoute, AgentApprovalRouted, ApprovalRouteTarget } from '@agentconnect.md/protocol'
import type { SlackIdentity } from '../github/logto-identity.js'
import type {
  AgentRepo,
  BotRepo,
  IntegrationRepo,
  OrgMemberRecord,
  SessionRepo,
  UserRepo
} from '../persistence/ports.js'
import { AgentId, OrgId, SessionId } from '../domain/ids.js'
import { AUDIENCE_CONCURRENCY, MAX_AUDIENCE, mapLimited } from './linkedDm.js'

export interface ApprovalRouteDeps {
  agent: Pick<AgentRepo, 'getUnscoped'>
  session: Pick<SessionRepo, 'getUnscoped'>
  integration: Pick<IntegrationRepo, 'activeForAgents'>
  bot: Pick<BotRepo, 'get'>
  users: Pick<UserRepo, 'listMembers' | 'getOidcSubject'>
  /** Absent when the deployment has no sign-in configured — then nothing is linked. */
  identity?: { slackIdentityFor(sub: string): Promise<SlackIdentity | null> }
  log?: { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void }
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
  if (!agent || (expectedOrgId && agent.orgId !== expectedOrgId) || !deps.identity) return none

  const members = await deps.users.listMembers(agent.orgId)
  // The eligible-editor set: canEdit(agent) inlined — non-viewer role plus visibility.
  const editors = members.filter(
    (m) => m.role !== 'viewer' && (agent.visibility === 'org' || agent.sharedWith.includes(m.userId))
  )
  if (editors.length === 0) return none

  const owned = await deps.integration.activeForAgents([req.agentId])
  const slackOwned = new Map(owned.filter((i) => i.platform === 'slack').map((i) => [String(i.id), i]))
  // The integration's workspace anchor. `teamId` is written by platform-app installs only;
  // a token-installed (direct) bot carries the same fact as `workspaceId`, reported by the
  // owning daemon's auth.test — the provenance `ownerIdentity`'s transportScope already has,
  // and session visibility already matches on. A revoked bot's workspace asserts nothing.
  const workspaceFor = async (integrationId: string): Promise<string | null> => {
    const integration = slackOwned.get(integrationId)
    if (!integration) return null
    const bot = await deps.bot.get(OrgId(integration.orgId), integration.botId)
    if (!bot || bot.revokedAt) return null
    return bot.teamId ?? bot.workspaceId ?? null
  }
  // One member's lookup failing costs that member a match, never the whole answer.
  const pairOf = async (userId: string): Promise<SlackIdentity | null> => {
    try {
      const sub = await deps.users.getOidcSubject(userId)
      return sub ? await deps.identity!.slackIdentityFor(sub) : null
    } catch (err) {
      deps.log?.warn({ err, userId }, 'approval route: linked-identity lookup failed — treating as unlinked')
      return null
    }
  }

  if (req.verify) {
    const v = req.verify
    const workspace = await workspaceFor(v.integrationId)
    if (!workspace || workspace !== v.teamId) return none
    // Membership + role + visibility re-checked live: left org / demoted / unshared all refuse.
    const member = editors.find((m) => m.userId === v.consoleUserId)
    if (!member) return none
    const pair = await pairOf(member.userId)
    const allowed = pair !== null && pair.teamId === v.teamId && pair.userId === v.userId
    return {
      requestId: req.requestId,
      allowed,
      ...(allowed && member.displayName ? { displayName: member.displayName } : {})
    }
  }

  const session = req.sessionId ? await deps.session.getUnscoped(SessionId(req.sessionId)) : null
  const ownerIdentity = session && session.agentId === req.agentId ? session.ownerIdentity : null
  const capped = editors.length > MAX_AUDIENCE
  if (capped) {
    deps.log?.debug({ editors: editors.length }, 'approval route: editor set over cap — Slack-id rungs skipped')
  }

  for (const integrationId of req.integrationIds) {
    const teamId = await workspaceFor(integrationId)
    if (!teamId) continue
    // The one forward scan (§3): editors linked to THIS workspace, both directions.
    let bySlackUid: Map<string, OrgMemberRecord> | null = null
    let uidByConsole: Map<string, string> | null = null
    if (!capped) {
      const linked = await mapLimited(editors, AUDIENCE_CONCURRENCY, async (m) => {
        const pair = await pairOf(m.userId)
        return pair && pair.teamId === teamId ? ([pair.userId, m] as const) : null
      })
      bySlackUid = new Map(linked.filter((entry): entry is readonly [string, OrgMemberRecord] => entry !== null))
      uidByConsole = new Map([...bySlackUid].map(([uid, m]) => [m.userId, uid]))
    }
    const hit = (member: OrgMemberRecord, slackUid: string): AgentApprovalRouted => {
      const target: ApprovalRouteTarget = {
        integrationId,
        teamId,
        userId: slackUid,
        consoleUserId: member.userId,
        ...(member.displayName ? { displayName: member.displayName } : {})
      }
      return { requestId: req.requestId, target }
    }
    // Console-user rungs run even capped: resolve that one member's link directly.
    const singleLookup = async (member: OrgMemberRecord): Promise<AgentApprovalRouted | null> => {
      const uid = uidByConsole
        ? (uidByConsole.get(member.userId) ?? null)
        : await pairOf(member.userId).then((p) => (p && p.teamId === teamId ? p.userId : null))
      return uid ? hit(member, uid) : null
    }

    // Rung 1 — conversation turn owner (a Slack member id; needs the scan).
    const turnOwner = req.requesterId ? bySlackUid?.get(req.requesterId) : undefined
    if (turnOwner && req.requesterId) return hit(turnOwner, req.requesterId)
    // Rung 2 — session owner: `user:<id>` is a console user, `slack:T:U` needs the scan.
    if (ownerIdentity) {
      const parts = ownerIdentity.split(':')
      if (parts.length === 2 && parts[0] === 'user') {
        const member = editors.find((m) => m.userId === parts[1])
        const routed = member ? await singleLookup(member) : null
        if (routed) return routed
      } else if (parts.length === 3 && parts[0] === 'slack' && parts[1] === teamId) {
        const member = bySlackUid?.get(parts[2]!)
        if (member) return hit(member, parts[2]!)
      }
    }
    // Rung 3 — restricted audience, in sharedWith order (stable tie-break).
    if (agent.visibility === 'restricted' && uidByConsole && bySlackUid) {
      for (const userId of agent.sharedWith) {
        const uid = uidByConsole.get(userId)
        if (uid) return hit(bySlackUid.get(uid)!, uid)
      }
    }
    // Rung 4 — agent creator (a console user; no implicit rights, must be an editor).
    if (agent.createdByUserId) {
      const member = editors.find((m) => m.userId === agent.createdByUserId)
      const routed = member ? await singleLookup(member) : null
      if (routed) return routed
    }
  }
  return none
}
