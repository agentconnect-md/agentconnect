// ComputerPool — managed computers in the Kubernetes pool: allocate, wake, sleep and reclaim them (computer-use.md §15.1).
import { randomUUID } from 'node:crypto'
import type {
  ComputerPoolAcquire,
  ComputerPoolAcquireResult,
  ComputerPoolOp,
  ComputerPoolOpResult,
  ComputerPoolPendingPhase,
  ComputerPoolRefusal
} from '@agentconnect.md/protocol'
import type { Clock, TimerHandle } from '../domain/clock.js'
import { AgentId, ComputerId, type OrgId } from '../domain/ids.js'
import {
  computerGrantsAgent,
  defaultComputerPolicy,
  isComputerReachable,
  type ComputerAgentAccess,
  type ComputerPolicy
} from '../domain/computer.js'
import {
  DEFAULT_COMPUTER_POOL_TIMINGS,
  managedComputerName,
  managedComputerPolicy,
  poolError,
  poolErrorCode,
  poolErrorMessage,
  poolActions,
  poolNeedsReset,
  provisionStep,
  sweepAction,
  type ComputerManagedMode,
  type ComputerPoolPhase,
  type ComputerPoolTimings
} from '../domain/computerPool.js'
import type { AgentRecord, ComputerRecord, ComputerRepo, ManagedComputerKey } from '../persistence/ports.js'
import type { ComputerService } from './computerService.js'
import type { ComputerLeaseService } from './computerLeaseService.js'

/** The pool members that hold the cluster credentials; the Control Plane holds none (k8s-daemon-pool.md D17). */
export interface ComputerPoolMembers {
  /** Whether any member that serves desktop claims is connected. */
  available(): boolean
  /** Send one op to such a member; undefined when none is connected or it did not answer. */
  op(op: ComputerPoolOp): Promise<ComputerPoolOpResult | undefined>
}

export interface ComputerPoolLog {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
}

export interface ComputerPoolDeps {
  repo: Pick<
    ComputerRepo,
    | 'get'
    | 'getUnscoped'
    | 'createManaged'
    | 'findManaged'
    | 'setPoolPhase'
    | 'touchPoolActive'
    | 'listPool'
    | 'orgOwnerUserId'
  >
  agents: { get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | null> }
  computers: Pick<ComputerService, 'createRegistration' | 'revoke' | 'delete' | 'presentedStatus' | 'accessGranted'>
  leases?: Pick<ComputerLeaseService, 'current' | 'preempt'>
  members: ComputerPoolMembers
  clock: Clock
  timings?: Partial<ComputerPoolTimings>
  /** How often the controller sweeps; 0 arms no timer. */
  sweepIntervalMs?: number
  /** Acquire-driven advances are at most this frequent per computer. */
  advanceThrottleMs?: number
  log?: ComputerPoolLog
}

/** How long a session waits before asking again while its computer comes up. */
export const COMPUTER_POOL_RETRY_MS = 2_000
/** Advances driven by acquires are at most this frequent per computer; the sweep always runs. */
const ADVANCE_THROTTLE_MS = 1_500
/** Activity is written at most this often per computer. */
const TOUCH_THROTTLE_MS = 30_000
/** A reclaim this recent with an error answers the session that asked, rather than starting over. */
const FAILURE_REPORT_MS = 60_000
/** A pool-minted registration token lives this long; it is pushed to the pod at once. */
const REGISTRATION_TTL_MINUTES = 10
export const COMPUTER_POOL_SWEEP_MS = 30_000
/** Orphan claims are looked for every this many sweeps. */
const ORPHAN_SWEEP_EVERY = 10

const isRevoked = (c: ComputerRecord): boolean => c.revokedAt !== null || c.status === 'revoked'
/** A pushed registration is pushed again while this much of its lifetime remains, rather than minting another. */
const REGISTRATION_REUSE_MARGIN_MS = 60_000

/** A console action on a managed computer (§10): done, or why not. */
export type ComputerPoolCommandResult =
  | { ok: true; computer: ComputerRecord }
  | { ok: false; code: 'not_found' | 'not_allowed' | 'in_use' | 'no_pool' | 'volume_missing'; message: string }

const refused = (
  code: Extract<ComputerPoolCommandResult, { ok: false }>['code'],
  message: string
): ComputerPoolCommandResult => ({ ok: false, code, message })

const actionsOf = (c: ComputerRecord) =>
  poolActions({ allocation: c.allocation, poolPhase: c.poolPhase, poolError: c.poolError, revoked: isRevoked(c) })

