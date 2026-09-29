import { randomUUID } from 'node:crypto'
import {
  PULL_REQUEST_FEEDBACK_FEATURE,
  CODEHOST_FEEDBACK_FEATURE,
  type PullRequestFeedbackSignal,
  type SessionPullRequestFeedback,
  type SessionPullRequestFeedbackResult
} from '@agentconnect.md/protocol'
import { servesSessionContent } from '../domain/session-content.js'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type {
  AgentRepo,
  AgentRecord,
  MemberSetRepo,
  PullRequestCaptureRecord,
  PullRequestWakeRecord,
  SessionMetaRecord,
  SessionPullRequestFeedbackRepo,
  SessionRepo
} from '../persistence/ports.js'
import type { OrgId } from '../domain/ids.js'
import type { SessionPullRequestLink } from '../github/session-pull-request-link.service.js'

export type FeedbackLink = Omit<SessionPullRequestLink, 'installationId'> &
  Pick<PullRequestWakeRecord, 'provider' | 'bindingId' | 'host' | 'installationId'>
export type FeedbackCapture = { status: 'resolved'; link: FeedbackLink } | { status: 'absent' } | { status: 'retry' }

const RETRY_MS = 10_000
const CAPTURE_RETRY_MS = 60_000
// Still unreadable a day after the session's last turn means asleep, removed or unserved; its next turn re-queues it.
export const CAPTURE_MAX_IDLE_MS = 24 * 60 * 60 * 1000
const CLAIM_MS = 60_000
const FEEDBACK_DEBOUNCE_MS = 10_000
// Also bounds delivery receipts, outliving GitHub's 3-day redelivery window.
const UNMATCHED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_PER_TICK = 20
const MAX_CAPTURES_PER_TICK = 5

/** An ended isolated session with content left, whose last turn is recent enough to still read its branch. */
function owesCapture(session: SessionMetaRecord, nowMs: number): boolean {
  return (
    (session.phase === 'end' || session.phase === 'problem') &&
    session.workspaceIsolation === 'session' &&
    !session.contentPurgedAt &&
    nowMs - session.lastActivityAt.getTime() < CAPTURE_MAX_IDLE_MS
  )
}

export interface SessionPullRequestFeedbackServiceDeps {
  clock: Clock
  feedback: SessionPullRequestFeedbackRepo
  sessions: SessionRepo
  agents: AgentRepo
  sourceOf: (signal: PullRequestFeedbackSignal) => Promise<OrgId | null>
  validate: (item: PullRequestWakeRecord, agent: AgentRecord) => Promise<boolean>
  memberSets: Pick<MemberSetRepo, 'sharedStoreMemberIdsOf'>
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  links: { capture(agent: AgentRecord, session: SessionMetaRecord): Promise<FeedbackCapture> }
  daemon: (daemonId: string) => { state: string; capabilities?: { features?: readonly string[] } } | undefined
  send: (
    daemonId: string,
    request: SessionPullRequestFeedback,
    orgId: string
  ) => Promise<SessionPullRequestFeedbackResult>
  log: {
    debug(obj: unknown, msg: string): void
    warn(obj: unknown, msg: string): void
  }
}

export class SessionPullRequestFeedbackService {
  private readonly owner = randomUUID()
  private started = false
  private timer?: TimerHandle
  private running?: Promise<void>
  private lastCleanupAt = 0

  constructor(private readonly deps: SessionPullRequestFeedbackServiceDeps) {}

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

  async trackSession(session: SessionMetaRecord): Promise<void> {
    const now = this.deps.clock.now()
    if (!owesCapture(session, now)) return
    if (await this.deps.feedback.enqueueCapture(session.id, new Date(now))) this.kick()
  }

  async enqueue(signal: PullRequestFeedbackSignal): Promise<boolean> {
    const orgId = await this.deps.sourceOf(signal)
    if (!orgId) return false
    await this.enqueueForOrg(orgId, signal)
    return true
  }

  async enqueueForOrg(
    orgId: OrgId,
    signal: Parameters<SessionPullRequestFeedbackRepo['enqueue']>[1]
  ): Promise<string | null> {
    const owner = await this.deps.feedback.owner(
      orgId,
      signal.provider ?? 'github',
      signal.bindingId ?? '',
      BigInt(signal.repoId),
      signal.pullNumber
    )
    if (
      owner &&
      (signal.sourceSessionId ? owner.sessionId === signal.sourceSessionId : owner.agentId === signal.sourceAgentId)
    )
      return null
    const now = this.deps.clock.now()
    await this.deps.feedback.enqueue(orgId, signal, new Date(now), new Date(now + FEEDBACK_DEBOUNCE_MS))
    this.kick()
    return owner?.agentId ?? null
  }

