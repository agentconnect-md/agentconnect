// Who a conversation's sender is to the organization: the console member who linked that chat account, or the agent a bot speaks for.
import { LRUCache } from 'lru-cache'
import type { FastifyRequest } from 'fastify'
import { cacheOptions } from '../cache.js'
import { canView } from '../authorization/policy.js'
import type { Clock } from '../domain/clock.js'
import { AgentId, type OrgId } from '../domain/ids.js'
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import { AUDIENCE_CONCURRENCY, MAX_AUDIENCE, mapLimited } from '../orchestrator/linkedDm.js'
import type { BotRecord, IntegrationRecord, OrgMemberRecord } from '../persistence/ports.js'
import type { HttpDeps } from './deps.js'
import { ctxOf, orgOf } from './rbac.js'

/** A sender's identity in the organization; neither field when it is nobody the organization knows. */
export interface SenderIdentity {
  userId?: string
  agentId?: string
}

export interface SenderIdentityDeps {
  clock: Clock
  bots: { listForOrg(orgId: OrgId): Promise<BotRecord[]> }
  integrations: { listForOrg(orgId: OrgId): Promise<IntegrationRecord[]> }
  users: {
    listMembers(orgId: string): Promise<OrgMemberRecord[]>
    getOidcSubject(userId: string): Promise<string | null>
  }
  /** The platform's `chatMemberTenant`: the tenant a bot's chat members are matched to console accounts under. */
  chatMemberTenant(platform: string): ((bot: BotRecord) => string | null) | undefined
  /** Absent when the deployment has no sign-in configured: then nobody is linked. */
  identity?: { chatIdentitiesFor(sub: string): Promise<LinkedChatIdentity[]> }
  log?: { warn(obj: object, msg: string): void }
}

/** Who asks: their own link is read fresh on every call, so linking an account shows at once. */
export interface SenderIdentityViewer {
  userId?: string
  oidcSubject?: string
  /** Whether the viewer may see an agent, so a bot never names one they cannot. */
  canSeeAgent(agentId: string): Promise<boolean>
  /** The request's own log, which a failed lookup is written to. */
  log?: { warn(obj: object, msg: string): void }
}

interface BotIndex {
  tenants: ReadonlySet<string>
  /** A bot's own sender id to the one agent it speaks for; a bot several agents share names none. */
  agents: ReadonlyMap<string, string>
}

/** How long a platform's bots and tenants are reused. */
const BOT_INDEX_TTL_MS = 30_000
/** How long the members' linked accounts are reused; a stale answer is served while the next one is read. */
const MEMBER_INDEX_TTL_MS = 5 * 60_000
/** How long a read waits for a cold member index before it answers without the other members. */
const MEMBER_INDEX_WAIT_MS = 2_000

export class SenderIdentityService {
  private readonly botIndexes: LRUCache<string, BotIndex, { orgId: OrgId; platform: string }>
  private readonly memberIndexes: LRUCache<
    string,
    ReadonlyMap<string, string>,
    { orgId: OrgId; platform: string; tenants: ReadonlySet<string> }
  >

  constructor(private readonly deps: SenderIdentityDeps) {
    this.botIndexes = new LRUCache({
      ...cacheOptions(deps.clock, 2_000),
      ttl: BOT_INDEX_TTL_MS,
      fetchMethod: (_key, _stale, { context }) => this.readBots(context.orgId, context.platform)
    })
    this.memberIndexes = new LRUCache({
      ...cacheOptions(deps.clock, 2_000),
      ttl: MEMBER_INDEX_TTL_MS,
      allowStale: true,
      noDeleteOnFetchRejection: true,
      fetchMethod: (_key, _stale, { context }) => this.readMembers(context.orgId, context.platform, context.tenants)
    })
  }