// The refusal a session sees for a stored pool error; a failed reset is just a failure to it.
const refusalOf = (error: string | null | undefined): ComputerPoolRefusal =>
  poolErrorCode(error) === 'volume_missing' ? 'volume_missing' : 'failed'

const failureKey = (agentId: string, sessionId: string | null): string => `${agentId}\u0000${sessionId ?? ''}`

const ready = (c: ComputerRecord): ComputerPoolAcquireResult => ({
  state: 'ready',
  computerId: c.id,
  ...(c.allocation ? { allocation: c.allocation } : {})
})
const pending = (phase: ComputerPoolPendingPhase, computerId?: string): ComputerPoolAcquireResult => ({
  state: 'pending',
  phase,
  retryAfterMs: COMPUTER_POOL_RETRY_MS,
  ...(computerId ? { computerId } : {})
})
const failed = (code: ComputerPoolRefusal, message: string): ComputerPoolAcquireResult => ({
  state: 'failed',
  code,
  message: message.slice(0, 500)
})

export class ComputerPool {
  private readonly timings: ComputerPoolTimings
  private readonly inflight = new Map<string, Promise<void>>()
  private readonly advancedAt = new Map<string, number>()
  private readonly touchedAt = new Map<string, number>()
  // Why an agent's or session's computer was just reclaimed, told once to the session that asks next.
  private readonly failures = new Map<string, { code: ComputerPoolRefusal; message: string; at: number }>()
  // The registration last pushed to each computer's pod, pushed again until it nears expiry.
  private readonly registrations = new Map<string, { token: string; expiresAt: number }>()
  private timer: TimerHandle | undefined
  private stopped = true
  private sweeps = 0

  constructor(private readonly deps: ComputerPoolDeps) {
    this.timings = { ...DEFAULT_COMPUTER_POOL_TIMINGS, ...deps.timings }
  }

