// Session executors over the WS edge (session-executors.md §6): the facts persisted, the candidates a holder pulls, the prepare the CP relays.
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import {
  SESSION_EXECUTORS_V1_FEATURE,
  type ExecutorCandidatesResult,
  type ExecutorFacts,
  type ExecutorPrepareReq,
  type ExecutorPrepareResult,
  type ExecutorReleaseReq,
  type ExecutorReleaseResult
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { seedAgent, seedDutyGroup, seedSessionMeta } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const HOLDER = 'd1111111-1111-4111-8111-111111111111'
const EXECUTOR = 'd2222222-2222-4222-8222-222222222222'
const THIRD = 'd3333333-3333-4333-8333-333333333333'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const GROUP = '00000000-0000-4000-8000-000000000001'

const FACTS: ExecutorFacts = {
  enabled: true,
  strategies: { host: { available: true }, microsandbox: { available: false, reason: 'not the configured backend' } },
  endpoint: { host: '192.0.2.10', port: 7443 },
  capacity: 32
}

const PSK = 'cHNrLXRoYXQtbXVzdC1uZXZlci1iZS1sb2dnZWQ'
const READY: ExecutorPrepareResult = {
  status: 'ready',
  generation: 8,
  endpoint: { host: '192.0.2.10', port: 7443 },
  psk: PSK,
  runtimeRoot: '/home/agent/workspace/hs/0a1b2c3d4e5f',
  helperRoot: '/opt/agentconnect',
  missingHelpers: ['ghWrapperDir'],
  liveCount: 4
}

const LAUNCH = '55555555-5555-4555-8555-555555555551'
const NEXT_LAUNCH = '55555555-5555-4555-8555-555555555552'
const SESSION_KEY = 'slack:C1:1700000000.000100'
const PREPARE: ExecutorPrepareReq = {
  agentId: AGENT,
  sessionKey: SESSION_KEY,
  executorDaemonId: EXECUTOR,
  launchId: LAUNCH,
  strategy: 'host'
}
const RELEASE: ExecutorReleaseReq = {
  agentId: AGENT,
  sessionKey: SESSION_KEY,
  executorDaemonId: EXECUTOR,
  launchId: LAUNCH
}

const BEAT = { load: { cpu: 0.1, mem: 0.1, agents: 0 }, health: 'ok', activeSessions: 0 }

/** Everything the CP logged, so a test can prove what it did NOT log. */
function capturedLog(h: WsHarness): unknown[] {
  const lines: unknown[] = []
  h.deps.log = { error: (obj, message) => void lines.push([obj, message]) }
  return lines
}

async function memberSet(spreadSessions = true): Promise<string> {
  const set = await prisma.memberSet.create({
    data: { id: randomUUID(), orgId: DEFAULT_ORG_ID, name: `lab-${randomUUID().slice(0, 8)}`, spreadSessions }
  })
  return set.id
}

/** One of the org's own machines: provisioned, optionally enrolled, then connected and registered. */
async function member(
  h: WsHarness,
  daemonId: string,
  opts: { setId?: string; executor?: ExecutorFacts; features?: string[] } = {}
): Promise<InMemoryDaemonStub> {
  const token = await h.mintToken(daemonId)
  // Before auth: `auth/ok` announces the set, and a membership that changes mid-handshake closes the socket.
  if (opts.setId) await prisma.memberSetMember.create({ data: { setId: opts.setId, daemonId } })
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: `host-${daemonId.slice(0, 2)}`,
    capabilities: {
      platforms: ['slack'],
      runtimes: ['claude'],
      acp: true,
      features: opts.features ?? [SESSION_EXECUTORS_V1_FEATURE],
      ...(opts.executor ? { executor: opts.executor } : {})
    },
    maxAgents: 8,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  await stub.expectFrame('register/ok')
  return stub
}

/** The agent is placed on the group and `holder` holds its duty. Seeded AFTER the members register, so no reconcile has to install it. */
async function placedAgent(setId: string, holder = HOLDER): Promise<void> {
  await seedAgent(prisma, AGENT, { setId })
  await seedDutyGroup(prisma, GROUP, holder, [AGENT])
}

async function ask<T>(
  stub: InMemoryDaemonStub,
  type: 'executor/candidates' | 'executor/prepare' | 'executor/release',
  payload: unknown
) {
  const id = stub.inject(type, payload)
  await stub.settled()
  const replies = stub.sent.filter((f) => f.corr === id)
  expect(replies.map((f) => f.type)).toEqual([`${type}/result`])
  return replies[0]!.payload as T
}

const relayed = (stub: InMemoryDaemonStub, type = 'executor/prepare') => stub.sent.filter((f) => f.type === type)

/** Everything in `value` as one searchable string; rows carry BigInt epochs and ids, which plain JSON refuses. */
const dump = (value: unknown): string => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v))

