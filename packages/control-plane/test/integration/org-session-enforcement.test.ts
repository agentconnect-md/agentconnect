// Enforcing the monthly session limit at admission, on milestones and on session grants (org-session-policy.md, Enforcement).
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import type { AnyFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEF_ORG, seedAgent, seedDaemon } from '../fixtures/seed.js'
import { PgSessionRepo } from '../../src/persistence/repositories/session.repo.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import { PgAgentRepo } from '../../src/persistence/index.js'
import { AgentId, SessionId } from '../../src/domain/ids.js'
import { handleComputerChannelGrant } from '../../src/ws/handlers/computer-channel.js'
import { handleComputerPoolAcquire } from '../../src/ws/handlers/computer-pool.js'
import { handleComputerLeaseAcquire } from '../../src/ws/handlers/computer-lease.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const COMPUTER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function ev(sessionId: string, agentId: string = AGENT) {
  return {
    sessionId: SessionId(sessionId),
    agentId: AgentId(agentId),
    phase: 'start' as const,
    platform: 'slack' as const,
    channel: 'C1',
    thread: sessionId,
    at: new Date()
  }
}

async function used(orgId: string = DEF_ORG): Promise<number> {
  const rows = await prisma.orgSessionMonth.findMany({ where: { orgId } })
  return rows.reduce((sum, row) => sum + row.used, 0)
}

async function nextMonthStart(): Promise<Date> {
  const rows = await prisma.$queryRaw<Array<{ m: Date }>>`
    SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' AS "m"`
  return rows[0]!.m
}

let revision = 0
async function policy(monthlySessionLimit: number | null, enforce: boolean): Promise<void> {
  revision += 1
  await new PgOrgSessionPolicyRepo(prisma).apply(DEF_ORG, {
    revision,
    monthlySessionLimit,
    historyRetentionDays: null,
    enforce
  })
}

const policies = (enforcement = true) => new PgOrgSessionPolicyRepo(prisma, { enforcement })
const sessions = (enforcement = true) => new PgSessionRepo(prisma, { enforcement })
const admit = (sessionId: string, agentId: string = AGENT, enforcement = true) =>
  policies(enforcement).admit(DEF_ORG, agentId, sessionId)

describe('admission under an enforced monthly session limit', () => {
  it('admits up to the limit, then refuses with the count, the limit and the next reset', async () => {
    await seedAgent(prisma, AGENT)
    await policy(2, true)
    expect(await admit('s-1')).toEqual({ admitted: true, counted: true, enforcing: true })
    expect(await admit('s-2')).toEqual({ admitted: true, counted: true, enforcing: true })
    expect(await admit('s-3')).toEqual({
      admitted: false,
      conflict: 'session_limit_reached',
      limit: 2,
      used: 2,
      resetsAt: await nextMonthStart()
    })
    expect(await used()).toBe(2)
    expect(await prisma.orgSessionAdmission.count({ where: { sessionId: 's-3' } })).toBe(0)
  })

  it('answers a re-sent admit of an admitted id the same at the limit, and re-judges a refused one', async () => {
    await seedAgent(prisma, AGENT)
    await policy(1, true)
    expect(await admit('s-1')).toMatchObject({ admitted: true, counted: true })
    expect(await admit('s-1')).toEqual({ admitted: true, counted: true, enforcing: true })
    expect(await admit('s-2')).toMatchObject({ admitted: false, conflict: 'session_limit_reached' })
    await policy(2, true)
    expect(await admit('s-2')).toEqual({ admitted: true, counted: true, enforcing: true })
    expect(await used()).toBe(2)
  })

  it('admits exactly one of concurrent new sessions racing for the last slot', async () => {
    await seedAgent(prisma, AGENT)
    await policy(3, true)
    await admit('s-1')
    await admit('s-2')
    const results = await Promise.all(['r-a', 'r-b', 'r-c', 'r-d'].map((id) => admit(id)))
    expect(results.filter((r) => r.admitted)).toHaveLength(1)
    expect(results.filter((r) => !r.admitted)).toHaveLength(3)
    expect(await used()).toBe(3)
    expect(await prisma.orgSessionAdmission.count()).toBe(3)
  })

  it('refuses every new session at a limit of zero', async () => {
    await seedAgent(prisma, AGENT)
    await policy(0, true)
    expect(await admit('s-1')).toMatchObject({ admitted: false, limit: 0, used: 0 })
    expect(await used()).toBe(0)
  })

  it('still admits a session the CP already recorded, and exempt maintenance, at the limit', async () => {
    await seedAgent(prisma, AGENT)
    await sessions().recordMilestone(ev('s-old'))
    await policy(1, true)
    expect(await admit('s-old')).toEqual({ admitted: true, counted: false, enforcing: true })
    expect(await policies().admit(DEF_ORG, AGENT, 's-dream', 'memory-dream')).toEqual({
      admitted: true,
      counted: false,
      enforcing: true
    })
    expect(await used()).toBe(1)
  })

  it('refuses an id another agent holds before it consults the limit', async () => {
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, OTHER_AGENT)
    await policy(5, true)
    await admit('s-1')
    expect(await admit('s-1', OTHER_AGENT)).toEqual({ admitted: false, conflict: 'other_agent' })
  })

  it('counts past the limit without refusing when the policy does not enforce, or enforces no limit', async () => {
    await seedAgent(prisma, AGENT)
    await policy(1, false)
    expect(await admit('s-1')).toEqual({ admitted: true, counted: true, enforcing: false })
    expect(await admit('s-2')).toEqual({ admitted: true, counted: true, enforcing: false })
    await policy(null, true)
    expect(await admit('s-3')).toEqual({ admitted: true, counted: true, enforcing: false })
    expect(await used()).toBe(3)
  })

  it('counts only, and accurately past the limit, while the install switch is off', async () => {
    await seedAgent(prisma, AGENT)
    await policy(1, true)
    expect(await admit('s-1', AGENT, false)).toEqual({ admitted: true, counted: true, enforcing: false })
    expect(await admit('s-2', AGENT, false)).toEqual({ admitted: true, counted: true, enforcing: false })
    expect(await used()).toBe(2)
    expect((await policies(false).monthUsage(DEF_ORG))?.enforcing).toBe(false)
    expect((await policies(true).monthUsage(DEF_ORG))?.enforcing).toBe(true)
    // Switched back on, the org is already past its limit and refuses the next session.
    expect(await admit('s-3')).toMatchObject({ admitted: false, used: 2, limit: 1 })
  })

  it('reports enforcement only for an enforced, non-null limit', async () => {
    await seedAgent(prisma, AGENT)
    expect((await policies().monthUsage(DEF_ORG))?.enforcing).toBe(false)
    await policy(10, false)
    expect((await policies().monthUsage(DEF_ORG))?.enforcing).toBe(false)
    await policy(null, true)
    expect((await policies().monthUsage(DEF_ORG))?.enforcing).toBe(false)
    await policy(10, true)
    expect((await policies().monthUsage(DEF_ORG))?.enforcing).toBe(true)
  })
})

