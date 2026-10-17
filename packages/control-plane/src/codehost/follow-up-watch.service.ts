/** Event wake for follow-ups (assistant-mode.md §5.14): the subscriptions daemons ask for, the events that fold into one pending wake, and its held delivery. */
import { randomUUID } from 'node:crypto'
import {
  FOLLOW_UP_WAKE_FEATURE,
  FOLLOW_UP_WATCH_MAX,
  isFollowUpStateEvent,
  type AssistantFollowUpWake,
  type AssistantFollowUpWakeResult,
  type AssistantFollowUpWatchReq,
  type AssistantFollowUpWatchResult,
  type CodeHostProvider,
  type FollowUpEventKind,
  type FollowUpWatchRefusal,
  type FollowUpWatchSubject,
  type FollowUpWatchTarget,
  type RcFollowUpWatch
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { AgentId } from '../domain/ids.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type {
  AgentRecord,
  AgentRepo,
  FollowUpPendingWake,
  FollowUpWatchObject,
  FollowUpWatchRecord,
  FollowUpWatchRepo
} from '../persistence/ports.js'

export const STATE_QUIET_MS = 60_000
export const STATE_CAP_MS = 10 * 60_000
export const DISCUSSION_MS = 30 * 60_000
const RETRY_MS = 10_000
const CLAIM_MS = 60_000
const MAX_PER_TICK = 20
const FOLD_TRIES = 3
// Outlives GitHub's three-day redelivery window, as the lane's receipts do.
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** One object a provider resolved with the agent's own access. */
export interface ResolvedFollowUpWatch {
  installationId: bigint | null
  bindingId: string
  host: string
  repoId: bigint
  repoPath: string
  subject: FollowUpWatchSubject
  number: number
}

/** One code host's half of event wake; core names no provider. */
export interface FollowUpWatchProvider {
  readonly provider: CodeHostProvider
  /** Resolve a target to its numeric identity, reading the object once with the agent's credential. */
  resolve(agent: AgentRecord, target: FollowUpWatchTarget): Promise<ResolvedFollowUpWatch | FollowUpWatchRefusal>
  /** From the Control Plane's own tables, no provider call: whether the agent's access still covers the watch. */
  covers(agent: AgentRecord, watch: FollowUpWatchRecord): Promise<boolean>
  /** The relay frame for an object, when this host's relay matches watched objects itself. */
  relayWatch?(object: FollowUpWatchObject & { installationId: bigint | null }, watched: boolean): RcFollowUpWatch | null
}

/** One verified event on an object, as the feedback lane received it. */
export interface FollowUpObjectEvent {
  object: FollowUpWatchObject
  deliveryKey: string
  kind: FollowUpEventKind
  /** The lane admits it, so it resumes the session that opened the pull request. */
  feedback: boolean
}

/** Fold one event into a pending wake: a change of state after one quiet minute, at most ten after the first; discussion 30 minutes after it arrived. */
export function foldWake(pending: FollowUpPendingWake, kind: FollowUpEventKind, at: Date): FollowUpPendingWake {
  const state = isFollowUpStateEvent(kind)
  const stateSince = pending.pendingStateSince ?? (state ? at : null)
  const latest = pending.pendingLatestAt && pending.pendingLatestAt > at ? pending.pendingLatestAt : at
  let dueAt: Date
  if (state) {
    dueAt = new Date(Math.min(at.getTime() + STATE_QUIET_MS, stateSince!.getTime() + STATE_CAP_MS))
  } else {
    dueAt = pending.dueAt ?? new Date(at.getTime() + DISCUSSION_MS)
  }
  return {
    pendingSince: pending.pendingSince ?? at,
    pendingStateSince: stateSince,
    pendingLatestAt: latest,
    pendingKinds: pending.pendingKinds.includes(kind) ? pending.pendingKinds : [...pending.pendingKinds, kind],
    dueAt
  }
}

/** Who speaks (§5.14): an event that resumes, or discussion on, the agent's own opened pull request wakes none of its follow-ups. */
export function wakesFollowUp(
  event: Pick<FollowUpObjectEvent, 'kind' | 'feedback'>,
  watchAgentId: string,
  openerAgentId: string | null
): boolean {
  if (openerAgentId === null || openerAgentId !== watchAgentId) return true
  return !event.feedback && isFollowUpStateEvent(event.kind)
}

function sameTarget(row: FollowUpWatchRecord, target: FollowUpWatchTarget): boolean {
  return (
    row.provider === target.provider &&
    row.host.toLowerCase() === target.host.toLowerCase() &&
    row.repoPath.toLowerCase() === target.repoPath.toLowerCase() &&
    row.subject === target.subject &&
    row.number === target.number
  )
}