describe('executor facts — what registration and the heartbeat persist (real Postgres)', () => {
  it('advertises the feature, stores the facts on the daemon record, and replaces them on capabilities/update', async () => {
    const h = buildWsHarness(prisma)
    const stub = await member(h, EXECUTOR, { executor: FACTS })
    expect((stub.lastSent('register/ok')!.payload as { serverFeatures: string[] }).serverFeatures).toContain(
      SESSION_EXECUTORS_V1_FEATURE
    )
    const stored = async () => (await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })).capabilities
    expect(await stored()).toMatchObject({ executor: FACTS })

    // The owner switched `sandbox.share` off: the re-announcement is a full replace, live and durable.
    stub.inject('capabilities/update', {
      capabilities: {
        platforms: ['slack'],
        runtimes: ['claude'],
        acp: true,
        features: [],
        executor: { enabled: false }
      }
    })
    await stub.settled()
    expect(await stored()).toMatchObject({ executor: { enabled: false } })
    expect(h.deps.connReg.get(EXECUTOR)?.capabilities?.executor).toEqual({ enabled: false })
  })

  it('a daemon that does not share registers exactly as before', async () => {
    const h = buildWsHarness(prisma)
    await member(h, EXECUTOR, { features: [] })
    const row = await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })
    expect(row.capabilities).toEqual({ platforms: ['slack'], runtimes: ['claude'], acp: true, features: [] })
    expect(row.hostedSessions).toBeNull()
  })

  it('persists hostedSessions beside activeSessions, and a beat without it changes nothing', async () => {
    const h = buildWsHarness(prisma)
    const stub = await member(h, EXECUTOR, { executor: FACTS })
    const counts = async () => {
      const row = await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })
      return { activeSessions: row.activeSessions, hostedSessions: row.hostedSessions }
    }

    stub.inject('heartbeat', { ...BEAT, activeSessions: 2, hostedSessions: 5 })
    await stub.settled()
    expect(await counts()).toEqual({ activeSessions: 2, hostedSessions: 5 })

    stub.inject('heartbeat', { ...BEAT, activeSessions: 1 })
    await stub.settled()
    expect(await counts()).toEqual({ activeSessions: 1, hostedSessions: 5 })
  })
})