  start(): void {
    this.stopped = false
    this.arm()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** An agent session's managed computer: allocated or woken, ready, or why not (§15.1). */
  async acquire(orgId: OrgId, req: ComputerPoolAcquire): Promise<ComputerPoolAcquireResult> {
    const agent = await this.deps.agents.get(orgId, AgentId(req.agentId))
    if (!agent) return failed('denied', 'unknown agent')
    if (req.computerId) return await this.wakeGranted(orgId, agent, req.computerId, req.sessionId)
    const mode = agent.computerUse?.managed?.mode
    if (!mode) return failed('not_configured', 'this agent has no managed computer setting')
    const key: ManagedComputerKey =
      mode === 'per-agent'
        ? { allocation: 'per-agent', ownerAgentId: agent.id }
        : { allocation: 'ephemeral', ownerAgentId: agent.id, poolSessionId: req.sessionId }
    let row = await this.deps.repo.findManaged(orgId, key)
    // A revoked computer can never come online again, so the agent's is reclaimed and replaced.
    if (row && row.poolPhase !== 'reclaiming' && isRevoked(row)) await this.reclaim(row, null)
    if (row?.poolPhase === 'reclaiming' || (row && isRevoked(row))) row = null
    if (!row) {
      // A computer that just failed answers with its cause once; after that the session gets a fresh one.
      const reported = this.reportFailure(failureKey(agent.id, mode === 'ephemeral' ? req.sessionId : null))
      if (reported) return reported
      if (!this.deps.members.available()) return failed('no_pool', 'no pool member can start a managed computer now')
      row = await this.create(orgId, agent, mode, req.sessionId)
      if (!row) return pending('provisioning')
    }
    return await this.use(row)
  }

  /** A user's `manual` computer, created from the pool (§15.1); null when no pool member can start one. */
  async createManual(
    orgId: OrgId,
    input: { name: string; ownerUserId: string; policy?: ComputerPolicy; agentAccess?: ComputerAgentAccess }
  ): Promise<ComputerRecord | null> {
    if (!this.deps.members.available()) return null
    const row = await this.deps.repo.createManaged({
      id: ComputerId(randomUUID()),
      orgId,
      name: input.name,
      ownerUserId: input.ownerUserId,
      allocation: 'manual',
      policy: managedComputerPolicy(input.ownerUserId, input.policy ?? defaultComputerPolicy(input.ownerUserId)),
      agentAccess: input.agentAccess ?? { mode: 'none', agents: [] },
      now: new Date(this.deps.clock.now())
    })
    if (row) {
      this.kick(row)
      await this.deps.computers.accessGranted(orgId, row)
    }
    return row
  }

  /** Remove a managed computer: its keys go at once, its claim and volume next, then its row. */
  async remove(orgId: OrgId, id: ComputerId, actorUserId?: string): Promise<void> {
    const row = await this.deps.repo.get(orgId, id)
    if (!row) return
    await this.reclaim(row, null, actorUserId)
  }

  /** Whether a pool member that can start, wake or sleep a desktop is connected now. */
  available(): boolean {
    return this.deps.members.available()
  }

  /** The console's Wake: a sleeping or failed `per-agent` or `manual` computer starts toward awake. */
  async wakeNow(orgId: OrgId, id: ComputerId): Promise<ComputerPoolCommandResult> {
    const row = await this.deps.repo.get(orgId, id)
    if (!row) return refused('not_found', 'computer not found')
    if (!actionsOf(row).wake) return refused('not_allowed', 'this computer cannot be woken now')
    if (!this.deps.members.available()) return refused('no_pool', 'no pool member can wake this computer now')
    const result = await this.use(row)
    if (result.state === 'failed' && result.code === 'volume_missing') return refused('volume_missing', result.message)
    return { ok: true, computer: (await this.deps.repo.get(orgId, id)) ?? row }
  }

  /** The console's Sleep: an awake `per-agent` or `manual` computer stops its pod and keeps its volume. */
  async sleepNow(orgId: OrgId, id: ComputerId): Promise<ComputerPoolCommandResult> {
    const row = await this.deps.repo.get(orgId, id)
    if (!row) return refused('not_found', 'computer not found')
    if (!actionsOf(row).sleep) return refused('not_allowed', 'this computer cannot be put to sleep now')
    // A session at work on it keeps it awake; it sleeps by itself once idle.
    if (this.deps.leases && (await this.deps.leases.current(orgId, id)) !== null)
      return refused('in_use', 'an agent holds this computer’s control lease; try again when its turn ends')
    if (!this.deps.members.available()) return refused('no_pool', 'no pool member can put this computer to sleep now')
    const res = await this.deps.members.op(this.ensure(row, false, false))
    if (!res?.ok || !res.state) return refused('no_pool', 'no pool member answered')
    if (res.state.claim === 'missing') {
      await this.volumeMissing(row)
      return refused('volume_missing', 'the computer’s volume is gone, so its files and sign-ins are lost')
    }
    // Fenced on the activity it judged, so a session that started during the stop keeps the desktop.
    const leasedNow = this.deps.leases ? (await this.deps.leases.current(orgId, id).catch(() => null)) !== null : false
    const slept =
      !leasedNow &&
      (await this.deps.repo.setPoolPhase(row.id, {
        phase: 'sleeping',
        at: new Date(this.deps.clock.now()),
        from: ['awake', 'waking'],
        status: 'sleeping',
        error: null,
        activeAt: row.poolActiveAt
      }))
    if (!slept) {
      const now = await this.deps.repo.get(orgId, id)
      if (now?.poolPhase === 'awake' || now?.poolPhase === 'waking')
        await this.deps.members.op(this.ensure(now, true, false)).catch(() => undefined)
      return refused('in_use', 'an agent started using this computer meanwhile; it sleeps by itself once idle')
    }
    this.deps.log?.info({ computerId: row.id }, 'computer-pool: computer put to sleep from the console')
    return { ok: true, computer: (await this.deps.repo.get(orgId, id)) ?? row }
  }

  /** The console's Reset: a `per-agent` or `manual` computer loses its pod and volume and starts again empty. */
  async resetNow(orgId: OrgId, id: ComputerId): Promise<ComputerPoolCommandResult> {
    const row = await this.deps.repo.get(orgId, id)
    if (!row) return refused('not_found', 'computer not found')
    if (!actionsOf(row).reset) return refused('not_allowed', 'this computer cannot be reset now')
    if (!this.deps.members.available()) return refused('no_pool', 'no pool member can reset this computer now')
    const moved = await this.deps.repo.setPoolPhase(row.id, {
      phase: 'resetting',
      at: new Date(this.deps.clock.now()),
      from: ['provisioning', 'registering', 'awake', 'sleeping', 'waking', 'failed'],
      status: 'offline',
      error: null
    })
    if (!moved) return refused('not_allowed', 'this computer changed meanwhile; try again')
    // Whoever held it loses the desktop under them, so the lease ends now rather than at its next input.
    await this.deps.leases?.preempt(orgId, id, 'reset').catch(() => false)
    this.registrations.delete(row.id)
    this.deps.log?.info({ computerId: row.id }, 'computer-pool: resetting a computer from the console')
    const fresh = await this.deps.repo.get(orgId, id)
    if (fresh) this.kick(fresh)
    return { ok: true, computer: fresh ?? row }
  }

  /** A grant, lease or viewer used the computer; idle detection starts over. */
  touch(computerId: string): void {
    void this.markActive(computerId)
  }

  // Written before an acquire answers, so a sweep's idle decision taken earlier no longer matches the row.
  private async markActive(computerId: string): Promise<void> {
    const now = this.deps.clock.now()
    const last = this.touchedAt.get(computerId) ?? 0
    if (now - last < TOUCH_THROTTLE_MS) return
    this.touchedAt.set(computerId, now)
    await this.deps.repo.touchPoolActive(ComputerId(computerId), new Date(now)).catch(() => undefined)
  }

  /** One controller pass over every managed row: timeouts, sleep, reclaim, and claims nobody owns. */
  async sweep(): Promise<void> {
    const now = this.deps.clock.now()
    for (const row of await this.deps.repo.listPool()) {
      try {
        await this.sweepRow(row, now)
      } catch (err) {
        this.deps.log?.warn({ err, computerId: row.id }, 'computer-pool: sweep of a computer failed')
      }
    }
    if (this.sweeps++ % ORPHAN_SWEEP_EVERY === 0) await this.collectOrphans(now)
  }

  private arm(): void {
    if (this.stopped || !this.deps.sweepIntervalMs) return
    this.timer = this.deps.clock.setTimeout(() => void this.tick(), this.deps.sweepIntervalMs)
  }

  private async tick(): Promise<void> {
    this.timer = undefined
    try {
      await this.sweep()
    } catch (err) {
      this.deps.log?.warn({ err }, 'computer-pool: sweep failed')
    } finally {
      this.arm()
    }
  }

  private async sweepRow(row: ComputerRecord, now: number): Promise<void> {
    if (!row.allocation || !row.poolPhase) return
    // An agent's own computers go with the agent.
    if (row.allocation !== 'manual' && row.ownerAgentId && row.poolPhase !== 'reclaiming') {
      if (!(await this.deps.agents.get(row.orgId, AgentId(row.ownerAgentId)))) {
        this.deps.log?.info({ computerId: row.id }, 'computer-pool: reclaiming the computer of a deleted agent')
        return await this.reclaim(row, null)
      }
    }
    if (isRevoked(row) && row.poolPhase !== 'reclaiming') return await this.sweepRevoked(row)
    const status = this.deps.computers.presentedStatus(row)
    // A sleeping pod's last heartbeat may land after the pool put it to sleep; the status follows the phase.
    if (row.poolPhase === 'sleeping' && row.status !== 'sleeping' && !isComputerReachable(status)) {
      await this.deps.repo.setPoolPhase(row.id, {
        phase: 'sleeping',
        at: row.poolPhaseAt ?? new Date(now),
        from: ['sleeping'],
        status: 'sleeping'
      })
    }
    const leaseHeld =
      row.poolPhase === 'awake' && this.deps.leases
        ? (await this.deps.leases.current(row.orgId, row.id).catch(() => null)) !== null
        : false
    const action = sweepAction(
      {
        allocation: row.allocation,
        phase: row.poolPhase,
        phaseAt: row.poolPhaseAt?.getTime() ?? now,
        activeAt: row.poolActiveAt?.getTime() ?? row.createdAt.getTime(),
        status,
        lastSeenAt: row.lastSeenAt?.getTime() ?? null
      },
      leaseHeld,
      now,
      this.timings
    )
    switch (action.kind) {
      case 'none':
        return
      case 'advance':
        return await this.advance(row, true)
      case 'sleep':
        return await this.sleep(row)
      case 'reclaim':
        this.deps.log?.info({ computerId: row.id, reason: action.reason }, 'computer-pool: reclaiming an idle computer')
        return await this.reclaim(row, null, undefined, true)
      case 'timeout':
        if (row.poolPhase === 'waking') return await this.wakeFailed(row, action.message)
        if (row.poolPhase === 'resetting') return await this.resetFailed(row, action.message)
        return await this.provisionFailed(row, action.message)
    }
  }

  // A revoked agent's computer goes; a revoked manual one keeps its volume, its pod stopped, until its user deletes it.
  private async sweepRevoked(row: ComputerRecord): Promise<void> {
    if (row.allocation !== 'manual') return await this.reclaim(row, null)
    if (row.poolPhase === 'sleeping' || row.poolPhase === 'failed') return
    if (row.poolPhase === 'resetting') return await this.finishRevokedReset(row)
    const res = await this.deps.members.op(this.ensure(row, false, false))
    if (!res?.ok) return
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'sleeping',
      at: new Date(this.deps.clock.now()),
      from: ['provisioning', 'registering', 'awake', 'waking']
    })
  }

  // A reset revoked midway still finishes its delete, then parks failed: a revoked computer is never provisioned again.
  private async finishRevokedReset(row: ComputerRecord): Promise<void> {
    const res = await this.deps.members.op({ op: 'delete', computerId: row.id })
    const gone = res?.ok === true && res.state !== undefined && res.state.claim !== 'present'
    const overdue = this.deps.clock.now() - (row.poolPhaseAt?.getTime() ?? 0) > this.timings.provisionTimeoutMs
    if (!gone && !overdue) return
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'failed',
      at: new Date(this.deps.clock.now()),
      from: ['resetting'],
      error: poolError(
        'reset_failed',
        gone
          ? 'the computer was revoked during a reset'
          : 'the computer was revoked and its old desktop was not removed'
      )
    })
  }

  // Creates the agent's or session's computer; null when a concurrent acquire made it first.
  private async create(
    orgId: OrgId,
    agent: AgentRecord,
    mode: ComputerManagedMode,
    sessionId: string
  ): Promise<ComputerRecord | null> {
    const owner = agent.createdByUserId ?? (await this.deps.repo.orgOwnerUserId(orgId))
    if (!owner) return null
    const key: ManagedComputerKey =
      mode === 'per-agent'
        ? { allocation: 'per-agent', ownerAgentId: agent.id }
        : { allocation: 'ephemeral', ownerAgentId: agent.id, poolSessionId: sessionId }
    const created = await this.deps.repo.createManaged({
      id: ComputerId(randomUUID()),
      orgId,
      name: managedComputerName(mode, agent.displayName ?? agent.name),
      ownerUserId: owner,
      allocation: mode,
      ownerAgentId: agent.id,
      ...(mode === 'ephemeral' ? { poolSessionId: sessionId } : {}),
      policy: managedComputerPolicy(owner),
      // Implicitly Selected for the one agent it was made for (§15.1).
      agentAccess: { mode: 'selected', agents: [agent.id] },
      now: new Date(this.deps.clock.now())
    })
    if (created) {
      this.deps.log?.info(
        { computerId: created.id, agentId: agent.id, allocation: mode },
        'computer-pool: allocating a managed computer'
      )
      return created
    }
    const raced = await this.deps.repo.findManaged(orgId, key)
    return raced && raced.poolPhase !== 'reclaiming' ? raced : null
  }

  // A granted Computer named explicitly: a managed one is woken, a self-hosted one is just ready.
  private async wakeGranted(
    orgId: OrgId,
    agent: AgentRecord,
    computerId: string,
    sessionId: string
  ): Promise<ComputerPoolAcquireResult> {
    const c = await this.deps.repo.get(orgId, ComputerId(computerId))
    if (!c || !computerGrantsAgent(c, agent.id)) return failed('denied', 'this agent is not granted this computer')
    if (c.kind !== 'managed' || !c.poolPhase) return ready(c)
    if (c.poolSessionId && c.poolSessionId !== sessionId)
      return failed('denied', 'this computer belongs to another session')
    if (c.poolPhase === 'reclaiming') return failed('failed', 'this computer is being removed')
    if (isRevoked(c)) return failed('failed', 'this computer is revoked')
    return await this.use(c)
  }

  // Bring a found row toward ready and say where it stands.
  private async use(row: ComputerRecord): Promise<ComputerPoolAcquireResult> {
    await this.markActive(row.id)
    const now = new Date(this.deps.clock.now())
    if (row.poolPhase === 'awake' && isComputerReachable(this.deps.computers.presentedStatus(row))) return ready(row)
    if (row.poolPhase === 'sleeping' || row.poolPhase === 'awake') {
      if (!this.deps.members.available()) return failed('no_pool', 'no pool member can wake this computer now')
      await this.deps.repo.setPoolPhase(row.id, { phase: 'waking', at: now, from: [row.poolPhase], error: null })
    } else if (row.poolPhase === 'failed') {
      // Waking now would bring back a lost volume's empty disk, or the old desktop a reset did not remove.
      if (poolNeedsReset(row.poolError))
        return failed(
          refusalOf(row.poolError),
          poolErrorMessage(row.poolError ?? 'failed: this computer needs a reset')
        )
      await this.deps.repo.setPoolPhase(row.id, { phase: 'provisioning', at: now, from: ['failed'], error: null })
    }
    const fresh = await this.deps.repo.get(row.orgId, row.id)
    if (fresh) await this.advance(fresh, false)
    const after = await this.deps.repo.get(row.orgId, row.id)
    if (!after)
      return (
        (row.ownerAgentId ? this.reportFailure(failureKey(row.ownerAgentId, row.poolSessionId)) : undefined) ??
        failed('failed', 'this computer was removed')
      )
    return this.answer(after)
  }

  private answer(c: ComputerRecord): ComputerPoolAcquireResult {
    const reachable = isComputerReachable(this.deps.computers.presentedStatus(c))
    switch (c.poolPhase) {
      case 'awake':
        return reachable ? ready(c) : pending('connecting', c.id)
      case 'provisioning':
        return pending('provisioning', c.id)
      case 'registering':
        return pending('registering', c.id)
      case 'waking':
        return pending('waking', c.id)
      case 'resetting':
        return pending('provisioning', c.id)
      case 'sleeping':
        return failed('failed', c.poolError ? poolErrorMessage(c.poolError) : 'this computer is asleep')
      case 'failed':
      case 'reclaiming':
        return failed(
          refusalOf(c.poolError),
          c.poolError ? poolErrorMessage(c.poolError) : 'this computer is being removed'
        )
      default:
        return reachable ? ready(c) : failed('failed', 'this computer is not managed by the pool')
    }
  }

  private kick(row: ComputerRecord): void {
    void this.advance(row, false).catch((err) =>
      this.deps.log?.warn({ err, computerId: row.id }, 'computer-pool: advancing a computer failed')
    )
  }

  // One step toward the phase's goal; single-flight per computer, throttled unless the sweep drives it.
  private async advance(row: ComputerRecord, force: boolean): Promise<void> {
    const running = this.inflight.get(row.id)
    if (running) return await running
    const now = this.deps.clock.now()
    const throttle = this.deps.advanceThrottleMs ?? ADVANCE_THROTTLE_MS
    if (!force && now - (this.advancedAt.get(row.id) ?? 0) < throttle) return
    this.advancedAt.set(row.id, now)
    const step = this.step(row).finally(() => this.inflight.delete(row.id))
    this.inflight.set(row.id, step)
    await step
  }

  private async step(row: ComputerRecord): Promise<void> {
    switch (row.poolPhase) {
      case 'provisioning':
      case 'registering':
        return await this.provision(row)
      case 'waking':
        return await this.wake(row)
      case 'awake':
        // Only the sweep advances an awake row: its pod went away, so it is started again.
        if (!isComputerReachable(this.deps.computers.presentedStatus(row)))
          await this.deps.repo.setPoolPhase(row.id, {
            phase: 'waking',
            at: new Date(this.deps.clock.now()),
            from: ['awake']
          })
        return
      case 'reclaiming':
        return await this.finishReclaim(row)
      case 'resetting':
        return await this.finishReset(row)
      default:
        return
    }
  }

  // The old claim and its volume go first; once they are gone the computer is provisioned like a new one.
  private async finishReset(row: ComputerRecord): Promise<void> {
    const current = await this.deps.repo.getUnscoped(row.id)
    if (current && isRevoked(current)) return await this.finishRevokedReset(current)
    const res = await this.deps.members.op({ op: 'delete', computerId: row.id })
    if (!res?.ok || !res.state || res.state.claim === 'present') return
    const moved = await this.deps.repo.setPoolPhase(row.id, {
      phase: 'provisioning',
      at: new Date(this.deps.clock.now()),
      from: ['resetting'],
      status: 'offline'
    })
    const fresh = moved ? await this.deps.repo.getUnscoped(row.id) : null
    if (fresh) await this.provision(fresh)
  }

  private ensure(row: ComputerRecord, running: boolean, create: boolean): Extract<ComputerPoolOp, { op: 'ensure' }> {
    return { op: 'ensure', computerId: row.id, allocation: row.allocation!, running, create }
  }

  private async provision(row: ComputerRecord): Promise<void> {
    const res = await this.deps.members.op(this.ensure(row, true, true))
    if (!res?.ok) return
    const next = provisionStep(res.state, row.id)
    if (next.kind === 'wait') return
    if (next.kind === 'fail') return await this.provisionFailed(row, next.message)
    if (next.kind === 'register') {
      const pushed = await this.deps.members.op({
        ...this.ensure(row, true, true),
        registration: { token: await this.registrationToken(row), name: row.name }
      })
      const after = provisionStep(pushed?.state, row.id)
      if (after.kind === 'fail') return await this.provisionFailed(row, after.message)
      if (after.kind !== 'registered') return
    }
    this.registrations.delete(row.id)
    const fresh = await this.deps.repo.getUnscoped(row.id)
    const now = new Date(this.deps.clock.now())
    if (fresh && isComputerReachable(this.deps.computers.presentedStatus(fresh))) {
      await this.deps.repo.setPoolPhase(row.id, {
        phase: 'awake',
        at: now,
        from: ['provisioning', 'registering'],
        error: null
      })
      this.deps.log?.info({ computerId: row.id }, 'computer-pool: managed computer is online')
    } else if (row.poolPhase === 'provisioning') {
      await this.deps.repo.setPoolPhase(row.id, { phase: 'registering', at: now, from: ['provisioning'] })
    }
  }

  // One token per computer until it nears expiry, so a pod that keeps failing to register does not mint one per pass.
  private async registrationToken(row: ComputerRecord): Promise<string> {
    const now = this.deps.clock.now()
    const held = this.registrations.get(row.id)
    if (held && held.expiresAt - now > REGISTRATION_REUSE_MARGIN_MS) return held.token
    const issued = await this.deps.computers.createRegistration({
      orgId: row.orgId,
      createdByUserId: row.ownerUserId,
      name: row.name,
      ttlMinutes: REGISTRATION_TTL_MINUTES,
      computerId: row.id
    })
    this.registrations.set(row.id, { token: issued.token, expiresAt: issued.registration.expiresAt.getTime() })
    return issued.token
  }

  private async wake(row: ComputerRecord): Promise<void> {
    const res = await this.deps.members.op(this.ensure(row, true, false))
    if (!res?.ok || !res.state) return
    if (res.state.claim === 'missing') return await this.volumeMissing(row)
    if (res.state.pod === 'failed')
      return await this.wakeFailed(
        row,
        `the desktop pod cannot start${res.state.detail ? `: ${res.state.detail}` : ''}`
      )
    const fresh = await this.deps.repo.getUnscoped(row.id)
    if (fresh && isComputerReachable(this.deps.computers.presentedStatus(fresh))) {
      await this.deps.repo.setPoolPhase(row.id, {
        phase: 'awake',
        at: new Date(this.deps.clock.now()),
        from: ['waking'],
        error: null
      })
      this.deps.log?.info({ computerId: row.id }, 'computer-pool: managed computer woke')
    }
  }

  private async sleep(row: ComputerRecord): Promise<void> {
    // A use since the sweep's snapshot keeps it awake.
    const current = await this.deps.repo.getUnscoped(row.id)
    if (current?.poolActiveAt?.getTime() !== row.poolActiveAt?.getTime()) return
    const res = await this.deps.members.op(this.ensure(row, false, false))
    if (!res?.ok || !res.state) return
    if (res.state.claim === 'missing') return await this.volumeMissing(row)
    if (res.state.pod !== 'suspended' && res.state.pod !== 'none') return
    const slept = await this.deps.repo.setPoolPhase(row.id, {
      phase: 'sleeping',
      at: new Date(this.deps.clock.now()),
      from: ['awake'],
      status: 'sleeping',
      activeAt: row.poolActiveAt
    })
    if (slept) this.deps.log?.info({ computerId: row.id }, 'computer-pool: idle computer is asleep')
  }

  // Never came up: an agent's computer is replaced by a fresh one next time; a user's stays, failed, for them to see.
  private async provisionFailed(row: ComputerRecord, message: string): Promise<void> {
    this.deps.log?.warn({ computerId: row.id, message }, 'computer-pool: managed computer failed to start')
    if (row.allocation !== 'manual') return await this.reclaim(row, poolError('failed', message))
    await this.deps.members.op(this.ensure(row, false, false)).catch(() => undefined)
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'failed',
      at: new Date(this.deps.clock.now()),
      from: ['provisioning', 'registering'],
      error: poolError('failed', message)
    })
  }

  // The old desktop outlived its reset: waking now would bring its files back, so only another reset is offered.
  private async resetFailed(row: ComputerRecord, message: string): Promise<void> {
    this.deps.log?.warn({ computerId: row.id, message }, 'computer-pool: managed computer reset did not finish')
    if (row.allocation !== 'manual') return await this.reclaim(row, poolError('failed', message))
    await this.deps.members.op(this.ensure(row, false, false)).catch(() => undefined)
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'failed',
      at: new Date(this.deps.clock.now()),
      from: ['resetting'],
      error: poolError('reset_failed', message)
    })
  }

  // A wake that did not finish puts the pod back to sleep; the next use tries again.
  private async wakeFailed(row: ComputerRecord, message: string): Promise<void> {
    this.deps.log?.warn({ computerId: row.id, message }, 'computer-pool: managed computer failed to wake')
    await this.deps.members.op(this.ensure(row, false, false)).catch(() => undefined)
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'sleeping',
      at: new Date(this.deps.clock.now()),
      from: ['waking'],
      error: poolError('failed', message),
      status: 'sleeping'
    })
  }

  // Its claim, and the volume with it, is gone: a per-agent computer starts over; a manual one waits for its user.
  private async volumeMissing(row: ComputerRecord): Promise<void> {
    const message = 'the computer’s volume is gone, so its files and sign-ins are lost'
    this.deps.log?.warn({ computerId: row.id }, 'computer-pool: managed computer lost its volume')
    if (row.allocation !== 'manual') return await this.reclaim(row, poolError('volume_missing', message))
    await this.deps.repo.setPoolPhase(row.id, {
      phase: 'failed',
      at: new Date(this.deps.clock.now()),
      error: poolError('volume_missing', message),
      status: 'offline'
    })
  }

  private reportFailure(key: string): ComputerPoolAcquireResult | undefined {
    const failure = this.failures.get(key)
    if (!failure) return undefined
    this.failures.delete(key)
    return this.deps.clock.now() - failure.at < FAILURE_REPORT_MS ? failed(failure.code, failure.message) : undefined
  }

  // An idle reclaim is fenced on the activity it judged, so an acquire in between keeps the computer.
  private async reclaim(row: ComputerRecord, error: string | null, actorUserId?: string, idle = false): Promise<void> {
    const phases: ComputerPoolPhase[] = [
      'provisioning',
      'registering',
      'awake',
      'sleeping',
      'waking',
      'failed',
      'resetting'
    ]
    const moved = await this.deps.repo.setPoolPhase(row.id, {
      phase: 'reclaiming',
      at: new Date(this.deps.clock.now()),
      from: phases,
      ...(error ? { error } : {}),
      ...(idle ? { activeAt: row.poolActiveAt } : {})
    })
    if (!moved && (idle || row.poolPhase !== 'reclaiming')) return
    if (error && row.ownerAgentId && row.allocation !== 'manual') {
      this.failures.set(failureKey(row.ownerAgentId, row.poolSessionId), {
        code: refusalOf(error),
        message: poolErrorMessage(error),
        at: this.deps.clock.now()
      })
    }
    // Revoking first stops the desktop and ends its lease before its pod and volume go.
    if (row.status !== 'revoked') await this.deps.computers.revoke(row.orgId, row.id, actorUserId)
    const fresh = await this.deps.repo.getUnscoped(row.id)
    if (fresh) await this.finishReclaim(fresh, actorUserId)
  }

  private async finishReclaim(row: ComputerRecord, actorUserId?: string): Promise<void> {
    const res = await this.deps.members.op({ op: 'delete', computerId: row.id })
    if (!res?.ok || !res.state || res.state.claim === 'present') return
    // The row goes last, so a claim never outlives the record that would find it again.
    try {
      await this.deps.computers.delete(row.orgId, row.id, actorUserId)
    } catch (err) {
      if ((err as { code?: unknown })?.code !== 'P2025') throw err
    }
    this.advancedAt.delete(row.id)
    this.touchedAt.delete(row.id)
    this.registrations.delete(row.id)
    this.deps.log?.info({ computerId: row.id }, 'computer-pool: managed computer reclaimed')
  }

  // Desktop claims whose Computer row is gone (a crash between the two deletes) are deleted once old enough.
  private async collectOrphans(now: number): Promise<void> {
    if (!this.deps.members.available()) return
    const res = await this.deps.members.op({ op: 'list' })
    if (!res?.ok) return
    for (const claim of res.claims ?? []) {
      const created = claim.createdAt ? Date.parse(claim.createdAt) : Number.NaN
      if (!Number.isFinite(created) || now - created < this.timings.orphanGraceMs) continue
      if (await this.deps.repo.getUnscoped(ComputerId(claim.computerId))) continue
      this.deps.log?.info({ computerId: claim.computerId }, 'computer-pool: deleting an orphaned desktop claim')
      await this.deps.members.op({ op: 'delete', computerId: claim.computerId })
    }
  }
}
