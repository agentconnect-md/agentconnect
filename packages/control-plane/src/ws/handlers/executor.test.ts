// The executor requests over fakes: the gates, the relay's single flight, and what a holder is told when it goes wrong (real Postgres: test/protocol/executor.handler.test.ts).
import { describe, expect, it, vi } from 'vitest'
import {
  EXECUTOR_PREPARE_RELAY_BUDGET_MS,
  SESSION_EXECUTORS_V1_FEATURE,
  type AnyFrame,
  type ExecutorFacts,
  type ExecutorPrepareReq,
  type ExecutorPrepareResult,
  type ExecutorReleaseReq
} from '@agentconnect.md/protocol'
import { ProtocolError } from '../../domain/errors.js'
import type { DaemonConnection } from '../connection.js'
import type { DaemonWsDeps } from '../deps.js'
import { ConnectionClosed, type DaemonConnState } from '../registry.js'
import { handleExecutorCandidates, handleExecutorPrepare, handleExecutorRelease } from './executor.js'

const HOLDER = 'd1111111-1111-4111-8111-111111111111'
const SUCCESSOR = 'd7777777-7777-4777-8777-777777777777'
const EXECUTOR = 'd2222222-2222-4222-8222-222222222222'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SET = '33333333-3333-4333-8333-333333333333'
const ORG = 'org-a'
const PSK = 'cHNrLXRoYXQtbXVzdC1uZXZlci1iZS1sb2dnZWQ'

const FACTS: ExecutorFacts = {
  enabled: true,
  strategies: { host: { available: true } },
  endpoint: { host: '192.0.2.10', port: 7443 },
  capacity: 32
}
const READY: ExecutorPrepareResult = {
  status: 'ready',
  generation: 8,
  endpoint: { host: '192.0.2.10', port: 7443 },
  psk: PSK,
  runtimeRoot: '/home/agent/workspace/hs/0a1b2c3d4e5f',
  liveCount: 4
}
const LAUNCH = '55555555-5555-4555-8555-555555555555'
const PREPARE: ExecutorPrepareReq = {
  agentId: AGENT,
  sessionKey: 'slack:C1:1700000000.000100',
  executorDaemonId: EXECUTOR,
  launchId: LAUNCH,
  strategy: 'host'
}
const RELEASE: ExecutorReleaseReq = {
  agentId: AGENT,
  sessionKey: PREPARE.sessionKey,
  executorDaemonId: EXECUTOR,
  launchId: LAUNCH
}

function frame(type: 'executor/candidates' | 'executor/prepare' | 'executor/release', payload: unknown): AnyFrame {
  return { v: 1, id: crypto.randomUUID(), ts: '2026-09-21T00:00:00.000Z', type, orgId: ORG, payload } as AnyFrame
}

function fakeConn(daemonId = HOLDER) {
  return { daemonId, orgId: ORG, replyTo: vi.fn(), sendError: vi.fn() } as unknown as DaemonConnection & {
    replyTo: ReturnType<typeof vi.fn>
  }
}

/** A connected member as the registry holds it; `request` is the relay the test answers by hand. */
function member(daemonId: string, over: Partial<DaemonConnState> & { executor?: ExecutorFacts } = {}) {
  const { executor, ...state } = over
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>()
  return {
    daemonId,
    reachable: true,
    state: 'READY',
    sessionEpoch: 9,
    capabilities: {
      platforms: [],
      runtimes: [],
      acp: true,
      features: [SESSION_EXECUTORS_V1_FEATURE],
      ...(executor ? { executor } : {})
    },
    conn: { request },
    ...state
  } as unknown as DaemonConnState & { conn: { request: typeof request } }
}