  /** Who each of `senders` is on `platform`; a sender the organization does not know is left out, and no failure here fails the read it decorates. */
  async resolve(
    orgId: OrgId,
    platform: string | null | undefined,
    senders: Iterable<string | null | undefined>,
    viewer: SenderIdentityViewer
  ): Promise<Map<string, SenderIdentity>> {
    const out = new Map<string, SenderIdentity>()
    const wanted = new Set([...senders].filter((sender): sender is string => !!sender))
    if (!platform || wanted.size === 0) return out
    try {
      const bots = await this.botIndexes.fetch(`${orgId}:${platform}`, { context: { orgId, platform } })
      if (!bots) return out
      for (const sender of wanted) {
        const agentId = bots.agents.get(sender)
        if (agentId && (await viewer.canSeeAgent(agentId))) out.set(sender, { agentId })
      }
      if (bots.tenants.size === 0 || !this.deps.identity) return out
      const [own, members] = await Promise.all([
        this.linkedIds(viewer.oidcSubject, platform, bots.tenants),
        this.members(orgId, platform, bots.tenants)
      ])
      for (const sender of wanted) {
        if (out.has(sender)) continue
        const userId = viewer.userId && own.has(sender) ? viewer.userId : members.get(sender)
        if (userId) out.set(sender, { userId })
      }
    } catch (err) {
      ;(viewer.log ?? this.deps.log)?.warn({ err, platform }, 'sender identity: lookup failed, senders left unnamed')
    }
    return out
  }

  /** Every chat account a member linked on a platform the organization has a bot on: the senders their own messages carry. */
  async sendersOf(orgId: OrgId, userId: string): Promise<string[]> {
    if (!this.deps.identity) return []
    try {
      const sub = await this.deps.users.getOidcSubject(userId)
      if (!sub) return []
      const platforms = new Set((await this.deps.bots.listForOrg(orgId)).map((bot) => String(bot.platform)))
      const linked = await Promise.all(
        [...platforms].map(async (platform) => {
          const bots = await this.botIndexes.fetch(`${orgId}:${platform}`, { context: { orgId, platform } })
          return bots ? [...(await this.linkedIds(sub, platform, bots.tenants))] : []
        })
      )
      return [...new Set(linked.flat())]
    } catch (err) {
      this.deps.log?.warn({ err, userId }, 'sender identity: linked-account lookup failed')
      return []
    }
  }

  private async readBots(orgId: OrgId, platform: string): Promise<BotIndex> {
    const tenantOf = this.deps.chatMemberTenant(platform)
    const bots = (await this.deps.bots.listForOrg(orgId)).filter((bot) => bot.platform === platform && !bot.revokedAt)
    const tenants = new Set<string>()
    for (const bot of bots) {
      const tenant = tenantOf?.(bot)
      if (tenant) tenants.add(tenant)
    }
    const speaksFor = new Map<string, Set<string>>()
    for (const integration of await this.deps.integrations.listForOrg(orgId)) {
      if (integration.platform !== platform || integration.status !== 'active') continue
      const agents = speaksFor.get(String(integration.botId)) ?? new Set<string>()
      agents.add(String(integration.agentId))
      speaksFor.set(String(integration.botId), agents)
    }
    const agents = new Map<string, string>()
    for (const bot of bots) {
      const backed = speaksFor.get(String(bot.id))
      if (backed?.size !== 1) continue
      for (const sender of [bot.botUserId, bot.externalAppId]) if (sender) agents.set(sender, [...backed][0]!)
    }
    return { tenants, agents }
  }