export interface FollowUpWatchServiceDeps {
  clock: Clock
  watches: FollowUpWatchRepo
  agents: Pick<AgentRepo, 'getUnscoped'>
  providers: FollowUpWatchProvider[]
  /** The agent whose session opened this pull request, as the feedback lane records it. */
  opener: (object: FollowUpWatchObject) => Promise<AgentId | null>
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  daemon: (daemonId: string) => { state: string; capabilities?: { features?: readonly string[] } } | undefined
  send: (daemonId: string, request: AssistantFollowUpWake, orgId: string) => Promise<AssistantFollowUpWakeResult>
  /** Tell every relay that holds watches that an object is, or is no longer, watched. */
  broadcast: (watch: RcFollowUpWatch) => void
  log: {
    debug(obj: unknown, msg: string): void
    warn(obj: unknown, msg: string): void
  }
}

export class FollowUpWatchService {
  private readonly owner = randomUUID()
  private readonly providers: Map<string, FollowUpWatchProvider>
  private started = false
  private timer?: TimerHandle
  private running?: Promise<void>
  private lastCleanupAt = 0

  constructor(private readonly deps: FollowUpWatchServiceDeps) {
    this.providers = new Map(deps.providers.map((provider) => [provider.provider, provider]))
  }

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

  /** Answer one `assistant/follow-up-watch` for an agent its caller serves. */
  async apply(agent: AgentRecord, req: AssistantFollowUpWatchReq): Promise<AssistantFollowUpWatchResult> {
    if (req.mode === 'remove') {
      await this.drop(
        await this.deps.watches.remove(
          agent.id,
          req.watches.map((watch) => watch.followUpId)
        )
      )
      return { results: req.watches.map((watch) => ({ followUpId: watch.followUpId })) }
    }
    const existing = new Map((await this.deps.watches.listForAgent(agent.id)).map((row) => [row.followUpId, row]))
    if (req.mode === 'full') {
      const listed = new Set(req.watches.map((watch) => watch.followUpId))
      const stale = [...existing.keys()].filter((followUpId) => !listed.has(followUpId))
      await this.drop(await this.deps.watches.remove(agent.id, stale))
      for (const followUpId of stale) existing.delete(followUpId)
    }
    const results: AssistantFollowUpWatchResult['results'] = []
    for (const { followUpId, target } of req.watches) {
      const outcome = await this.set(agent, followUpId, target!, existing)
      results.push(
        typeof outcome === 'string'
          ? { followUpId, refused: outcome }
          : {
              followUpId,
              watched: {
                provider: target!.provider,
                repoPath: outcome.repoPath,
                subject: outcome.subject,
                number: outcome.number
              }
            }
      )
    }
    return { results }
  }

  private async set(
    agent: AgentRecord,
    followUpId: string,
    target: FollowUpWatchTarget,
    existing: Map<string, FollowUpWatchRecord>
  ): Promise<FollowUpWatchRecord | FollowUpWatchRefusal> {
    const current = existing.get(followUpId)
    // Re-sent unchanged, as a full set does on every serve: no second read.
    if (current && !current.endedReason && sameTarget(current, target)) return current
    const refuse = async (reason: FollowUpWatchRefusal) => {
      if (current) {
        await this.drop(await this.deps.watches.remove(agent.id, [followUpId]))
        existing.delete(followUpId)
      }
      return reason
    }
    const provider = this.providers.get(target.provider)
    if (!provider) return refuse('unsupported')
    if (!current && existing.size >= FOLLOW_UP_WATCH_MAX) return refuse('limit')
    let resolved: ResolvedFollowUpWatch | FollowUpWatchRefusal
    try {
      resolved = await provider.resolve(agent, target)
    } catch (err) {
      this.deps.log.warn({ err, agentId: agent.id }, 'follow-up watch: resolve failed')
      resolved = 'unavailable'
    }
    if (typeof resolved === 'string') return refuse(resolved)
    const input = { agentId: agent.id, followUpId, orgId: agent.orgId, provider: target.provider, ...resolved }
    await this.deps.watches.put(input)
    if (current && !sameTarget(current, target)) await this.drop([current])
    this.relay(input, true)
    const row = (await this.deps.watches.listForAgent(agent.id)).find((watch) => watch.followUpId === followUpId)
    if (row) existing.set(followUpId, row)
    return row ?? refuse('unavailable')
  }

  /** Tell the relays an object is unwatched once no watch names it. */
  private async drop(rows: FollowUpWatchRecord[]): Promise<void> {
    for (const row of rows) {
      if (!(await this.deps.watches.watched(row))) this.relay(row, false)
    }
  }

  private relay(object: FollowUpWatchObject & { installationId: bigint | null }, watched: boolean): void {
    const frame = this.providers.get(object.provider)?.relayWatch?.(object, watched)
    if (frame) this.deps.broadcast(frame)
  }

