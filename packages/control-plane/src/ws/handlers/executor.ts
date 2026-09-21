// The executor requests (session-executors.md §6, §7): facts a holder pulls at session birth, and the prepare and release the CP relays. Placement stays the holder's; the CP ranks nothing.
import {
  EXECUTOR_PREPARE_RELAY_BUDGET_MS,
  ExecutorPrepareResult,
  ExecutorReleaseResult,
  SESSION_EXECUTORS_V1_FEATURE,
  isFrame,
  type ExecutorCandidate,
  type ExecutorCandidatesResult,
  type ExecutorFacts,
  type ExecutorPrepareRefusal,
  type ExecutorPrepareReq,
  type ExecutorReleaseRefusal,
  type ExecutorReleaseReq
} from '@agentconnect.md/protocol'
import { AgentId, DaemonId, type OrgId } from '../../domain/ids.js'
import { ProtocolError } from '../../domain/errors.js'
import { dutyEligibility } from '../../domain/placement.js'
import { parseSessionKey } from '../../domain/sessionKey.js'
import type { DaemonWsDeps } from '../deps.js'
import { ConnectionClosed, type DaemonConnState } from '../registry.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

/** The gates every executor request shares: the asker holds the agent's duty, and the agent is placed on a group. The group's switch is the caller's to read. */
async function heldSet(
  deps: DaemonWsDeps,
  orgId: OrgId,
  holder: DaemonId,
  agentId: AgentId
): Promise<{ setId: string; spreads: boolean } | { refused: 'not_holder' | 'not_on_group' }> {
  // Fenced on the frame's org; an unknown agent and one the asker does not hold answer alike.
  const agent = await deps.agent.get(orgId, agentId)
  if (!agent || !(await deps.dutyLease.holdsAgent(holder, agentId))) return { refused: 'not_holder' }
  const eligibility = dutyEligibility(agent)
  if (eligibility.scope !== 'set') return { refused: 'not_on_group' }
  const set = await deps.memberSets.get(eligibility.setId)
  return set ? { setId: set.id, spreads: set.spreadSessions } : { refused: 'not_on_group' }
}

/** A member's executor facts when it could host right now: connected and READY, speaking these frames, facet on. */
function sharingFacts(state: DaemonConnState | undefined): ExecutorFacts | undefined {
  if (!state?.reachable || state.state !== 'READY') return undefined
  const capabilities = state.capabilities
  if (!capabilities?.features.includes(SESSION_EXECUTORS_V1_FEATURE)) return undefined
  return capabilities.executor?.enabled ? capabilities.executor : undefined
}

export const handleExecutorCandidates: Handler = async (frame, conn, deps) => {
  if (!isFrame('executor/candidates')(frame)) return
  const reply = (result: ExecutorCandidatesResult): void => conn.replyTo(frame, 'executor/candidates/result', result)
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const agentId = AgentId(frame.payload.agentId)
  const gate = await heldSet(deps, orgId, DaemonId(conn.daemonId), agentId)
  if ('refused' in gate) return reply({ candidates: [], reason: gate.refused })
  if (!gate.spreads) return reply({ candidates: [], reason: 'group_switch_off' })

  // A HINT for a successor holder, from the CP's own session row: where this session last ran (§7). Stale is harmless — a prepare there attaches or creates.
  const asked = frame.payload.sessionKey
  const current = asked ? await deps.session.executorForKey(agentId, parseSessionKey(asked)) : null

  const candidates: ExecutorCandidate[] = []
  for (const daemonId of await deps.memberSets.memberIdsOf(gate.setId)) {
    // The asker is always its own candidate and knows its own load; the list is the OTHER members.
    if (daemonId === conn.daemonId) continue
    const facts = sharingFacts(deps.connReg.get(daemonId))
    if (!facts) continue
    const member = await deps.registry.getAvailable(orgId, DaemonId(daemonId))
    if (!member) continue
    candidates.push({
      daemonId,
      strategies: facts.strategies ?? {},
      ...(facts.endpoint ? { endpoint: facts.endpoint } : {}),
      ...(facts.capacity !== undefined ? { capacity: facts.capacity } : {}),
      ...(member.hostedSessions !== null ? { hostedSessions: member.hostedSessions } : {}),
      runtimes: member.runtimeProfiles.map((p) => ({ runtime: p.runtime, authRequired: p.authRequired }))
    })
  }
  reply({
    candidates,
    ...(candidates.length === 0 ? { reason: 'no_member_shares' as const } : {}),
    ...(current ? { currentExecutorDaemonId: current } : {})
  })
}