function fakeDeps(over: {
  members?: DaemonConnState[]
  holds?: (daemonId: string) => boolean
  spreadSessions?: boolean
  placement?: { placementKind: 'daemon' | 'set'; daemonId: string | null; setId: string | null }
  memberIds?: string[]
  lastSeenAt?: Date | null
  executorForKey?: string | null
  /** Held by the FIRST reader of the member set, so one asker can sit in its lookups while another runs past it. */
  slowSetRead?: Promise<void>
}) {
  const members = new Map((over.members ?? []).map((m) => [m.daemonId, m]))
  let setReads = 0
  const log = vi.fn()
  const recordHostedSessions = vi.fn(async () => undefined)
  const executorForKey = vi.fn(async () => over.executorForKey ?? null)
  const deps = {
    log: { error: log },
    agent: {
      get: async () => ({
        id: AGENT,
        orgId: ORG,
        ...(over.placement ?? { placementKind: 'set', daemonId: null, setId: SET })
      })
    },
    dutyLease: { holdsAgent: async (daemonId: string) => (over.holds ? over.holds(daemonId) : true) },
    session: { executorForKey },
    memberSets: {
      get: async () => {
        if (++setReads === 1 && over.slowSetRead) await over.slowSetRead
        return { id: SET, orgId: ORG, name: 'lab', spreadSessions: over.spreadSessions ?? true }
      },
      memberIdsOf: async () => over.memberIds ?? [...members.keys()],
      setIdOf: async (id: string) => ((over.memberIds ?? [...members.keys()]).includes(id) ? SET : null)
    },
    connReg: { get: (id: string) => members.get(id) },
    registry: {
      getAvailable: async () => ({
        hostedSessions: 3,
        lastSeenAt: over.lastSeenAt ?? null,
        runtimeProfiles: [{ runtime: 'codex', authRequired: true }]
      }),
      recordHostedSessions
    }
  } as unknown as DaemonWsDeps
  return { deps, log, recordHostedSessions, executorForKey, setReads: () => setReads }
}

const replied = (conn: ReturnType<typeof fakeConn>) => conn.replyTo.mock.calls.map((call) => call[2] as unknown)

describe('handleExecutorCandidates', () => {
  it('lists the other members that could host right now, and nobody else', async () => {
    const conn = fakeConn()
    const { deps } = fakeDeps({
      members: [
        member(HOLDER, { executor: FACTS }), // the asker: always its own candidate
        member(EXECUTOR, { executor: FACTS }),
        member('d3333333-3333-4333-8333-333333333333'), // no facet
        member('d4444444-4444-4444-8444-444444444444', { executor: FACTS, state: 'DRAINING' }),
        member('d5555555-5555-4555-8555-555555555555', { executor: FACTS, reachable: false }),
        member('d6666666-6666-4666-8666-666666666666', { executor: { enabled: false, strategies: FACTS.strategies } })
      ]
    })
    await handleExecutorCandidates(frame('executor/candidates', { agentId: AGENT }), conn, deps)
    expect(replied(conn)).toEqual([
      {
        candidates: [
          {
            daemonId: EXECUTOR,
            strategies: FACTS.strategies,
            endpoint: FACTS.endpoint,
            capacity: 32,
            hostedSessions: 3,
            runtimes: [{ runtime: 'codex', authRequired: true }]
          }
        ]
      }
    ])
  })

  it('answers empty with the first gate that closed', async () => {
    const cases = [
      [{ holds: () => false }, 'not_holder'],
      [{ placement: { placementKind: 'daemon' as const, daemonId: HOLDER, setId: null } }, 'not_on_group'],
      [{ spreadSessions: false }, 'group_switch_off'],
      [{}, 'no_member_shares']
    ] as const
    for (const [over, reason] of cases) {
      const conn = fakeConn()
      await handleExecutorCandidates(frame('executor/candidates', { agentId: AGENT }), conn, fakeDeps(over).deps)
      expect([reason, replied(conn)]).toEqual([reason, [{ candidates: [], reason }]])
    }
  })

  it('hints where the session last ran only when the holder named one, and says nothing when no row does', async () => {
    const unasked = fakeConn()
    const quiet = fakeDeps({ members: [member(HOLDER)], executorForKey: EXECUTOR })
    await handleExecutorCandidates(frame('executor/candidates', { agentId: AGENT }), unasked, quiet.deps)
    expect(quiet.executorForKey).not.toHaveBeenCalled()
    expect(replied(unasked)).toEqual([{ candidates: [], reason: 'no_member_shares' }])

    const asked = fakeConn()
    const hinted = fakeDeps({ members: [member(HOLDER)], executorForKey: EXECUTOR })
    const ask = { agentId: AGENT, sessionKey: PREPARE.sessionKey }
    await handleExecutorCandidates(frame('executor/candidates', ask), asked, hinted.deps)
    // It rides an empty answer too: an executor the CP last saw may be nobody's candidate right now.
    expect(replied(asked)).toEqual([{ candidates: [], reason: 'no_member_shares', currentExecutorDaemonId: EXECUTOR }])
    expect(hinted.executorForKey).toHaveBeenCalledWith(AGENT, {
      platform: 'slack',
      channel: 'C1',
      thread: '1700000000.000100'
    })

    const unknown = fakeConn()
    await handleExecutorCandidates(
      frame('executor/candidates', ask),
      unknown,
      fakeDeps({ members: [member(HOLDER)], executorForKey: null }).deps
    )
    expect(replied(unknown)).toEqual([{ candidates: [], reason: 'no_member_shares' }])
  })

  it('tells a non-holder nothing, the hint included', async () => {
    const conn = fakeConn()
    const { deps, executorForKey } = fakeDeps({ holds: () => false, executorForKey: EXECUTOR })
    await handleExecutorCandidates(
      frame('executor/candidates', { agentId: AGENT, sessionKey: PREPARE.sessionKey }),
      conn,
      deps
    )
    expect(replied(conn)).toEqual([{ candidates: [], reason: 'not_holder' }])
    expect(executorForKey).not.toHaveBeenCalled()
  })
})