describe('executor/candidates — facts the duty holder pulls (real Postgres)', () => {
  it('answers the connected members whose facet is on, with runtime sign-in joined, and never the asker', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    // The asker shares too: it is always its own candidate, so it is not told about itself.
    const holder = await member(h, HOLDER, { setId, executor: FACTS })
    const executor = await member(h, EXECUTOR, { setId, executor: FACTS })
    // Connected, facet off.
    await member(h, THIRD, { setId })
    // Enrolled and sharing on its last registration, but not connected now.
    const offline = randomUUID()
    await prisma.daemon.create({
      data: {
        id: offline,
        orgId: DEFAULT_ORG_ID,
        status: 'ready',
        capabilities: {
          platforms: [],
          runtimes: [],
          acp: true,
          features: [SESSION_EXECUTORS_V1_FEATURE],
          executor: FACTS
        }
      }
    })
    await prisma.memberSetMember.create({ data: { setId, daemonId: offline } })
    await placedAgent(setId)

    executor.inject('heartbeat', { ...BEAT, hostedSessions: 3 })
    executor.inject('facts/daemon-runtimes', {
      runtimes: [
        { runtime: 'claude', version: '1', models: [], acpSupport: 'full', toolCalling: true },
        { runtime: 'codex', version: '1', models: [], acpSupport: 'full', toolCalling: true, authRequired: true }
      ],
      seq: 1
    })
    await executor.settled()

    const answer = await ask<ExecutorCandidatesResult>(holder, 'executor/candidates', { agentId: AGENT })
    expect(answer.reason).toBeUndefined()
    expect(answer.candidates).toHaveLength(1)
    expect(answer.candidates[0]).toMatchObject({
      daemonId: EXECUTOR,
      strategies: FACTS.strategies,
      endpoint: FACTS.endpoint,
      capacity: 32,
      hostedSessions: 3
    })
    expect([...answer.candidates[0]!.runtimes].sort((a, b) => a.runtime.localeCompare(b.runtime))).toEqual([
      { runtime: 'claude', authRequired: false },
      { runtime: 'codex', authRequired: true }
    ])
  })

  it('refuses an asker that does not hold the agent’s duty', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    const holder = await member(h, HOLDER, { setId })
    await member(h, EXECUTOR, { setId, executor: FACTS })
    await placedAgent(setId, THIRD)

    expect(await ask(holder, 'executor/candidates', { agentId: AGENT })).toEqual({
      candidates: [],
      reason: 'not_holder'
    })
    // An agent it has never heard of answers the same way.
    expect(await ask(holder, 'executor/candidates', { agentId: randomUUID() })).toEqual({
      candidates: [],
      reason: 'not_holder'
    })
  })

  it('an empty answer says why: the switch is off, the agent is on no group, or nobody shares', async () => {
    const h = buildWsHarness(prisma)
    const off = await memberSet(false)
    const holder = await member(h, HOLDER, { setId: off })
    await member(h, EXECUTOR, { setId: off, executor: FACTS })
    await placedAgent(off)
    expect(await ask(holder, 'executor/candidates', { agentId: AGENT })).toEqual({
      candidates: [],
      reason: 'group_switch_off'
    })

    // The same agent pinned to its machine: held through a lease, but placed on no group.
    await prisma.agent.update({
      where: { id: AGENT },
      data: { placementKind: 'daemon', daemonId: HOLDER, setId: null }
    })
    expect(await ask(holder, 'executor/candidates', { agentId: AGENT })).toEqual({
      candidates: [],
      reason: 'not_on_group'
    })

    // Back on the group with the switch on, and the one sharing member turns its facet off.
    await prisma.agent.update({ where: { id: AGENT }, data: { placementKind: 'set', daemonId: null, setId: off } })
    await prisma.memberSet.update({ where: { id: off }, data: { spreadSessions: true } })
    h.deps.connReg.get(EXECUTOR)!.capabilities!.executor = { enabled: false }
    expect(await ask(holder, 'executor/candidates', { agentId: AGENT })).toEqual({
      candidates: [],
      reason: 'no_member_shares'
    })
  })

  it('hints where the session last ran, from the CP’s own row, and only when the holder names one', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    const holder = await member(h, HOLDER, { setId })
    await member(h, EXECUTOR, { setId, executor: FACTS })
    await placedAgent(setId)
    await seedSessionMeta(prisma, `s-${randomUUID()}`, AGENT, {
      platform: 'slack',
      channel: 'C1',
      thread: '1700000000.000100',
      executorDaemonId: EXECUTOR
    })

    const unasked = await ask<ExecutorCandidatesResult>(holder, 'executor/candidates', { agentId: AGENT })
    expect(unasked.currentExecutorDaemonId).toBeUndefined()

    const asked = await ask<ExecutorCandidatesResult>(holder, 'executor/candidates', {
      agentId: AGENT,
      sessionKey: SESSION_KEY
    })
    // A hint, not a choice: it rides beside the candidates the holder still picks from.
    expect(asked.currentExecutorDaemonId).toBe(EXECUTOR)
    expect(asked.candidates.map((c) => c.daemonId)).toEqual([EXECUTOR])

    // A session this Control Plane has no row for gets no hint rather than a wrong one.
    const other = await ask<ExecutorCandidatesResult>(holder, 'executor/candidates', {
      agentId: AGENT,
      sessionKey: 'slack:C9:1700000000.000900'
    })
    expect(other.currentExecutorDaemonId).toBeUndefined()
  })

  it('never lists a member that shares but does not speak the executor frames', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    const holder = await member(h, HOLDER, { setId })
    await member(h, EXECUTOR, { setId, executor: FACTS, features: [] })
    await placedAgent(setId)
    expect(await ask(holder, 'executor/candidates', { agentId: AGENT })).toEqual({
      candidates: [],
      reason: 'no_member_shares'
    })
  })
})

