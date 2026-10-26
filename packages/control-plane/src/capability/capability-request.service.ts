/** Capability requests (capability-requests.md): an agent's ask, the one settling commit that wakes the conversations waiting for it, and their held delivery. */
import { randomUUID } from 'node:crypto'
import {
  CAPABILITY_REQUEST_DECLINE_MEMORY_MS,
  CAPABILITY_REQUEST_SESSION_CAP,
  CAPABILITY_REQUEST_TTL_MS,
  CAPABILITY_REQUESTS_FEATURE,
  CAPABILITY_WAKE_GIVE_UP_MS,
  CapabilityAsk,
  capabilityTarget,
  type CapabilityDecideReq,
  type CapabilityDecideResult,
  type CapabilityDecider,
  type CapabilityForward,
  type CapabilityForwardResult,
  type CapabilityReopened,
  type CapabilityRequestReq,
  type CapabilityRequestResult,
  type CapabilityWithdrawReq,
  type CapabilityWithdrawResult,
  type SessionCapabilitySettled,
  type SessionCapabilitySettledResult
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { OrgId } from '../domain/ids.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type {
  AgentRecord,
  AgentRepo,
  CapabilityRequestOriginRecord,
  CapabilityRequestRecord,
  CapabilityRequestRepo,
  CapabilitySettlement,
  McpProviderRepo,
  OrgRepo,
  SkillSourceRepo
} from '../persistence/ports.js'
import { capabilitySummary, evaluateCapability, skillSourceOf } from './capability-wording.js'

const RETRY_BASE_MS = 10_000
const RETRY_MAX_MS = 10 * 60_000
const CLAIM_MS = 60_000
const MAX_PER_TICK = 20
const IDLE_TICK_MS = 60_000
// A completion whose upsert no daemon was seen to apply is sent anyway after this, rather than never.
const UNACKED_COMPLETION_MS = 2 * 60_000

/** Why a console action was refused. */
export type CapabilityActionRefusal = 'not_found' | 'not_open' | 'not_declined' | 'conflict'

export interface CapabilityRequestServiceDeps {
  clock: Clock
  requests: CapabilityRequestRepo
  agents: Pick<AgentRepo, 'getUnscoped'>
  mcpProviders: Pick<McpProviderRepo, 'listForOrg'>
  skillSources: Pick<SkillSourceRepo, 'getByName'>
  orgs: Pick<OrgRepo, 'slugById'>
  /** The console's origin; absent ⇒ requests carry no link. */
  webAppUrl?: string
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  daemon: (daemonId: string) => { state: string; capabilities?: { features?: readonly string[] } } | undefined
  sendSettled: (
    daemonId: string,
    orgId: string,
    wake: SessionCapabilitySettled
  ) => Promise<SessionCapabilitySettledResult>
  sendReopened: (daemonId: string, orgId: string, frame: CapabilityReopened) => Promise<void>
  sendForward: (daemonId: string, orgId: string, frame: CapabilityForward) => Promise<CapabilityForwardResult>
  log: { debug(obj: unknown, msg: string): void; warn(obj: unknown, msg: string): void }
}

/** The stored request's ask, parsed back from its row. */
export function askOf(row: Pick<CapabilityRequestRecord, 'kind' | 'want'>): CapabilityAsk | null {
  const parsed = CapabilityAsk.safeParse({ kind: row.kind, want: row.want })
  return parsed.success ? parsed.data : null
}

/** How long a deferred wake waits before its next attempt. */
export function wakeBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
}

/** A decider as the card and the reminder name them. */
export function deciderName(by: CapabilityDecider | null): string | undefined {
  return by?.name?.trim() || undefined
}

export class CapabilityRequestService {
  private readonly owner = randomUUID()
  private started = false
  private timer?: TimerHandle
  private running?: Promise<void>
  // The configRevision each daemon acknowledged per agent, and when each daemon last registered: a completion's wake waits for either (§4.7.5).
  private readonly acked = new Map<string, bigint>()
  private readonly readyAt = new Map<string, number>()

  constructor(private readonly deps: CapabilityRequestServiceDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.kick()
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  async settle(): Promise<void> {
    await this.running
  }

  kick(delayMs = 0): void {
    if (!this.started) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delayMs)
  }

  private now(): Date {
    return new Date(this.deps.clock.now())
  }