describe('handleExecutorPrepare', () => {
  it('relays once, single-shot, fenced on the executor’s epoch and scoped to the agent’s org', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    executor.conn.request.mockResolvedValue(READY)
    const conn = fakeConn()
    const { deps, log, recordHostedSessions } = fakeDeps({ members: [member(HOLDER), executor] })

    await handleExecutorPrepare(frame('executor/prepare', PREPARE), conn, deps)

    expect(executor.conn.request.mock.calls).toEqual([
      ['executor/prepare', PREPARE, { epoch: 9 }, { maxTries: 1, ackTimeoutMs: EXECUTOR_PREPARE_RELAY_BUDGET_MS }, ORG]
    ])
    expect(replied(conn)).toEqual([READY])
    expect(recordHostedSessions).toHaveBeenCalledWith(EXECUTOR, 4)
    expect(log).not.toHaveBeenCalled()
  })

  it('a resend joins the relay in flight; a newer launch opens its own', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    const answers: Array<(result: ExecutorPrepareResult) => void> = []
    executor.conn.request.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    const { deps } = fakeDeps({ members: [member(HOLDER), executor] })
    const first = fakeConn()
    const resent = fakeConn()
    const newer = fakeConn()

    const other = '66666666-6666-4666-8666-666666666666'
    const running = [
      handleExecutorPrepare(frame('executor/prepare', PREPARE), first, deps),
      handleExecutorPrepare(frame('executor/prepare', PREPARE), resent, deps),
      handleExecutorPrepare(frame('executor/prepare', { ...PREPARE, launchId: other }), newer, deps)
    ]
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    expect(executor.conn.request.mock.calls.map((call) => (call[1] as ExecutorPrepareReq).launchId)).toEqual([
      LAUNCH,
      other
    ])

    answers[0]!(READY)
    answers[1]!({ status: 'full' })
    await Promise.all(running)
    // One preparation, one answer: the slow launch never reaches the holder as two different keys.
    expect([replied(first), replied(resent), replied(newer)]).toEqual([[READY], [READY], [{ status: 'full' }]])
    expect(executor.executorPrepares?.size).toBe(0)
  })

  it('never relays for a holder the ledger deposed while it was still looking things up', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    executor.conn.request.mockResolvedValue(READY)
    let release!: () => void
    const slow = new Promise<void>((resolve) => (release = resolve))
    let holder = HOLDER
    const deposed = fakeConn(HOLDER)
    const successor = fakeConn(SUCCESSOR)
    const { deps, setReads } = fakeDeps({
      members: [member(HOLDER), member(SUCCESSOR), executor],
      holds: (id) => id === holder,
      slowSetRead: slow
    })

    // The deposed holder is inside the lookups that used to sit between its duty check and the send.
    const late = handleExecutorPrepare(frame('executor/prepare', PREPARE), deposed, deps)
    await vi.waitFor(() => expect(setReads()).toBe(1))
    holder = SUCCESSOR
    const next = '66666666-6666-4666-8666-666666666666'
    await handleExecutorPrepare(frame('executor/prepare', { ...PREPARE, launchId: next }), successor, deps)
    release()
    await late

    // Authorization order is send order because nothing is awaited between the two: only the successor's reached the wire.
    expect(executor.conn.request.mock.calls.map((call) => (call[1] as ExecutorPrepareReq).launchId)).toEqual([next])
    expect(replied(successor)).toEqual([READY])
    expect(replied(deposed)).toEqual([{ status: 'refused', reason: 'not_holder' }])
    expect(JSON.stringify(deposed.replyTo.mock.calls)).not.toContain(PSK)
  })

  it('never hands the key to a holder deposed while the executor prepared', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    let holds = true
    executor.conn.request.mockImplementation(async () => {
      holds = false // the ledger moved the duty mid-preparation
      return READY
    })
    const conn = fakeConn()
    const { deps } = fakeDeps({ members: [member(HOLDER), executor], holds: () => holds })

    await handleExecutorPrepare(frame('executor/prepare', PREPARE), conn, deps)

    expect(replied(conn)).toEqual([{ status: 'refused', reason: 'not_holder' }])
    expect(JSON.stringify(conn.replyTo.mock.calls)).not.toContain(PSK)
  })

  it('refuses before relaying: not a member, facet off, draining', async () => {
    const cases: Array<[Partial<DaemonConnState> & { executor?: ExecutorFacts }, string[] | undefined, string]> = [
      [{ executor: FACTS }, [HOLDER], 'not_member'],
      [{}, undefined, 'facet_off'],
      [{ executor: FACTS, capabilities: undefined }, undefined, 'facet_off'],
      [{ executor: FACTS, state: 'DRAINING' }, undefined, 'draining']
    ]
    for (const [over, memberIds, reason] of cases) {
      const executor = member(EXECUTOR, over)
      const conn = fakeConn()
      const { deps } = fakeDeps({ members: [member(HOLDER), executor], ...(memberIds ? { memberIds } : {}) })
      await handleExecutorPrepare(frame('executor/prepare', PREPARE), conn, deps)
      expect([reason, replied(conn)]).toEqual([reason, [{ status: 'refused', reason }]])
      expect(executor.conn.request).not.toHaveBeenCalled()
    }
  })

  it('an executor that is down, or drops mid-flight, is answered from the CP’s own record', async () => {
    const lastSeenAt = new Date('2026-09-20T12:00:00.000Z')
    const down = fakeConn()
    await handleExecutorPrepare(
      frame('executor/prepare', PREPARE),
      down,
      fakeDeps({ members: [member(HOLDER)], memberIds: [HOLDER, EXECUTOR], lastSeenAt }).deps
    )

    const executor = member(EXECUTOR, { executor: FACTS })
    executor.conn.request.mockRejectedValue(new ConnectionClosed())
    const dropped = fakeConn()
    const { deps, log } = fakeDeps({ members: [member(HOLDER), executor], lastSeenAt })
    await handleExecutorPrepare(frame('executor/prepare', PREPARE), dropped, deps)

    const offline = { status: 'offline', lastSeenAt: lastSeenAt.toISOString() }
    expect([replied(down), replied(dropped)]).toEqual([[offline], [offline]])
    expect(log).not.toHaveBeenCalled()
  })

  it('a relay that times out, errors, or answers nonsense is one retryable refusal, logged by id and code only', async () => {
    const failures: Array<[() => Promise<unknown>, string | undefined]> = [
      [async () => Promise.reject(new ProtocolError('INTERNAL', 'no ack after 1 tries')), 'INTERNAL'],
      [async () => Promise.reject(new ProtocolError('BAD_PAYLOAD', `echoed ${PSK}`)), 'BAD_PAYLOAD'],
      [async () => ({ ok: true }), undefined]
    ]
    for (const [answer, code] of failures) {
      const executor = member(EXECUTOR, { executor: FACTS })
      executor.conn.request.mockImplementation(answer)
      const conn = fakeConn()
      const { deps, log, recordHostedSessions } = fakeDeps({ members: [member(HOLDER), executor] })
      await handleExecutorPrepare(frame('executor/prepare', PREPARE), conn, deps)

      expect(replied(conn)).toEqual([{ status: 'refused', reason: 'relay_failed' }])
      expect(recordHostedSessions).not.toHaveBeenCalled()
      expect(log.mock.calls).toEqual(
        code
          ? [[{ daemonId: HOLDER, executorDaemonId: EXECUTOR, agentId: AGENT, code }, 'executor/prepare: relay failed']]
          : []
      )
    }
  })

  it('a count that cannot be stored does not cost the holder its reply', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    executor.conn.request.mockResolvedValue({ status: 'full', liveCount: 32 })
    const conn = fakeConn()
    const { deps, recordHostedSessions } = fakeDeps({ members: [member(HOLDER), executor] })
    recordHostedSessions.mockRejectedValue(new Error('database is away'))

    await handleExecutorPrepare(frame('executor/prepare', PREPARE), conn, deps)
    expect(replied(conn)).toEqual([{ status: 'full', liveCount: 32 }])
  })
})