describe('executor/prepare — checked against the ledger, then relayed (real Postgres)', () => {
  async function pair(h: WsHarness, opts: { spread?: boolean; holderOfDuty?: string } = {}) {
    const setId = await memberSet(opts.spread ?? true)
    const holder = await member(h, HOLDER, { setId })
    const executor = await member(h, EXECUTOR, { setId, executor: FACTS })
    await placedAgent(setId, opts.holderOfDuty ?? HOLDER)
    return { setId, holder, executor }
  }

  it('relays the request verbatim over the executor’s own connection and returns its reply verbatim', async () => {
    const h = buildWsHarness(prisma)
    const log = capturedLog(h)
    const { holder, executor } = await pair(h)

    const id = holder.inject('executor/prepare', {
      ...PREPARE,
      resources: { cpus: 2 },
      image: 'registry.example.test/rt:1'
    })
    const frame = await executor.expectFrame('executor/prepare')
    expect(frame.payload).toEqual({ ...PREPARE, resources: { cpus: 2 }, image: 'registry.example.test/rt:1' })
    // Fenced on the EXECUTOR's epoch and scoped to the agent's org, like every other C→D request.
    expect([frame.epoch, frame.orgId]).toEqual([h.deps.connReg.get(EXECUTOR)!.sessionEpoch, DEFAULT_ORG_ID])
    executor.reply(frame.id, 'executor/prepare/result', READY)
    await holder.settled()

    expect(holder.sent.filter((f) => f.corr === id).map((f) => f.payload)).toEqual([READY])
    // The member's count is refreshed from the reply, ahead of its next heartbeat.
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })).hostedSessions).toBe(4)

    // The key went to the holder and nowhere else the CP writes.
    expect(dump(log)).not.toContain(PSK)
    expect(dump(await prisma.auditEvent.findMany())).not.toContain(PSK)
    // Sanity for the check itself: the rows ARE searchable, so an absent key means absent.
    const daemons = dump(await prisma.daemon.findMany())
    expect(daemons).toContain(EXECUTOR)
    expect(daemons).not.toContain(PSK)
  })

  it('returns full and an executor’s own refusal as they came, refreshing the count when one is carried', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    const answers: ExecutorPrepareResult[] = [
      { status: 'full', liveCount: 32 },
      { status: 'refused', reason: 'launch_retired' }
    ]
    executor.respondTo('executor/prepare', () => ({ type: 'executor/prepare/result', payload: answers.shift() }))

    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'full', liveCount: 32 })
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })).hostedSessions).toBe(32)
    expect(await ask(holder, 'executor/prepare', { ...PREPARE, launchId: NEXT_LAUNCH })).toEqual({
      status: 'refused',
      reason: 'launch_retired'
    })
    expect((await prisma.daemon.findUniqueOrThrow({ where: { id: EXECUTOR } })).hostedSessions).toBe(32)
  })

  it('refuses a requester that does not hold the duty, without relaying', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h, { holderOfDuty: THIRD })
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'refused', reason: 'not_holder' })
    expect(relayed(executor)).toEqual([])
  })

  it('refuses a target outside the agent’s set, one whose facet is off, and a group whose switch is off — none of them relayed', async () => {
    const h = buildWsHarness(prisma)
    const { setId, holder, executor } = await pair(h)
    // Shares, and is connected, but belongs to no set at all.
    const outsider = await member(h, THIRD, { executor: FACTS })

    expect(await ask(holder, 'executor/prepare', { ...PREPARE, executorDaemonId: THIRD })).toEqual({
      status: 'refused',
      reason: 'not_member'
    })

    h.deps.connReg.get(EXECUTOR)!.capabilities!.executor = { enabled: false }
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'refused', reason: 'facet_off' })

    h.deps.connReg.get(EXECUTOR)!.capabilities!.executor = FACTS
    await prisma.memberSet.update({ where: { id: setId }, data: { spreadSessions: false } })
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'refused', reason: 'group_switch_off' })

    expect([relayed(executor), relayed(outsider)]).toEqual([[], []])
  })

  it('answers with its own record of an executor whose control connection is down', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    const holder = await member(h, HOLDER, { setId })
    // Enrolled, and never connected to this Control Plane.
    await h.mintToken(EXECUTOR)
    await prisma.memberSetMember.create({ data: { setId, daemonId: EXECUTOR } })
    await placedAgent(setId)

    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'offline', lastSeenAt: null })

    const lastSeenAt = new Date('2026-09-20T12:00:00.000Z')
    await prisma.daemon.update({ where: { id: EXECUTOR }, data: { lastSeenAt } })
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({
      status: 'offline',
      lastSeenAt: lastSeenAt.toISOString()
    })
  })

  it('an executor that drops mid-preparation is the same answer as one that was down', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    const id = holder.inject('executor/prepare', PREPARE)
    await executor.expectFrame('executor/prepare')
    executor.close(1006, 'gone')
    await holder.settled()
    expect(holder.sent.filter((f) => f.corr === id).map((f) => f.payload)).toEqual([
      { status: 'offline', lastSeenAt: null }
    ])
  })

  it('a draining executor is refused by the CP itself', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    h.deps.connReg.get(EXECUTOR)!.state = 'DRAINING'
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'refused', reason: 'draining' })
    expect(relayed(executor)).toEqual([])
  })

  it('a resent request joins the relay in flight: one relay, one launch, one answer', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    const holdsAgent = vi.spyOn(h.deps.dutyLease, 'holdsAgent')

    const id = holder.inject('executor/prepare', PREPARE)
    const frame = await executor.expectFrame('executor/prepare')
    // The holder's correlator lapses while the executor is still preparing, and resends the identical frame.
    holder.inject('executor/prepare', PREPARE, { id })
    // The duty is the LAST read before the relay (§6), two per request, so four settled means the resend got that far.
    // A bounded deadline, not a fixed pause: a loaded runner costs latency here, never a red test.
    await vi.waitFor(() => expect(holdsAgent.mock.settledResults).toHaveLength(4), { timeout: 10_000, interval: 5 })
    // ...and nothing separates that read from the send, so one drained turn later the join has happened.
    await new Promise((resolve) => setImmediate(resolve))
    expect(relayed(executor)).toHaveLength(1)

    executor.reply(frame.id, 'executor/prepare/result', READY)
    await holder.settled()
    expect(relayed(executor).map((f) => (f.payload as ExecutorPrepareReq).launchId)).toEqual([LAUNCH])
    expect(holder.sent.filter((f) => f.corr === id).map((f) => f.payload)).toEqual([READY, READY])
    expect(h.deps.connReg.get(EXECUTOR)!.executorPrepares?.size).toBe(0)
  })

  it('never hands the key to a holder the ledger deposed while the executor was preparing', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    const id = holder.inject('executor/prepare', PREPARE)
    const frame = await executor.expectFrame('executor/prepare')
    await prisma.dutyGroup.update({ where: { id: GROUP }, data: { holder: THIRD } })
    executor.reply(frame.id, 'executor/prepare/result', READY)
    await holder.settled()

    expect(holder.sent.filter((f) => f.corr === id).map((f) => f.payload)).toEqual([
      { status: 'refused', reason: 'not_holder' }
    ])
    expect(JSON.stringify(holder.sent)).not.toContain(PSK)
  })

  it('an executor that never answers costs the holder one bounded wait, and the log names no payload', async () => {
    const h = buildWsHarness(prisma)
    const log = capturedLog(h)
    const { holder, executor } = await pair(h)
    const id = holder.inject('executor/prepare', PREPARE)
    await executor.expectFrame('executor/prepare')

    // Single-shot: the relay is never resent, and it gives up only after the whole budget.
    h.clock.advance(119_000)
    expect(holder.sent.filter((f) => f.corr === id)).toEqual([])
    h.clock.advance(2_000)
    await holder.settled()

    expect(relayed(executor)).toHaveLength(1)
    expect(holder.sent.filter((f) => f.corr === id).map((f) => f.payload)).toEqual([
      { status: 'refused', reason: 'relay_failed' }
    ])
    const relayFailures = log.filter((line) => (line as unknown[])[1] === 'executor/prepare: relay failed')
    expect(relayFailures).toEqual([
      [
        { daemonId: HOLDER, executorDaemonId: EXECUTOR, agentId: AGENT, code: 'INTERNAL' },
        'executor/prepare: relay failed'
      ]
    ])
  })
})