  /** Replay every watched object this provider's relays match, for one relay that just registered. */
  async replayTo(send: (watch: RcFollowUpWatch) => void): Promise<void> {
    for (const provider of this.providers.values()) {
      if (!provider.relayWatch) continue
      for (const object of await this.deps.watches.objects(provider.provider)) {
        const frame = provider.relayWatch(object, true)
        if (frame) send(frame)
      }
    }
  }

  /** Fold one verified event into the pending wake of each follow-up it wakes. */
  async receive(event: FollowUpObjectEvent): Promise<void> {
    const rows = await this.deps.watches.forObject(event.object)
    if (rows.length === 0) return
    const now = new Date(this.deps.clock.now())
    if (!(await this.deps.watches.receive(event.object, event.deliveryKey, now))) return
    const asksOpener = event.object.subject === 'pull' && (event.feedback || !isFollowUpStateEvent(event.kind))
    const opener = asksOpener ? await this.deps.opener(event.object) : null
    let folded = false
    for (const row of rows) {
      if (!wakesFollowUp(event, row.agentId, opener)) continue
      folded = (await this.fold(row, event.kind, now)) || folded
    }
    if (folded) this.kick()
  }

  private async fold(row: FollowUpWatchRecord, kind: FollowUpEventKind, at: Date): Promise<boolean> {
    let current: FollowUpWatchRecord | undefined = row
    for (let i = 0; i < FOLD_TRIES && current; i++) {
      if (await this.deps.watches.fold(current, foldWake(current, kind, at))) return true
      current = (await this.deps.watches.forObject(row)).find(
        (watch) => watch.agentId === row.agentId && watch.followUpId === row.followUpId
      )
    }
    return false
  }

  private async tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run()
      .catch((err) => this.deps.log.warn({ err }, 'follow-up wake: queue pass failed'))
      .finally(() => {
        this.running = undefined
        this.kick(RETRY_MS)
      })
    return this.running
  }

  private async run(): Promise<void> {
    const nowMs = this.deps.clock.now()
    if (nowMs - this.lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      this.lastCleanupAt = nowMs
      await this.deps.watches.deleteExpiredReceipts(new Date(nowMs - RECEIPT_TTL_MS))
    }
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const now = new Date(this.deps.clock.now())
      const row = await this.deps.watches.claimNext(this.owner, now, new Date(now.getTime() + CLAIM_MS))
      if (!row) return
      try {
        await this.deliver(row)
      } catch (err) {
        await this.deps.watches.defer(row, this.owner, new Date(this.deps.clock.now() + RETRY_MS))
        this.deps.log.warn({ err, agentId: row.agentId }, 'follow-up wake: delivery failed')
      }
    }
  }

  private async deliver(row: FollowUpWatchRecord): Promise<void> {
    const agent = await this.deps.agents.getUnscoped(row.agentId)
    if (!agent || agent.orgId !== row.orgId) {
      await this.drop(await this.deps.watches.remove(row.agentId, [row.followUpId]))
      return
    }
    let ended = row.endedReason
    if (!ended && !(await this.providers.get(row.provider)?.covers(agent, row))) {
      // Access is gone: the pending wake gives way to a notice, and the relays stop forwarding.
      await this.deps.watches.end(row, 'access_lost', new Date(this.deps.clock.now()))
      await this.drop([{ ...row, endedReason: 'access_lost' }])
      ended = 'access_lost'
    }
    const defer = () => this.deps.watches.defer(row, this.owner, new Date(this.deps.clock.now() + RETRY_MS))
    const daemonId = await this.deps.placement.dispatchDaemon(agent)
    const daemon = daemonId ? this.deps.daemon(daemonId) : undefined
    if (!daemonId || daemon?.state !== 'READY' || !daemon.capabilities?.features?.includes(FOLLOW_UP_WAKE_FEATURE)) {
      return defer()
    }
    const wake: AssistantFollowUpWake = ended
      ? { agentId: agent.id, followUpId: row.followUpId, wakeId: row.wakeSeq + 1, kinds: [], ended }
      : {
          agentId: agent.id,
          followUpId: row.followUpId,
          wakeId: row.wakeSeq,
          kinds: row.pendingKinds,
          latestAt: (row.pendingLatestAt ?? new Date(this.deps.clock.now())).toISOString()
        }
    const result = await this.deps.send(daemonId, wake, agent.orgId)
    if (result.accepted || result.reason === 'not_found') {
      if (ended || !result.accepted) {
        await this.drop(await this.deps.watches.remove(row.agentId, [row.followUpId]))
      } else {
        await this.deps.watches.complete(row, this.owner, new Date(this.deps.clock.now()))
      }
      return
    }
    this.deps.log.debug({ agentId: agent.id, reason: result.reason }, 'follow-up wake: daemon deferred the wake')
    await defer()
  }
}
