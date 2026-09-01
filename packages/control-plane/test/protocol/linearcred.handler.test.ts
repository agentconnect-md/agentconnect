/**
 * The `linearcred` broker over the real daemon WS edge, real Postgres, and a scripted Linear
 * (linear-integration.md §4.4, §7.3).
 *
 * Three claims the unit tests cannot make, because each is about a durable row:
 *
 *  - PERSIST BEFORE REPLY. A near-expiry grant rotates upstream, and the rotated pair is written
 *    durably BEFORE the daemon sees the token. Replying first would strand a workspace holding a
 *    refresh token Linear has already spent, so the ordering is asserted as an ordering — not as
 *    "the row happens to be right afterwards".
 *  - THE RE-PUSH RIDES THE SHARED CONVERGE. One rotation invalidates the token in every member's
 *    `agent.json`, so the grant is followed by the same integration converge a gating flip takes,
 *    whose http-bot arm re-syncs the workspace bot.
 *  - THE SCOPE CHECK IS PLACEMENT, NOT POSSESSION. A daemon that does not serve the integration's
 *    agent is refused terminally even though the grant it asked for exists and is perfectly live.
 */
import { describe, it, expect } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness, TEST_LINEAR_APP } from '../fakes/build-ws.js'
import { InMemoryDaemonStub } from '../fakes/daemon-stub.js'
import { PgLinearTokenStore } from '../../src/persistence/repositories/linear.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { LinearApiClient } from '../../src/platforms/linear/api.js'
import { LinearTokenService } from '../../src/platforms/linear/token-service.js'
import { OrgId } from '../../src/domain/ids.js'
import type { LinearTokenStore } from '../../src/persistence/ports.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const FOREIGN_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const BOT = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'
const INTEGRATION = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6'
const WORKSPACE = 'org_alpha'

const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: TEST_LINEAR_APP.clientId, organizationId: WORKSPACE }
const store = () => new PgLinearTokenStore(prisma, new PlaintextSecretCipher())

/** The harness clock's now, so "fresh" and "near expiry" are stated against the same clock the
 *  refresh margin is measured on rather than against wall time. */
const NOW = 1_700_000_000_000
const FRESH = new Date(NOW + 20 * 60 * 60 * 1000)
const NEAR_EXPIRY = new Date(NOW + 30 * 60 * 1000)

/** A connected workspace with one enabled agent placed on `daemonId`, and a stored grant. */
async function seedConnectedWorkspace(expiresAt: Date, daemonId = DAEMON): Promise<void> {
  for (const id of new Set([daemonId, DAEMON])) {
    await prisma.daemon.create({
      data: { id, orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, routingEpoch: 1n, maxAgents: 4, status: 'ready' }
    })
  }
  await prisma.agent.create({
    data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'agent-1', runtime: 'claude', daemonId }
  })
  await prisma.bot.create({
    data: {
      id: BOT,
      orgId: DEFAULT_ORG_ID,
      platform: 'linear',
      name: 'Acme Engineering',
      transport: 'http',
      shareable: true,
      workspaceId: WORKSPACE,
      workspaceName: 'Acme Engineering',
      botUserId: 'user_app_1',
      externalAppId: TEST_LINEAR_APP.clientId,
      externalTenantId: WORKSPACE
    }
  })
  await prisma.botSecret.create({
    data: { botId: BOT, botToken: TEST_LINEAR_APP.clientSecret, signingSecret: TEST_LINEAR_APP.signingSecret }
  })
  await prisma.integration.create({
    data: {
      id: INTEGRATION,
      orgId: DEFAULT_ORG_ID,
      agentId: AGENT,
      botId: BOT,
      platform: 'linear',
      name: 'Acme Engineering',
      status: 'active'
    }
  })
  await store().put(identity, { accessToken: 'lin_access_1', refreshToken: 'lin_refresh_1', expiresAt })
}

/** A Linear whose `/oauth/token` answer is the test's variable, with a log of what was asked. */
function fakeLinear(answer: () => { status: number; body: unknown }) {
  const calls: string[] = []
  return {
    calls,
    fetchImpl: (url: string, init?: RequestInit): Promise<Response> => {
      calls.push(String(url))
      const { status, body } = answer()
      return Promise.resolve(
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
      )
    }
  }
}

const ROTATED = () => ({
  status: 200,
  body: { access_token: 'lin_access_2', refresh_token: 'lin_refresh_2', expires_in: 86400 }
})

async function ready(h: ReturnType<typeof buildWsHarness>, daemonId: string, stub = new InMemoryDaemonStub()) {
  const token = await h.mintToken(daemonId)
  h.connect(stub)
  stub.inject('auth', { apiKey: token, daemonId, agentVersion: '1.4.0' })
  await stub.expectFrame('auth/ok')
  stub.inject('register', {
    host: 'daemon-1',
    capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true, features: [] },
    maxAgents: 4,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  })
  await stub.expectFrame('register/ok')
  return stub
}

function grantOf(stub: InMemoryDaemonStub, id: string) {
  const rep = stub.sent.find((f) => f.corr === id && f.type === 'linearcred/grant')
  return rep && isFrame('linearcred/grant')(rep) ? rep.payload : undefined
}

