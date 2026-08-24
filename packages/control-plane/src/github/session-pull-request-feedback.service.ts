import { randomUUID } from 'node:crypto'
import {
  PULL_REQUEST_FEEDBACK_FEATURE,
  type PullRequestFeedbackSignal,
  type SessionPullRequestFeedback,
  type SessionPullRequestFeedbackResult
} from '@agentconnect.md/protocol'
import { servesSessionContent } from '../domain/session-content.js'
import type { Clock, TimerHandle } from '../domain/clock.js'
import type { PlacementResolver } from '../orchestrator/placementResolver.js'
import type {
  AgentRepo,
  GithubInstallationRepo,
  MemberSetRepo,
  PullRequestWakeRecord,
  SessionMetaRecord,
  SessionPullRequestFeedbackRepo,
  SessionRepo
} from '../persistence/ports.js'
import type { SessionPullRequestLinkService } from './session-pull-request-link.service.js'

const RETRY_MS = 10_000
const CLAIM_MS = 60_000
const FEEDBACK_DEBOUNCE_MS = 10_000
const DISCOVERY_RETRY_MS = 60_000
const UNMATCHED_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_PER_TICK = 20
const DISCOVERY_SESSIONS = 20

export interface SessionPullRequestFeedbackServiceDeps {
  clock: Clock
  feedback: SessionPullRequestFeedbackRepo
  sessions: SessionRepo
  agents: AgentRepo
  installations: GithubInstallationRepo
  memberSets: Pick<MemberSetRepo, 'sharedStoreMemberIdsOf'>
  placement: Pick<PlacementResolver, 'dispatchDaemon'>
  links: SessionPullRequestLinkService
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
  private readonly tracking = new Map<string, Promise<void>>()

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
    await Promise.allSettled(this.tracking.values())
  }

  kick(delayMs = 0): void {
    if (!this.started) return
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = undefined
      void this.tick()
    }, delayMs)
  }

  trackSession(session: SessionMetaRecord): void {
    if ((session.phase !== 'end' && session.phase !== 'problem') || session.contentPurgedAt) return
    if (this.tracking.has(session.id)) return
    const task = this.deps.agents
      .getUnscoped(session.agentId)
      .then(async (agent) => {
        if (agent) await this.deps.links.resolve(agent, session, true)
      })
      .catch((err) => this.deps.log.warn({ err, sessionId: session.id }, 'session PR feedback: link discovery failed'))
      .finally(() => this.tracking.delete(session.id))
    this.tracking.set(session.id, task)
  }

  async enqueue(signal: PullRequestFeedbackSignal): Promise<boolean> {
    const installation = await this.deps.installations.getByInstallationId(BigInt(signal.installationId))
    if (!installation || installation.revokedAt || installation.suspendedAt) return false
    const now = this.deps.clock.now()
    await this.deps.feedback.enqueue(installation.orgId, signal, new Date(now + FEEDBACK_DEBOUNCE_MS))
    this.kick()
    return true
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
    for (let i = 0; i < MAX_PER_TICK; i++) {
      const now = new Date(this.deps.clock.now())
      const item = await this.deps.feedback.claimNext(this.owner, now, new Date(now.getTime() + CLAIM_MS))
      if (!item) return
      try {
        if (!item.sessionId) {
          if (!(await this.discover(item))) {
            await this.deps.feedback.defer(item, this.owner, new Date(this.deps.clock.now() + DISCOVERY_RETRY_MS))
          }
          continue
        }
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

  private async discover(item: PullRequestWakeRecord): Promise<boolean> {
    const sessions = await this.deps.sessions.recentTerminalForPullRequestDiscovery(item.orgId, DISCOVERY_SESSIONS)
    const agents = new Map<string, Awaited<ReturnType<AgentRepo['getUnscoped']>>>()
    for (const session of sessions) {
      let agent = agents.get(session.agentId)
      if (agent === undefined) {
        agent = await this.deps.agents.getUnscoped(session.agentId)
        agents.set(session.agentId, agent)
      }
      if (!agent) continue
      const link = await this.deps.links.resolve(agent, session, true)
      if (link?.repoId !== item.repoId || link.pullNumber !== item.pullNumber) continue
      return await this.deps.feedback.linkSession({
        sessionId: session.id,
        agentId: agent.id,
        orgId: agent.orgId,
        repoId: link.repoId,
        repoFullName: link.repoFullName,
        installationId: link.installationId,
        pullNumber: link.pullNumber
      })
    }
    return false
  }

  private async deliver(item: PullRequestWakeRecord): Promise<boolean> {
    if (!item.sessionId) return false
    const session = await this.deps.sessions.getUnscoped(item.sessionId)
    if (!session || session.contentPurgedAt) return true
    const agent = await this.deps.agents.getUnscoped(session.agentId)
    if (!agent || agent.orgId !== item.orgId) return true
    const installation = await this.deps.installations.getByInstallationId(item.installationId)
    if (!installation || installation.orgId !== item.orgId || installation.revokedAt || installation.suspendedAt) {
      return true
    }
    const daemonId = await this.deps.placement.dispatchDaemon(agent)
    if (!daemonId) return false
    const sharedStoreMembers = session.contentSetId
      ? await this.deps.memberSets.sharedStoreMemberIdsOf(session.contentSetId)
      : []
    if (!servesSessionContent({ recordedDaemonId: session.daemonId, sharedStoreMembers }, daemonId)) return false
    const daemon = this.deps.daemon(daemonId)
    if (daemon?.state !== 'READY' || !daemon.capabilities?.features?.includes(PULL_REQUEST_FEEDBACK_FEATURE))
      return false
    const result = await this.deps.send(
      daemonId,
      {
        agentId: agent.id,
        sessionId: session.id,
        deliveryKey: item.deliveryKey,
        repoId: item.repoId.toString(),
        repoFullName: item.repoFullName,
        pullNumber: item.pullNumber
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