describe('milestones under an enforced monthly session limit', () => {
  it('admits a never-admitted id below the limit at its first milestone, counting it once', async () => {
    await seedAgent(prisma, AGENT)
    await policy(10, true)
    expect((await sessions().recordMilestone(ev('s-late'))).recorded).toBe(true)
    expect(await prisma.orgSessionAdmission.findUniqueOrThrow({ where: { sessionId: 's-late' } })).toMatchObject({
      agentId: AGENT,
      counted: true,
      maintenance: null
    })
    expect((await sessions().recordMilestone({ ...ev('s-late'), phase: 'end' })).recorded).toBe(true)
    // A re-sent admit of an id its milestone admitted replays that admission.
    expect(await admit('s-late')).toEqual({ admitted: true, counted: true, enforcing: true })
    expect(await used()).toBe(1)
  })

  it('refuses a never-admitted id at the limit, writing and counting nothing', async () => {
    await seedAgent(prisma, AGENT)
    await policy(1, true)
    await admit('s-1')
    expect(await sessions().recordMilestone(ev('s-skip'))).toEqual({
      recorded: false,
      session: null,
      settled: [],
      refused: { reason: 'session_limit_reached', limit: 1, used: 1, resetsAt: await nextMonthStart() }
    })
    expect(await prisma.sessionMeta.count({ where: { id: 's-skip' } })).toBe(0)
    expect(await prisma.orgSessionAdmission.count({ where: { sessionId: 's-skip' } })).toBe(0)
    expect(await used()).toBe(1)
  })

  it('counts once when an admit and the first milestone of one id race', async () => {
    await seedAgent(prisma, AGENT)
    await policy(5, true)
    const [admitted, recorded] = await Promise.all([admit('s-race'), sessions().recordMilestone(ev('s-race'))])
    expect(admitted).toMatchObject({ admitted: true })
    expect(recorded.recorded).toBe(true)
    expect(await used()).toBe(1)
    expect(await prisma.orgSessionAdmission.count()).toBe(1)
  })

  it('admits exactly one of concurrent never-admitted milestones racing for the last slot', async () => {
    await seedAgent(prisma, AGENT)
    await policy(1, true)
    const results = await Promise.all(['m-a', 'm-b', 'm-c'].map((id) => sessions().recordMilestone(ev(id))))
    expect(results.filter((r) => r.recorded)).toHaveLength(1)
    expect(results.filter((r) => r.refused?.reason === 'session_limit_reached')).toHaveLength(2)
    expect(await used()).toBe(1)
  })

  it('records an admitted id, and keeps recording a session that existed before enforcement', async () => {
    await seedAgent(prisma, AGENT)
    await sessions().recordMilestone(ev('s-old'))
    await policy(2, true)
    await admit('s-new')
    expect((await sessions().recordMilestone(ev('s-new'))).recorded).toBe(true)
    expect((await sessions().recordMilestone({ ...ev('s-old'), phase: 'end' })).recorded).toBe(true)
    expect(await used()).toBe(2)
  })

  it('refuses an id admitted under another agent', async () => {
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, OTHER_AGENT)
    await policy(10, true)
    await admit('s-1')
    expect((await sessions().recordMilestone(ev('s-1', OTHER_AGENT))).refused).toEqual({ reason: 'other_agent' })
    expect(await prisma.sessionMeta.count({ where: { id: 's-1' } })).toBe(0)
  })

  it('records an unadmitted id as before when the policy does not enforce or the install switch is off', async () => {
    await seedAgent(prisma, AGENT)
    await policy(10, false)
    expect((await sessions().recordMilestone(ev('s-1'))).recorded).toBe(true)
    await policy(10, true)
    expect((await sessions(false).recordMilestone(ev('s-2'))).recorded).toBe(true)
    expect(await used()).toBe(2)
  })
})