function errorOf(stub: InMemoryDaemonStub, id: string) {
  const rep = stub.sent.find((f) => f.corr === id && f.type === 'error')
  return rep && isFrame('error')(rep) ? rep.payload : undefined
}

describe('linearcred/request over the daemon WS edge', () => {
  it('grants the stored token to the placed daemon without touching Linear', async () => {
    await seedConnectedWorkspace(FRESH)
    const h = buildWsHarness(prisma, { startMs: NOW })
    const linear = fakeLinear(ROTATED)
    h.linearStubs.fetch = linear.fetchImpl
    const stub = await ready(h, DAEMON)

    const id = stub.inject('linearcred/request', { integrationId: INTEGRATION })
    await stub.settled()

    expect(grantOf(stub, id)).toEqual({ accessToken: 'lin_access_1', expiresAt: FRESH.toISOString() })
    // A token that is nowhere near expiry is not a reason to spend a refresh token.
    expect(linear.calls).toEqual([])
    expect(h.httpBotSyncs).toEqual([])
  })

  it('refuses a daemon that does not serve the agent, however live the grant is', async () => {
    await seedConnectedWorkspace(FRESH)
    const h = buildWsHarness(prisma, { startMs: NOW })
    h.linearStubs.fetch = fakeLinear(ROTATED).fetchImpl
    const stub = await ready(h, FOREIGN_DAEMON)

    const id = stub.inject('linearcred/request', { integrationId: INTEGRATION })
    await stub.settled()

    expect(grantOf(stub, id)).toBeUndefined()
    expect(errorOf(stub, id)).toMatchObject({ code: 'SCOPE_DENIED', retryable: false })
  })

  it('answers a refresh Linear definitively rejects with a terminal LEASE_DENIED', async () => {
    await seedConnectedWorkspace(NEAR_EXPIRY)
    const h = buildWsHarness(prisma, { startMs: NOW })
    h.linearStubs.fetch = fakeLinear(() => ({ status: 400, body: { error: 'invalid_grant' } })).fetchImpl
    const stub = await ready(h, DAEMON)

    const id = stub.inject('linearcred/request', { integrationId: INTEGRATION })
    await stub.settled()

    expect(grantOf(stub, id)).toBeUndefined()
    // Terminal: only an operator reconnect can repair it, so the daemon must stop asking.
    expect(errorOf(stub, id)).toMatchObject({ code: 'LEASE_DENIED', retryable: false })
    expect(h.httpBotSyncs).toEqual([])
  })

  it('leaves an unreachable Linear retryable — a blip is not proof the grant is dead', async () => {
    await seedConnectedWorkspace(NEAR_EXPIRY)
    const h = buildWsHarness(prisma, { startMs: NOW })
    h.linearStubs.fetch = () => Promise.reject(new Error('connect ECONNREFUSED'))
    const stub = await ready(h, DAEMON)

    const id = stub.inject('linearcred/request', { integrationId: INTEGRATION })
    await stub.settled()

    expect(errorOf(stub, id)).toMatchObject({ code: 'INTERNAL', retryable: true })
    // The stored grant is untouched: the daemon keeps running on the token it still holds.
    expect(await store().get(identity)).toMatchObject({ accessToken: 'lin_access_1' })
  })

  it('persists the rotated pair BEFORE the grant frame, then re-pushes the workspace bot’s specs', async () => {
    await seedConnectedWorkspace(NEAR_EXPIRY)
    const h = buildWsHarness(prisma, { startMs: NOW })
    const linear = fakeLinear(ROTATED)

    // The ordering is observed on the two events themselves — the durable write and the frame —
    // rather than by reading the row after the fact, which cannot tell the two orders apart.
    const order: string[] = []
    const base = store()
    const observed: LinearTokenStore = {
      get: (i) => base.get(i),
      put: async (i, m) => {
        await base.put(i, m)
        order.push('persisted')
      },
      delete: (i) => base.delete(i),
      listOrphans: (c, s, l) => base.listOrphans(c, s, l),
      withIdentityLock: (i, act) => base.withIdentityLock(i, act)
    }
    h.deps.linearTokens = new LinearTokenService({
      app: TEST_LINEAR_APP,
      tokens: observed,
      api: new LinearApiClient({ clock: h.clock, fetchImpl: linear.fetchImpl }),
      clock: h.clock
    })
    const stub = new InMemoryDaemonStub()
    const send = stub.send.bind(stub)
    stub.send = (text: string) => {
      if (text.includes('linearcred/grant')) order.push('granted')
      send(text)
    }
    await ready(h, DAEMON, stub)

    const id = stub.inject('linearcred/request', { integrationId: INTEGRATION })
    await stub.settled()

    expect(order).toEqual(['persisted', 'granted'])
    expect(grantOf(stub, id)).toMatchObject({ accessToken: 'lin_access_2' })
    expect(await store().get(identity)).toMatchObject({
      accessToken: 'lin_access_2',
      refreshToken: 'lin_refresh_2'
    })
    // The rotation invalidated the token in every member's `agent.json`, so the shared converge runs.
    expect(h.httpBotSyncs).toEqual([BOT])
  })
})