describe('executor/release — deletion with an owner (real Postgres)', () => {
  async function pair(h: WsHarness, opts: { spread?: boolean; holderOfDuty?: string } = {}) {
    const setId = await memberSet(opts.spread ?? true)
    const holder = await member(h, HOLDER, { setId })
    const executor = await member(h, EXECUTOR, { setId, executor: FACTS })
    await placedAgent(setId, opts.holderOfDuty ?? HOLDER)
    return { setId, holder, executor }
  }

  it('relays the release over the executor’s own connection and returns its answer, idempotently', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    const answers: ExecutorReleaseResult[] = [{ status: 'released' }, { status: 'unknown' }]
    executor.respondTo('executor/release', () => ({ type: 'executor/release/result', payload: answers.shift() }))

    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({ status: 'released' })
    // Asked again, the environment is already gone: `unknown` rather than an error, so a retry is free.
    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({ status: 'unknown' })

    const frames = relayed(executor, 'executor/release')
    expect(frames.map((f) => f.payload)).toEqual([RELEASE, RELEASE])
    expect([frames[0]!.epoch, frames[0]!.orgId]).toEqual([h.deps.connReg.get(EXECUTOR)!.sessionEpoch, DEFAULT_ORG_ID])
  })

  it('is relayed with the group’s switch off and with the executor’s facet dark: withdrawn consent still lets a holder clean up', async () => {
    const h = buildWsHarness(prisma)
    const { setId, holder, executor } = await pair(h)
    executor.respondTo('executor/release', () => ({
      type: 'executor/release/result',
      payload: { status: 'released' }
    }))

    await prisma.memberSet.update({ where: { id: setId }, data: { spreadSessions: false } })
    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({ status: 'released' })
    // The same switch stops a prepare dead, which is the difference this test exists for.
    expect(await ask(holder, 'executor/prepare', PREPARE)).toEqual({ status: 'refused', reason: 'group_switch_off' })

    h.deps.connReg.get(EXECUTOR)!.capabilities!.executor = { enabled: false }
    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({ status: 'released' })
    expect(relayed(executor, 'executor/release')).toHaveLength(2)
  })

  it('refuses a target outside the agent’s set and a requester that does not hold the duty, without relaying', async () => {
    const h = buildWsHarness(prisma)
    const { holder, executor } = await pair(h)
    // Shares, and is connected, but belongs to no set at all.
    const outsider = await member(h, THIRD, { executor: FACTS })
    expect(await ask(holder, 'executor/release', { ...RELEASE, executorDaemonId: THIRD })).toEqual({
      status: 'refused',
      reason: 'not_member'
    })

    await prisma.dutyGroup.update({ where: { id: GROUP }, data: { holder: THIRD } })
    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({ status: 'refused', reason: 'not_holder' })

    expect([relayed(executor, 'executor/release'), relayed(outsider, 'executor/release')]).toEqual([[], []])
  })

  it('tells a holder its executor is offline, so it knows the backstop owes the environment', async () => {
    const h = buildWsHarness(prisma)
    const setId = await memberSet()
    const holder = await member(h, HOLDER, { setId })
    await h.mintToken(EXECUTOR)
    await prisma.memberSetMember.create({ data: { setId, daemonId: EXECUTOR } })
    await placedAgent(setId)
    const lastSeenAt = new Date('2026-09-20T12:00:00.000Z')
    await prisma.daemon.update({ where: { id: EXECUTOR }, data: { lastSeenAt } })

    expect(await ask(holder, 'executor/release', RELEASE)).toEqual({
      status: 'offline',
      lastSeenAt: lastSeenAt.toISOString()
    })
  })
})