  /** The member index, or what is cached of it when a cold read outlasts the wait. */
  private async members(
    orgId: OrgId,
    platform: string,
    tenants: ReadonlySet<string>
  ): Promise<ReadonlyMap<string, string>> {
    const key = `${orgId}:${platform}:${[...tenants].sort().join(',')}`
    const read = this.memberIndexes.fetch(key, { context: { orgId, platform, tenants } }).catch((err: unknown) => {
      this.deps.log?.warn({ err, platform }, 'sender identity: member index read failed')
      return undefined
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), MEMBER_INDEX_WAIT_MS)
    })
    try {
      return (await Promise.race([read, waited])) ?? new Map()
    } finally {
      clearTimeout(timer)
    }
  }

  // An account two members linked names neither: a sender is one person or nobody.
  private async readMembers(
    orgId: OrgId,
    platform: string,
    tenants: ReadonlySet<string>
  ): Promise<ReadonlyMap<string, string>> {
    const members = await this.deps.users.listMembers(orgId)
    if (members.length > MAX_AUDIENCE) return new Map()
    const linked = await mapLimited(members, AUDIENCE_CONCURRENCY, async (member) => {
      try {
        const sub = await this.deps.users.getOidcSubject(member.userId)
        return [...(await this.linkedIds(sub, platform, tenants))]
      } catch (err) {
        this.deps.log?.warn({ err, userId: member.userId }, 'sender identity: linked-identity lookup failed')
        return []
      }
    })
    const index = new Map<string, string>()
    const shared = new Set<string>()
    members.forEach((member, i) => {
      for (const memberId of linked[i]!) {
        if (index.has(memberId) && index.get(memberId) !== member.userId) shared.add(memberId)
        else index.set(memberId, member.userId)
      }
    })
    for (const memberId of shared) index.delete(memberId)
    return index
  }

  private async linkedIds(
    sub: string | null | undefined,
    platform: string,
    tenants: ReadonlySet<string>
  ): Promise<Set<string>> {
    if (!sub || !this.deps.identity) return new Set()
    const linked = await this.deps.identity.chatIdentitiesFor(sub)
    return new Set(linked.filter((id) => id.platform === platform && tenants.has(id.tenant)).map((id) => id.memberId))
  }
}

/** What a route holds: who the senders of one platform are to the caller's organization, and the senders a member is. */
export interface SenderIdentityResolver {
  resolve(
    req: FastifyRequest,
    platform: string | null | undefined,
    senders: Iterable<string | null | undefined>
  ): Promise<Map<string, SenderIdentity>>
  sendersOf(orgId: OrgId, userId: string): Promise<string[]>
}

const resolvers = new WeakMap<HttpDeps, SenderIdentityResolver>()

export function makeSenderIdentityResolver(deps: HttpDeps): SenderIdentityResolver {
  const existing = resolvers.get(deps)
  if (existing) return existing
  const service = new SenderIdentityService({
    clock: deps.clock,
    bots: deps.repos.bot,
    integrations: deps.repos.integration,
    users: deps.repos.user,
    chatMemberTenant: (platform) => deps.platforms.get(platform)?.chatMemberTenant,
    ...(deps.logtoIdentity ? { identity: deps.logtoIdentity } : {})
  })
  const resolve: SenderIdentityResolver['resolve'] = (req, platform, senders) => {
    const orgId = orgOf(req)
    const ctx = ctxOf(req)
    const seen = new Map<string, Promise<boolean>>()
    return service.resolve(orgId, platform, senders, {
      userId: ctx.userId,
      ...(req.oidcSubject ? { oidcSubject: req.oidcSubject } : {}),
      log: req.log,
      canSeeAgent: (agentId) => {
        const known = seen.get(agentId)
        if (known) return known
        const answer = deps.repos.agent.get(orgId, AgentId(agentId)).then((agent) => !!agent && canView(agent, ctx))
        seen.set(agentId, answer)
        return answer
      }
    })
  }
  const resolver: SenderIdentityResolver = { resolve, sendersOf: (orgId, userId) => service.sendersOf(orgId, userId) }
  resolvers.set(deps, resolver)
  return resolver
}

/** A row or thread author with who its sender is, when the organization knows them. */
export function withSenderIdentity<T extends { sender: string }>(
  row: T,
  who: ReadonlyMap<string, SenderIdentity>
): T & { senderUserId?: string; senderAgentId?: string } {
  const identity = who.get(row.sender)
  if (!identity) return row
  return {
    ...row,
    ...(identity.userId ? { senderUserId: identity.userId } : {}),
    ...(identity.agentId ? { senderAgentId: identity.agentId } : {})
  }
}