/** The CP's own record of an executor it cannot reach, for the holder's lazy loss rule (§7). */
async function offline(
  deps: DaemonWsDeps,
  orgId: OrgId,
  executorId: DaemonId
): Promise<{ status: 'offline'; lastSeenAt: string | null }> {
  const executor = await deps.registry.getAvailable(orgId, executorId)
  return { status: 'offline', lastSeenAt: executor?.lastSeenAt?.toISOString() ?? null }
}

/** Relay one launch's prepare, single-flight: both correlators resend, and a resend must join the relay in flight rather than open a second that could answer differently. */
function relayPrepare(
  deps: DaemonWsDeps,
  orgId: OrgId,
  holderId: string,
  executor: DaemonConnState,
  req: ExecutorPrepareReq
): Promise<ExecutorPrepareResult> {
  const inFlight = (executor.executorPrepares ??= new Map())
  const launch = JSON.stringify([holderId, req.agentId, req.sessionKey, req.launchId])
  const joined = inFlight.get(launch)
  if (joined) return joined
  const run = (async (): Promise<ExecutorPrepareResult> => {
    try {
      // Single-shot with a long window: the payload, launch id included, goes out once and verbatim.
      const answer = await executor.conn.request(
        'executor/prepare',
        req,
        { epoch: executor.sessionEpoch },
        { maxTries: 1, ackTimeoutMs: EXECUTOR_PREPARE_RELAY_BUDGET_MS },
        orgId
      )
      const result = ExecutorPrepareResult.safeParse(answer)
      if (!result.success) return { status: 'refused', reason: 'relay_failed' }
      const live = result.data.status === 'ready' || result.data.status === 'full' ? result.data.liveCount : undefined
      // Fresher than the next heartbeat, and advisory: a failed write must not cost the holder its reply.
      if (live !== undefined)
        await deps.registry.recordHostedSessions(DaemonId(executor.daemonId), live).catch(() => {})
      return result.data
    } catch (err) {
      // The control connection dropped mid-flight: the same answer as finding it down.
      if (err instanceof ConnectionClosed) return offline(deps, orgId, DaemonId(executor.daemonId))
      // Ids and an error code only — never the payload, which on another path carries a key.
      deps.log.error(
        {
          daemonId: holderId,
          executorDaemonId: executor.daemonId,
          agentId: req.agentId,
          code: err instanceof ProtocolError ? err.code : 'unknown'
        },
        'executor/prepare: relay failed'
      )
      return { status: 'refused', reason: 'relay_failed' }
    }
  })().finally(() => {
    if (inFlight.get(launch) === run) inFlight.delete(launch)
  })
  inFlight.set(launch, run)
  return run
}