  /** `<webAppUrl>/<orgSlug>/requests/<id>`, or nothing when the console's origin is unknown. */
  async linkFor(orgId: string, id: string): Promise<string | undefined> {
    const base = this.deps.webAppUrl?.replace(/\/+$/, '')
    if (!base) return undefined
    const slug = await this.deps.orgs.slugById(orgId)
    return slug ? `${base}/${encodeURIComponent(slug)}/requests/${id}` : undefined
  }

  get(orgId: OrgId, id: string): Promise<CapabilityRequestRecord | null> {
    return this.deps.requests.get(orgId, id)
  }

  list(orgId: OrgId, filter: Parameters<CapabilityRequestRepo['list']>[1]): Promise<CapabilityRequestRecord[]> {
    return this.deps.requests.list(orgId, filter)
  }

  /** Answer `capability/request` for an agent its caller serves. */
  async request(agent: AgentRecord, req: CapabilityRequestReq): Promise<CapabilityRequestResult> {
    const parsed = CapabilityAsk.safeParse(req.ask)
    if (!parsed.success) return { status: 'refused', refused: 'invalid', message: 'the request is malformed' }
    const ask = parsed.data
    const unknown = await this.unknownTarget(agent, ask)
    if (unknown) return { status: 'refused', refused: 'unknown_target', message: unknown }
    const summary = capabilitySummary(ask)
    const evaluation = evaluateCapability(ask, agent)
    if (evaluation.satisfied) {
      return {
        status: 'already_satisfied',
        summary,
        message: `This agent already has what it asked for: ${evaluation.outcome}`
      }
    }
    const target = capabilityTarget(ask)
    const origin = {
      sessionId: req.sessionId,
      sessionKey: req.sessionKey,
      platform: req.platform,
      placeLabel: req.placeLabel ?? null,
      external: req.external === true,
      askers: req.askers
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const open = await this.deps.requests.open(agent.id, ask.kind, target)
      if (open) {
        const already = open.origins.some((o) => o.sessionId === req.sessionId)
        if (!already && (await this.deps.requests.openForSession(req.sessionId)) >= CAPABILITY_REQUEST_SESSION_CAP)
          return this.limited()
        if (!already && !(await this.deps.requests.addOrigin(open.id, origin, this.now()))) continue
        return this.pending(open, !already)
      }
      const since = new Date(this.deps.clock.now() - CAPABILITY_REQUEST_DECLINE_MEMORY_MS)
      const declined = await this.deps.requests.declinedSince(agent.id, ask.kind, target, since)
      if (declined?.settledAt) {
        return {
          status: 'declined_recently',
          requestId: declined.id,
          generation: declined.generation,
          summary: declined.summary,
          declined: {
            by: deciderName(declined.settledBy) ?? 'someone',
            ...(declined.note ? { note: declined.note } : {}),
            at: declined.settledAt.toISOString()
          }
        }
      }
      if ((await this.deps.requests.openForSession(req.sessionId)) >= CAPABILITY_REQUEST_SESSION_CAP)
        return this.limited()
      const now = this.now()
      const created = await this.deps.requests.create({
        id: randomUUID(),
        orgId: agent.orgId,
        agentId: agent.id,
        kind: ask.kind,
        target,
        want: ask.want as Record<string, unknown>,
        summary,
        reason: req.reason,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CAPABILITY_REQUEST_TTL_MS),
        origin
      })
      // Another conversation opened the same request first: join it instead.
      if (created) return this.pending(created, false)
    }
    return { status: 'refused', refused: 'invalid', message: 'the request could not be recorded; try again' }
  }

  private limited(): CapabilityRequestResult {
    return {
      status: 'refused',
      refused: 'limit',
      message: `This conversation already has ${CAPABILITY_REQUEST_SESSION_CAP} open requests; wait for one to be settled.`
    }
  }

  private async pending(row: CapabilityRequestRecord, joined: boolean): Promise<CapabilityRequestResult> {
    const link = await this.linkFor(row.orgId, row.id)
    return {
      status: 'pending',
      requestId: row.id,
      generation: row.generation,
      summary: row.summary,
      ...(link ? { link } : {}),
      ...(joined ? { joined: true } : {})
    }
  }

  /** Why the target cannot be given to this agent, or undefined when it names something the organization has. */
  private async unknownTarget(agent: AgentRecord, ask: CapabilityAsk): Promise<string | undefined> {
    if (ask.kind === 'mcp-server') {
      const providers = await this.deps.mcpProviders.listForOrg(agent.orgId)
      if (!providers.some((p) => p.name === ask.want.server))
        return `This organization has no MCP server named ${JSON.stringify(ask.want.server)}.`
    }
    if (ask.kind === 'skill') {
      const source = skillSourceOf(ask.want.skill)
      if (!(await this.deps.skillSources.getByName(agent.orgId, source)))
        return `This organization has no skill source named ${JSON.stringify(source)}.`
    }
    return undefined
  }

  /** `capability/withdraw`: only a conversation waiting for the request may leave it; nobody is woken. */
  async withdraw(agent: AgentRecord, req: CapabilityWithdrawReq): Promise<CapabilityWithdrawResult> {
    const row = await this.deps.requests.getForAgent(agent.id, req.requestId)
    if (!row || !row.origins.some((o) => o.sessionId === req.sessionId)) return { status: 'not_found' }
    if (row.status !== 'open') return { status: 'already_settled' }
    const done = await this.deps.requests.withdrawOrigin(row.id, req.sessionId, this.now())
    return done ? { status: 'withdrawn' } : { status: 'already_settled' }
  }

  /** `capability/decide`: a Decline from a chat card, by compare-and-set on status and generation (§4.4.4). */
  async decide(agent: AgentRecord, req: CapabilityDecideReq): Promise<CapabilityDecideResult> {
    const row = await this.deps.requests.getForAgent(agent.id, req.requestId)
    if (!row) return { result: 'not_found' }
    const settled = await this.commit(row, req.generation, {
      status: 'declined',
      outcome: null,
      differs: false,
      note: null,
      settledBy: req.by,
      settledRevision: null,
      at: this.now()
    })
    return { result: settled ? 'settled' : 'already_settled' }
  }

  /** The ONLY settling write: a compare-and-set whose success makes every origin's wake pending. */
  private async commit(
    row: CapabilityRequestRecord,
    generation: number,
    settlement: CapabilitySettlement
  ): Promise<boolean> {
    const settled = await this.deps.requests.settle(row.id, generation, settlement)
    if (settled) this.kick()
    return settled
  }

  /** Complete an open request from current rows: the outcome as observed, `differs` when it is not what was asked. */
  private async complete(
    row: CapabilityRequestRecord,
    agent: AgentRecord,
    settledBy: CapabilityDecider | null,
    requireSatisfied: boolean
  ): Promise<boolean> {
    const ask = askOf(row)
    if (!ask) return false
    const evaluation = evaluateCapability(ask, agent)
    if (requireSatisfied && !evaluation.satisfied) return false
    return this.commit(row, row.generation, {
      status: 'completed',
      outcome: evaluation.outcome,
      differs: !evaluation.satisfied,
      note: null,
      settledBy,
      settledRevision: agent.configRevision,
      at: this.now()
    })
  }

  /** After an agent's spec reached its daemons: note what they applied and complete every open request the change satisfied (§4.6). */
  async agentUpserted(agent: AgentRecord, ackedDaemonIds: readonly string[]): Promise<void> {
    for (const daemonId of ackedDaemonIds) {
      const key = `${agent.id}:${daemonId}`
      const prior = this.acked.get(key)
      if (prior === undefined || prior < agent.configRevision) this.acked.set(key, agent.configRevision)
    }
    const open = await this.deps.requests.openForAgent(agent.id)
    const by: CapabilityDecider | null = agent.lastModifiedBy
      ? {
          kind: 'console',
          userId: agent.lastModifiedBy.userId,
          name: agent.lastModifiedBy.displayName ?? agent.lastModifiedBy.email
        }
      : null
    for (const row of open) await this.complete(row, agent, by, true)
    if (ackedDaemonIds.length > 0) this.kick()
  }

  /** A daemon registered: the specs it was handed carry every change settled before now. */
  daemonReady(daemonId: string): void {
    this.readyAt.set(daemonId, this.deps.clock.now())
    this.kick()
  }

  /** Settle from the console after a save: completes with what was saved, whether or not it is what was asked. */
  async settleFromConsole(
    orgId: OrgId,
    id: string,
    by: CapabilityDecider
  ): Promise<CapabilityRequestRecord | CapabilityActionRefusal> {
    const row = await this.deps.requests.get(orgId, id)
    if (!row) return 'not_found'
    if (row.status !== 'open') return 'not_open'
    const agent = await this.deps.agents.getUnscoped(row.agentId)
    if (!agent || agent.orgId !== orgId) return 'not_found'
    if (!(await this.complete(row, agent, by, false))) return 'not_open'
    return (await this.deps.requests.get(orgId, id)) ?? 'not_found'
  }

  async declineFromConsole(
    orgId: OrgId,
    id: string,
    by: CapabilityDecider,
    note: string | undefined
  ): Promise<CapabilityRequestRecord | CapabilityActionRefusal> {
    const row = await this.deps.requests.get(orgId, id)
    if (!row) return 'not_found'
    if (row.status !== 'open') return 'not_open'
    const settled = await this.commit(row, row.generation, {
      status: 'declined',
      outcome: null,
      differs: false,
      note: note?.trim() ? note.trim() : null,
      settledBy: by,
      settledRevision: null,
      at: this.now()
    })
    if (!settled) return 'not_open'
    return (await this.deps.requests.get(orgId, id)) ?? 'not_found'
  }

  /** Reopen a declined request with the next generation and tell its daemon to put its cards back (§4.5). */
  async reopen(orgId: OrgId, id: string): Promise<CapabilityRequestRecord | CapabilityActionRefusal> {
    const row = await this.deps.requests.get(orgId, id)
    if (!row) return 'not_found'
    if (row.status !== 'declined') return 'not_declined'
    const now = this.now()
    const reopened = await this.deps.requests.reopen(
      id,
      row.generation,
      now,
      new Date(now.getTime() + CAPABILITY_REQUEST_TTL_MS)
    )
    if (!reopened) {
      const current = await this.deps.requests.get(orgId, id)
      return current?.status === 'declined' ? 'conflict' : 'not_declined'
    }
    await this.tellDaemon(reopened, async (daemonId, link) => {
      await this.deps.sendReopened(daemonId, reopened.orgId, {
        agentId: reopened.agentId,
        requestId: reopened.id,
        generation: reopened.generation,
        summary: reopened.summary,
        reason: reopened.reason,
        link
      })
    })
    return reopened
  }

  /** Forward an open request to someone who can act on it, through the agent's linked DM; else it stays listed. */
  async forward(row: CapabilityRequestRecord, consoleUserId: string, forwardedBy: string): Promise<'dm' | 'activity'> {
    let delivered = false
    await this.tellDaemon(row, async (daemonId, link) => {
      const result = await this.deps.sendForward(daemonId, row.orgId, {
        agentId: row.agentId,
        requestId: row.id,
        generation: row.generation,
        consoleUserId,
        forwardedBy,
        summary: row.summary,
        reason: row.reason,
        link
      })
      delivered = result.delivered
    })
    return delivered ? 'dm' : 'activity'
  }

  /** Best-effort send to the agent's live daemon when it serves capability requests and the request has a link. */
  private async tellDaemon(
    row: CapabilityRequestRecord,
    send: (daemonId: string, link: string) => Promise<void>
  ): Promise<void> {
    try {
      const link = await this.linkFor(row.orgId, row.id)
      const agent = await this.deps.agents.getUnscoped(row.agentId)
      const daemonId = agent && link ? await this.deps.placement.dispatchDaemon(agent) : null
      if (!link || !daemonId || !this.serves(daemonId)) return
      await send(daemonId, link)
    } catch (err) {
      this.deps.log.warn({ err, requestId: row.id }, 'capability request: daemon notice failed')
    }
  }

  private serves(daemonId: string): boolean {
    const daemon = this.deps.daemon(daemonId)
    return daemon?.state === 'READY' && daemon.capabilities?.features?.includes(CAPABILITY_REQUESTS_FEATURE) === true
  }

  private async tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run()
      .catch((err) => this.deps.log.warn({ err }, 'capability request: queue pass failed'))
      .finally(() => {
        this.running = undefined
        this.kick(IDLE_TICK_MS)
      })
    return this.running
  }

  private async run(): Promise<void> {
    // Expired requests wake their origins once (§4.6).
    for (const row of await this.deps.requests.expired(this.now(), MAX_PER_TICK)) {
      await this.deps.requests.settle(row.id, row.generation, {
        status: 'expired',
        outcome: null,
        differs: false,
        note: null,
        settledBy: null,
        settledRevision: null,
        at: this.now()
      })
    }
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const now = this.now()
      const claimed = await this.deps.requests.claimWake(this.owner, now, new Date(now.getTime() + CLAIM_MS))
      if (!claimed) return
      try {
        await this.deliver(claimed.request, claimed.origin)
      } catch (err) {
        await this.defer(claimed.request, claimed.origin, 'failed')
        this.deps.log.warn({ err, requestId: claimed.request.id }, 'capability request: wake failed')
      }
    }
  }

  private async finish(
    origin: CapabilityRequestOriginRecord,
    state: 'delivered' | 'gone' | 'none',
    reason: string | null
  ): Promise<void> {
    await this.deps.requests.finishWake(origin.requestId, origin.sessionId, this.owner, origin.wakeGeneration, {
      state,
      reason,
      dueAt: null,
      attempts: origin.wakeAttempts + 1
    })
  }

  private async defer(
    row: CapabilityRequestRecord,
    origin: CapabilityRequestOriginRecord,
    reason: string
  ): Promise<void> {
    const attempts = origin.wakeAttempts + 1
    const since = origin.wakeSince?.getTime() ?? row.settledAt?.getTime() ?? this.deps.clock.now()
    if (this.deps.clock.now() - since >= CAPABILITY_WAKE_GIVE_UP_MS) return this.finish(origin, 'gone', reason)
    await this.deps.requests.finishWake(origin.requestId, origin.sessionId, this.owner, origin.wakeGeneration, {
      state: 'pending',
      reason,
      dueAt: new Date(this.deps.clock.now() + wakeBackoffMs(attempts)),
      attempts
    })
  }

  /** Whether the daemon has applied the change a completion observed: an acknowledged upsert at that revision, or a registration after it. */
  private applied(row: CapabilityRequestRecord, daemonId: string): boolean {
    if (row.status !== 'completed' || row.settledRevision === null) return true
    const acked = this.acked.get(`${row.agentId}:${daemonId}`)
    if (acked !== undefined && acked >= row.settledRevision) return true
    const ready = this.readyAt.get(daemonId)
    if (ready !== undefined && row.settledAt && ready >= row.settledAt.getTime()) return true
    return row.settledAt !== null && this.deps.clock.now() - row.settledAt.getTime() >= UNACKED_COMPLETION_MS
  }

  private async deliver(row: CapabilityRequestRecord, origin: CapabilityRequestOriginRecord): Promise<void> {
    // A reopened or withdrawn request no longer owes this generation's wake.
    if (
      origin.wakeGeneration !== row.generation ||
      (row.status !== 'completed' && row.status !== 'declined' && row.status !== 'expired')
    ) {
      return this.finish(origin, 'none', null)
    }
    const agent = await this.deps.agents.getUnscoped(row.agentId)
    if (!agent || agent.orgId !== row.orgId) return this.finish(origin, 'gone', 'agent_removed')
    const daemonId = await this.deps.placement.dispatchDaemon(agent)
    if (!daemonId || !this.serves(daemonId)) return this.defer(row, origin, 'daemon_unavailable')
    if (!this.applied(row, daemonId)) {
      await this.deps.requests.finishWake(origin.requestId, origin.sessionId, this.owner, origin.wakeGeneration, {
        state: 'pending',
        reason: 'awaiting_change',
        dueAt: new Date(this.deps.clock.now() + RETRY_BASE_MS),
        attempts: origin.wakeAttempts
      })
      return
    }
    const by = deciderName(row.settledBy)
    const wake: SessionCapabilitySettled = {
      agentId: row.agentId,
      sessionId: origin.sessionId,
      sessionKey: origin.sessionKey,
      requestId: row.id,
      generation: row.generation,
      status: row.status,
      askers: origin.askers,
      summary: row.summary,
      reason: row.reason,
      outcome: row.outcome ?? '',
      ...(row.differs ? { differs: true } : {}),
      ...(by ? { by: { name: by } } : {}),
      ...(row.note ? { note: row.note } : {}),
      reload: false
    }
    const result = await this.deps.sendSettled(daemonId, row.orgId, wake)
    if (result.accepted) return this.finish(origin, 'delivered', null)
    if (result.reason === 'not_found') return this.finish(origin, 'gone', 'not_found')
    this.deps.log.debug({ requestId: row.id, reason: result.reason }, 'capability request: daemon deferred the wake')
    await this.defer(row, origin, result.reason ?? 'deferred')
  }
}