  private async tick(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run()
      .catch((err) => this.deps.log.warn({ err }, 'session PR feedback: queue pass failed'))
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
      await this.deps.feedback.deleteExpired(new Date(nowMs - UNMATCHED_TTL_MS))
    }
    await this.drainCaptures()
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const now = new Date(this.deps.clock.now())
      const item = await this.deps.feedback.claimNext(this.owner, now, new Date(now.getTime() + CLAIM_MS))
      if (!item) return
      try {
        if (await this.deliver(item)) {
          await this.deps.feedback.complete(item, this.owner)
        } else {
          await this.deps.feedback.defer(item, this.owner, new Date(this.deps.clock.now() + RETRY_MS))
        }
      } catch (err) {
        await this.deps.feedback.defer(item, this.owner, new Date(this.deps.clock.now() + RETRY_MS))
        this.deps.log.warn(
          { err, repoId: item.repoId.toString(), pullNumber: item.pullNumber },
          'session PR feedback: delivery failed'
        )
      }
    }
  }

  private async drainCaptures(): Promise<void> {
    for (let i = 0; i < MAX_CAPTURES_PER_TICK; i++) {
      const now = new Date(this.deps.clock.now())
      const item = await this.deps.feedback.claimNextCapture(this.owner, now, new Date(now.getTime() + CLAIM_MS))
      if (!item) return
      try {
        if (await this.capture(item)) {
          await this.deps.feedback.completeCapture(item, this.owner)
        } else {
          await this.deps.feedback.deferCapture(item, this.owner, new Date(this.deps.clock.now() + CAPTURE_RETRY_MS))
        }
      } catch (err) {
        await this.deps.feedback.deferCapture(item, this.owner, new Date(this.deps.clock.now() + CAPTURE_RETRY_MS))
        this.deps.log.warn({ err, sessionId: item.sessionId }, 'session PR feedback: exact-session capture failed')
      }
    }
  }

  private async capture(item: PullRequestCaptureRecord): Promise<boolean> {
    if (await this.deps.feedback.hasSession(item.sessionId)) return true
    const session = await this.deps.sessions.getUnscoped(item.sessionId)
    if (!session || !owesCapture(session, this.deps.clock.now())) return true
    const agent = await this.deps.agents.getUnscoped(session.agentId)
    if (!agent || agent.orgId !== session.orgId) return true
    const result = await this.deps.links.capture(agent, session)
    if (result.status === 'retry') return false
    if (result.status === 'absent' || result.link.scope !== 'session' || result.link.ambiguous) return true
    const linked = await this.deps.feedback.linkSession({
      sessionId: session.id,
      agentId: agent.id,
      orgId: agent.orgId,
      repoId: result.link.repoId,
      repoFullName: result.link.repoFullName,
      installationId: result.link.installationId,
      ...(result.link.provider ? { provider: result.link.provider } : {}),
      ...(result.link.bindingId ? { bindingId: result.link.bindingId } : {}),
      ...(result.link.host ? { host: result.link.host } : {}),
      pullNumber: result.link.pullNumber
    })
    if (linked) this.kick()
    return true
  }

  private async deliver(item: PullRequestWakeRecord): Promise<boolean> {
    const session = await this.deps.sessions.getUnscoped(item.sessionId)
    if (!session || session.contentPurgedAt) return true
    const agent = await this.deps.agents.getUnscoped(session.agentId)
    if (!agent || agent.orgId !== item.orgId) return true
    if (item.sourceSessionId ? item.sourceSessionId === session.id : item.sourceAgentId === agent.id) return true
    if (!(await this.deps.validate(item, agent))) return true
    const daemonId = await this.deps.placement.dispatchDaemon(agent)
    if (!daemonId) return false
    const sharedStoreMembers = session.contentSetId
      ? await this.deps.memberSets.sharedStoreMemberIdsOf(session.contentSetId)
      : []
    if (!servesSessionContent({ recordedDaemonId: session.daemonId, sharedStoreMembers }, daemonId)) return false
    const daemon = this.deps.daemon(daemonId)
    const feature =
      item.provider && item.provider !== 'github' ? CODEHOST_FEEDBACK_FEATURE : PULL_REQUEST_FEEDBACK_FEATURE
    if (daemon?.state !== 'READY' || !daemon.capabilities?.features?.includes(feature)) return false
    const result = await this.deps.send(
      daemonId,
      {
        agentId: agent.id,
        sessionId: session.id,
        deliveryKey: item.deliveryKey,
        repoId: item.repoId.toString(),
        repoFullName: item.repoFullName,
        pullNumber: item.pullNumber,
        ...(item.provider && item.provider !== 'github' ? { provider: item.provider, host: item.host } : {})
      },
      item.orgId
    )
    if (!result.accepted) {
      const detail = { repoId: item.repoId.toString(), pullNumber: item.pullNumber, reason: result.reason }
      if (result.reason === 'not_found') {
        this.deps.log.warn(detail, 'session PR feedback: linked daemon no longer has the session')
        return true
      }
      this.deps.log.debug(detail, 'session PR feedback: daemon deferred continuation')
    }
    return result.accepted
  }
}