export const handleExecutorPrepare: Handler = async (frame, conn, deps) => {
  if (!isFrame('executor/prepare')(frame)) return
  // NEVER log `result`: its `ready` arm carries the pipe's pre-shared key.
  const reply = (result: ExecutorPrepareResult): void => conn.replyTo(frame, 'executor/prepare/result', result)
  const refuse = (reason: ExecutorPrepareRefusal): void => reply({ status: 'refused', reason })
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const req = frame.payload
  const holder = DaemonId(conn.daemonId)
  const agentId = AgentId(req.agentId)
  const executorId = DaemonId(req.executorDaemonId)

  const gate = await heldSet(deps, orgId, holder, agentId)
  if ('refused' in gate) return refuse(gate.refused)
  if (!gate.spreads) return refuse('group_switch_off')
  if ((await deps.memberSets.setIdOf(executorId)) !== gate.setId) return refuse('not_member')

  const executor = deps.connReg.get(executorId)
  if (!executor?.reachable || (executor.state !== 'READY' && executor.state !== 'DRAINING')) {
    return reply(await offline(deps, orgId, executorId))
  }
  if (executor.state === 'DRAINING') return refuse('draining')
  if (!sharingFacts(executor)) return refuse('facet_off')

  // The ordering argument (§6). This is the LAST duty read, and `relayPrepare` reaches `conn.request` — which encodes and
  // writes before it awaits — without yielding, so nothing can run between the two. Every relay to one executor leaves over
  // that executor's single control connection, so arrival order is send order: a holder authorized before the duty moved is
  // always on the wire ahead of one authorized after. Keep these two statements adjacent; an await between them is the bug.
  if (!(await deps.dutyLease.holdsAgent(holder, agentId))) return refuse('not_holder')
  const relayed = relayPrepare(deps, orgId, conn.daemonId, executor, req)

  const result = await relayed
  // The duty may have moved while the executor prepared: a deposed holder is refused and never sees the key, and its successor's new launch rotates it.
  if (!(await deps.dutyLease.holdsAgent(holder, agentId))) return refuse('not_holder')
  reply(result)
}

/** Relay one release. The executor answers `unknown` for an environment it does not have, so a resend needs no single flight. */
async function relayRelease(
  deps: DaemonWsDeps,
  orgId: OrgId,
  holderId: string,
  executor: DaemonConnState,
  req: ExecutorReleaseReq
): Promise<ExecutorReleaseResult> {
  try {
    const answer = await executor.conn.request(
      'executor/release',
      req,
      { epoch: executor.sessionEpoch },
      { maxTries: 1, ackTimeoutMs: EXECUTOR_PREPARE_RELAY_BUDGET_MS },
      orgId
    )
    const result = ExecutorReleaseResult.safeParse(answer)
    return result.success ? result.data : { status: 'refused', reason: 'relay_failed' }
  } catch (err) {
    if (err instanceof ConnectionClosed) return offline(deps, orgId, DaemonId(executor.daemonId))
    deps.log.error(
      {
        daemonId: holderId,
        executorDaemonId: executor.daemonId,
        agentId: req.agentId,
        code: err instanceof ProtocolError ? err.code : 'unknown'
      },
      'executor/release: relay failed'
    )
    return { status: 'refused', reason: 'relay_failed' }
  }
}

export const handleExecutorRelease: Handler = async (frame, conn, deps) => {
  if (!isFrame('executor/release')(frame)) return
  const reply = (result: ExecutorReleaseResult): void => conn.replyTo(frame, 'executor/release/result', result)
  const refuse = (reason: ExecutorReleaseRefusal): void => reply({ status: 'refused', reason })
  const orgId = frameOrgId(frame, conn)
  if (!orgId) {
    conn.sendError(frame.id, 'SCOPE_DENIED', 'organization is required', false)
    return
  }
  const req = frame.payload
  const holder = DaemonId(conn.daemonId)
  const agentId = AgentId(req.agentId)
  const executorId = DaemonId(req.executorDaemonId)

  // Neither consent gates a release: a machine whose owner withdrew `sandbox.share` and a group whose switch went off must still let a holder clean up (§7).
  const gate = await heldSet(deps, orgId, holder, agentId)
  if ('refused' in gate) return refuse(gate.refused)
  if ((await deps.memberSets.setIdOf(executorId)) !== gate.setId) return refuse('not_member')

  const executor = deps.connReg.get(executorId)
  // A draining executor still accepts one: it is cleanup, and its environments outlive the process anyway.
  if (!executor?.reachable || (executor.state !== 'READY' && executor.state !== 'DRAINING')) {
    return reply(await offline(deps, orgId, executorId))
  }

  // The same adjacency as `prepare`, for the same reason: a deposed holder's release must never arrive ahead of its successor's
  // prepare. There is no re-check afterwards — by then the environment is gone, so ordering is the whole guarantee.
  if (!(await deps.dutyLease.holdsAgent(holder, agentId))) return refuse('not_holder')
  const relayed = relayRelease(deps, orgId, conn.daemonId, executor, req)

  reply(await relayed)
}
