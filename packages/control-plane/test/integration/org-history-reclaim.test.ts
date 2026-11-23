// The reclaim switch in register/ok and the sweep's re-confirmation, over real Postgres (org-session-policy.md, Reclaim).
import { describe, expect, it } from 'vitest'
import {
  HISTORY_RETENTION_CONFIRM_FEATURE,
  ORG_HISTORY_RECLAIM_FEATURE,
  ORG_HISTORY_RETENTION_FEATURE,
  isFrame,
  type HistoryRetentionConfirmResult,
  type RegisterOk
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness, type WsHarness } from '../fakes/build-ws.js'
import type { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { poolSetId } from '../fakes/member-set.js'
import { seedAgent, seedDutyGroup } from '../fixtures/seed.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-0000000000b1'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-0000000000b2'
const MEMBER = 'dddddddd-dddd-4ddd-8ddd-0000000000b3'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-0000000000b1'
const AGENT_B = 'b2b2b2b2-b2b2-4b2b-8b2b-0000000000b2'
const AGENT_C = 'c3c3c3c3-c3c3-4c3c-8c3c-0000000000b3'
const ORG_B = 'org-b-history-reclaim'
const ORG_C = 'org-c-history-reclaim'
const GROUP_A = '00000000-0000-4000-8000-00000000b0a1'
const GROUP_B = '00000000-0000-4000-8000-00000000b0b2'

async function setPolicy(orgId: string, revision: number, historyRetentionDays: number | null): Promise<void> {
  const applied = await new PgOrgSessionPolicyRepo(prisma).apply(orgId, {
    revision,
    monthlySessionLimit: null,
    historyRetentionDays,
    enforce: false
  })
  expect(applied).toBe(revision)
}

async function seedDaemon(id: string, orgId: string = DEFAULT_ORG_ID): Promise<void> {
  await prisma.daemon.create({
    data: { id, orgId, sessionEpoch: 1n, routingEpoch: 1n, maxAgents: 4, status: 'ready', approvalStatus: 'approved' }
  })
}

async function register(stub: InMemoryDaemonStub, features: string[]): Promise<RegisterOk> {
  stub.inject('register', {
    host: 'host-1',
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return ok.payload
}

async function connectDaemon(h: WsHarness, features: string[]): Promise<{ stub: InMemoryDaemonStub; ok: RegisterOk }> {
  const token = await h.mintToken(DAEMON, { approved: true })
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  return { stub, ok: await register(stub, features) }
}

/** The reply correlated to this request, since a stub resolves `expectFrame` with the first frame of a type. */
async function replyTo(stub: InMemoryDaemonStub, id: string) {
  await stub.settled()
  const reply = stub.sent.find((frame) => frame.corr === id)
  if (!reply) throw new Error('no reply')
  return reply
}

async function confirm(stub: InMemoryDaemonStub, orgIds: string[]): Promise<HistoryRetentionConfirmResult> {
  const reply = await replyTo(stub, stub.inject('history-retention/confirm', { orgIds }))
  if (!isFrame('history-retention/confirm/result')(reply)) throw new Error('expected a confirmation')
  // Install-wide both ways: neither the request nor its answer names an org on the envelope.
  expect(reply.orgId).toBeUndefined()
  return reply.payload
}

describe('register/ok — the reclaim switch', () => {
  it('rides beside the snapshot to a daemon that reads it, as the install sets it', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const on = await connectDaemon(buildWsHarness(prisma, { orgHistoryReclaim: true }), [
      ORG_HISTORY_RETENTION_FEATURE,
      ORG_HISTORY_RECLAIM_FEATURE
    ])
    expect(on.ok.orgHistoryRetention).toEqual({ orgIds: [DEFAULT_ORG_ID], entries: [], reclaim: true })
    expect(on.ok.serverFeatures).toContain(HISTORY_RETENTION_CONFIRM_FEATURE)

    const off = await connectDaemon(buildWsHarness(prisma), [
      ORG_HISTORY_RETENTION_FEATURE,
      ORG_HISTORY_RECLAIM_FEATURE
    ])
    expect(off.ok.orgHistoryRetention?.reclaim).toBe(false)
  })

  it('is never sent to an older daemon, which keeps its daemon-wide window', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await setPolicy(DEFAULT_ORG_ID, 1, 7)
    const { ok } = await connectDaemon(buildWsHarness(prisma, { orgHistoryReclaim: true }), [
      ORG_HISTORY_RETENTION_FEATURE
    ])
    expect(ok.orgHistoryRetention).toEqual({
      orgIds: [DEFAULT_ORG_ID],
      entries: [{ orgId: DEFAULT_ORG_ID, revision: 1, historyRetentionDays: 7 }]
    })
    const oldest = await connectDaemon(buildWsHarness(prisma, { orgHistoryReclaim: true }), [])
    expect(oldest.ok).not.toHaveProperty('orgHistoryRetention')
  })
})

describe('history-retention/confirm', () => {
  it('answers a served org’s current policy and denies an org the daemon serves no agent in', async () => {
    await prisma.org.create({ data: { id: ORG_B, slug: ORG_B } })
    await seedDaemon(DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedDaemon(OTHER_DAEMON, ORG_B)
    await seedAgent(prisma, AGENT_B, { daemonId: OTHER_DAEMON, orgId: ORG_B })
    await setPolicy(DEFAULT_ORG_ID, 4, 7)
    await setPolicy(ORG_B, 2, 30)
    const { stub } = await connectDaemon(buildWsHarness(prisma), [ORG_HISTORY_RETENTION_FEATURE])

    expect(await confirm(stub, [DEFAULT_ORG_ID, ORG_B, 'org-nobody-knows'])).toEqual({
      entries: [{ orgId: DEFAULT_ORG_ID, revision: 4, historyRetentionDays: 7 }],
      noPolicy: [],
      denied: [ORG_B, 'org-nobody-knows']
    })

    // A lengthened window is visible at the very next confirmation, before any push arrives.
    await setPolicy(DEFAULT_ORG_ID, 5, null)
    expect((await confirm(stub, [DEFAULT_ORG_ID])).entries).toEqual([
      { orgId: DEFAULT_ORG_ID, revision: 5, historyRetentionDays: null }
    ])
  })

  it('says “no policy” for a served org without one, whatever the daemon advertises', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    // An older daemon never sends the request; answering one anyway reads only what it serves.
    const { stub } = await connectDaemon(buildWsHarness(prisma), [])
    expect(await confirm(stub, [DEFAULT_ORG_ID])).toEqual({ entries: [], noPolicy: [DEFAULT_ORG_ID], denied: [] })
  })

  it('denies the connection’s own org when it serves no agent there', async () => {
    await setPolicy(DEFAULT_ORG_ID, 1, 7)
    const { stub } = await connectDaemon(buildWsHarness(prisma), [ORG_HISTORY_RETENTION_FEATURE])
    expect(await confirm(stub, [DEFAULT_ORG_ID])).toEqual({ entries: [], noPolicy: [], denied: [DEFAULT_ORG_ID] })
  })

  it('answers a pool member for every org it holds a duty in, and only those', async () => {
    const h = buildWsHarness(prisma)
    const saToken = await h.mintPoolMember(MEMBER)
    await prisma.org.create({ data: { id: ORG_B, slug: ORG_B } })
    await prisma.org.create({ data: { id: ORG_C, slug: ORG_C } })
    const setId = await poolSetId(prisma)
    await seedAgent(prisma, AGENT, { setId })
    await seedAgent(prisma, AGENT_B, { setId, orgId: ORG_B })
    // Placed on the same set but held by nobody: not this member's.
    await seedAgent(prisma, AGENT_C, { setId, orgId: ORG_C })
    const expiresAt = new Date(h.clock.now() + 120_000)
    await seedDutyGroup(prisma, GROUP_A, MEMBER, [AGENT], { expiresAt })
    await seedDutyGroup(prisma, GROUP_B, MEMBER, [AGENT_B], { expiresAt, orgId: ORG_B })
    await setPolicy(DEFAULT_ORG_ID, 3, 7)
    await setPolicy(ORG_C, 1, 1)

    const { stub } = h.connect()
    stub.inject('auth', { serviceAccountToken: saToken, daemonId: MEMBER, agentVersion: '1.4.0' })
    await stub.expectFrame('auth/ok')
    await register(stub, [ORG_HISTORY_RETENTION_FEATURE, ORG_HISTORY_RECLAIM_FEATURE])

    expect(await confirm(stub, [ORG_C, ORG_B, DEFAULT_ORG_ID])).toEqual({
      entries: [{ orgId: DEFAULT_ORG_ID, revision: 3, historyRetentionDays: 7 }],
      noPolicy: [ORG_B],
      denied: [ORG_C]
    })

    // An install-wide request must not name an org on its envelope.
    const id = stub.inject('history-retention/confirm', { orgIds: [DEFAULT_ORG_ID] }, { orgId: DEFAULT_ORG_ID })
    const refused = await replyTo(stub, id)
    expect(refused.type).toBe('error')
    expect(refused.payload).toMatchObject({ code: 'SCOPE_DENIED' })
  })
})