describe('handleExecutorRelease', () => {
  it('relays the release to the executor and returns its answer', async () => {
    const executor = member(EXECUTOR, { executor: FACTS })
    executor.conn.request.mockResolvedValue({ status: 'released' })
    const conn = fakeConn()
    const { deps } = fakeDeps({ members: [member(HOLDER), executor] })

    await handleExecutorRelease(frame('executor/release', RELEASE), conn, deps)

    expect(executor.conn.request.mock.calls).toEqual([
      ['executor/release', RELEASE, { epoch: 9 }, { maxTries: 1, ackTimeoutMs: EXECUTOR_PREPARE_RELAY_BUDGET_MS }, ORG]
    ])
    expect(replied(conn)).toEqual([{ status: 'released' }])
  })

  it('is gated by neither consent: the group’s switch is off, or the machine’s facet is dark, and it still relays', async () => {
    const withdrawn: Array<[Partial<DaemonConnState> & { executor?: ExecutorFacts }, { spreadSessions?: boolean }]> = [
      [{ executor: FACTS }, { spreadSessions: false }],
      [{}, {}]
    ]
    for (const [state, group] of withdrawn) {
      const executor = member(EXECUTOR, state)
      executor.conn.request.mockResolvedValue({ status: 'released' })
      const conn = fakeConn()
      const { deps } = fakeDeps({ members: [member(HOLDER), executor], ...group })
      await handleExecutorRelease(frame('executor/release', RELEASE), conn, deps)
      expect(replied(conn)).toEqual([{ status: 'released' }])
      expect(executor.conn.request).toHaveBeenCalledTimes(1)
    }
  })

  it('relays to a draining executor too, since its environments outlive the process', async () => {
    const executor = member(EXECUTOR, { executor: FACTS, state: 'DRAINING' })
    executor.conn.request.mockResolvedValue({ status: 'released' })
    const conn = fakeConn()
    const { deps } = fakeDeps({ members: [member(HOLDER), executor] })
    await handleExecutorRelease(frame('executor/release', RELEASE), conn, deps)
    expect(replied(conn)).toEqual([{ status: 'released' }])
  })

  it('refuses a non-holder, an agent on no group, and a target outside the group, without relaying', async () => {
    const cases: Array<[Parameters<typeof fakeDeps>[0], string[] | undefined, string]> = [
      [{ holds: () => false }, undefined, 'not_holder'],
      [{ placement: { placementKind: 'daemon', daemonId: HOLDER, setId: null } }, undefined, 'not_on_group'],
      [{}, [HOLDER], 'not_member']
    ]
    for (const [over, memberIds, reason] of cases) {
      const executor = member(EXECUTOR, { executor: FACTS })
      const conn = fakeConn()
      const { deps } = fakeDeps({ members: [member(HOLDER), executor], ...over, ...(memberIds ? { memberIds } : {}) })
      await handleExecutorRelease(frame('executor/release', RELEASE), conn, deps)
      expect([reason, replied(conn)]).toEqual([reason, [{ status: 'refused', reason }]])
      expect(executor.conn.request).not.toHaveBeenCalled()
    }
  })

  it('answers an executor that is down from the CP’s own record, so the holder knows the backstop owes it', async () => {
    const lastSeenAt = new Date('2026-09-20T12:00:00.000Z')
    const conn = fakeConn()
    await handleExecutorRelease(
      frame('executor/release', RELEASE),
      conn,
      fakeDeps({ members: [member(HOLDER)], memberIds: [HOLDER, EXECUTOR], lastSeenAt }).deps
    )
    expect(replied(conn)).toEqual([{ status: 'offline', lastSeenAt: lastSeenAt.toISOString() }])
  })

  it('a relay that fails or answers nonsense is one retryable refusal', async () => {
    for (const answer of [
      async () => Promise.reject(new ProtocolError('INTERNAL', 'no ack after 1 tries')),
      async () => ({ ok: true })
    ]) {
      const executor = member(EXECUTOR, { executor: FACTS })
      executor.conn.request.mockImplementation(answer)
      const conn = fakeConn()
      const { deps } = fakeDeps({ members: [member(HOLDER), executor] })
      await handleExecutorRelease(frame('executor/release', RELEASE), conn, deps)
      expect(replied(conn)).toEqual([{ status: 'refused', reason: 'relay_failed' }])
    }
  })
})