describe('session grants under an enforced monthly session limit', () => {
  const frame = (type: string, payload: Record<string, unknown>) =>
    ({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload }) as AnyFrame

  function harness() {
    const replies: Array<{ type: string; payload: unknown }> = []
    const conn = {
      daemonId: DAEMON,
      orgId: DEF_ORG,
      state: 'READY',
      closedSignal: new AbortController().signal,
      replyTo: (_req: AnyFrame, type: string, payload: unknown) => replies.push({ type, payload }),
      sendError: (_corr: string, code: string) => replies.push({ type: 'error', payload: { code } })
    } as unknown as DaemonConnection
    const grant = vi.fn(async () => ({ granted: false as const, code: 'unavailable' as const, message: 'offline' }))
    const acquire = vi.fn(async () => ({ state: 'failed' as const, code: 'unavailable' as const, message: 'none' }))
    const lease = vi.fn(async () => ({ granted: false as const, code: 'unavailable' as const, message: 'none' }))
    const deps = {
      agent: new PgAgentRepo(prisma),
      log: { error: () => {}, warn: () => {} },
      sessionAdmission: policies(),
      computerChannelGrants: { grant },
      computerPool: { acquire },
      computerLeases: { acquire: lease }
    } as unknown as DaemonWsDeps
    return { replies, conn, deps, grant, acquire, lease }
  }

  it('refuses a computer channel, pool computer and lease to a session never admitted, and serves an admitted one', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await policy(10, true)
    await admit('s-admitted')
    const h = harness()
    const ask = async (sessionId: string) => {
      await handleComputerChannelGrant(
        frame('computer-channel/grant', { computerId: COMPUTER, agentId: AGENT, sessionId }),
        h.conn,
        h.deps
      )
      await handleComputerPoolAcquire(frame('computer-pool/acquire', { agentId: AGENT, sessionId }), h.conn, h.deps)
      await handleComputerLeaseAcquire(
        frame('computer-lease/acquire', {
          computerId: COMPUTER,
          agentId: AGENT,
          sessionId,
          requestedAt: new Date().toISOString()
        }),
        h.conn,
        h.deps
      )
      return h.replies.splice(0).map((r) => r.payload)
    }

    expect(await ask('s-unadmitted')).toEqual([
      expect.objectContaining({ granted: false, code: 'denied' }),
      expect.objectContaining({ state: 'failed', code: 'denied' }),
      expect.objectContaining({ granted: false, code: 'denied' })
    ])
    expect(h.grant).not.toHaveBeenCalled()
    expect(h.acquire).not.toHaveBeenCalled()
    expect(h.lease).not.toHaveBeenCalled()

    await ask('s-admitted')
    expect(h.grant).toHaveBeenCalledOnce()
    expect(h.acquire).toHaveBeenCalledOnce()
    expect(h.lease).toHaveBeenCalledOnce()
  })

  it('serves any session of an organization that does not enforce', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await policy(10, false)
    const h = harness()
    await handleComputerChannelGrant(
      frame('computer-channel/grant', { computerId: COMPUTER, agentId: AGENT, sessionId: 's-any' }),
      h.conn,
      h.deps
    )
    expect(h.grant).toHaveBeenCalledOnce()
  })
})
