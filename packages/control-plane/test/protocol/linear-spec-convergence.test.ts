/**
 * Fail-closed convergence for a provider-held credential that is gone
 * (linear-integration.md §4.4, §7.4) — over the real reconcile snapshot.
 *
 * The hazard this pins is a near miss. A provider that answers "no payload" used to yield a spec
 * whose `config` was absent, and that spec still rode the roster: its id stayed in the desired set,
 * so it never reached `drop.integrations`, and the daemon's reader — which refuses a config-less
 * spec but only ever SETS entries on converge — kept the last good one. The dead grant would have
 * gone on being used.
 *
 * So the assertion is in two halves, and the second is the load-bearing one: with the grant present
 * the integration is delivered; with the grant deleted the SAME register is answered by absence
 * from `integrations` AND presence in `drop.integrations`, which is what makes the daemon remove it.
 */
import { describe, it, expect } from 'vitest'
import { isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness, TEST_LINEAR_APP } from '../fakes/build-ws.js'
import { PgLinearTokenStore } from '../../src/persistence/repositories/linear.repo.js'
import { PlaintextSecretCipher } from '../../src/secrets/cipher.js'
import { OrgId } from '../../src/domain/ids.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'
const BOT = 'e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5'
const INTEGRATION = 'f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6'
const WORKSPACE = 'org_alpha'

const AUTH_ID = '11111111-1111-4111-8111-111111111111'
const REG_ID = '22222222-2222-4222-8222-222222222222'

const identity = { orgId: OrgId(DEFAULT_ORG_ID), clientId: TEST_LINEAR_APP.clientId, organizationId: WORKSPACE }

/** One connected workspace with one enabled agent, placed on the registering daemon. */
async function seedConnectedWorkspace(): Promise<void> {
  await prisma.daemon.create({
    data: { id: DAEMON, orgId: DEFAULT_ORG_ID, sessionEpoch: 1n, routingEpoch: 1n, maxAgents: 4, status: 'ready' }
  })
  await prisma.agent.create({
    data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'agent-1', runtime: 'claude', daemonId: DAEMON }
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
  await new PgLinearTokenStore(prisma, new PlaintextSecretCipher()).put(identity, {
    accessToken: 'lin_oauth_access',
    refreshToken: 'lin_oauth_refresh',
    expiresAt: new Date('2026-01-02T00:00:00.000Z')
  })
}

/** The daemon reports it already holds the CP-owned integration — the replica at risk. */
function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: ['linear'], runtimes: ['claude'], acp: true },
    maxAgents: 4,
    localState: {
      assignments: [],
      crons: [],
      leases: [],
      agents: [{ agentId: AGENT, origin: 'cp' as const }],
      integrations: [{ integrationId: INTEGRATION, origin: 'cp' as const }],
      stagedAgents: [] as Array<{ agentId: string; moveId?: string }>
    }
  }
}

async function snapshot(h: ReturnType<typeof buildWsHarness>) {
  const token = await h.mintToken(DAEMON)
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject('register', registerPayload(), { id: REG_ID })
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return ok.payload
}

describe('a Linear workspace whose grant is gone converges to removal', () => {
  it('delivers the integration while the grant is live', async () => {
    await seedConnectedWorkspace()
    const snap = await snapshot(buildWsHarness(prisma))
    expect(snap.integrations.map((i) => i.integrationId)).toEqual([INTEGRATION])
    expect(snap.integrations[0]?.config).toMatchObject({
      workspaceId: WORKSPACE,
      accessToken: 'lin_oauth_access'
    })
    expect(snap.drop.integrations).toEqual([])
  })

  it('drops it from the daemon once the grant is deleted — never a retained prior spec', async () => {
    await seedConnectedWorkspace()
    await new PgLinearTokenStore(prisma, new PlaintextSecretCipher()).delete(identity)

    const snap = await snapshot(buildWsHarness(prisma))
    // Withheld from the deliverable roster…
    expect(snap.integrations).toEqual([])
    // …and named in the prune list, which is what actually removes the daemon's entry. A
    // config-less spec would have satisfied neither: present in `integrations`, absent from `drop`.
    expect(snap.drop.integrations).toEqual([INTEGRATION])
  })

  it('withholds only the integration — the agent replica itself is untouched', async () => {
    await seedConnectedWorkspace()
    await new PgLinearTokenStore(prisma, new PlaintextSecretCipher()).delete(identity)

    const snap = await snapshot(buildWsHarness(prisma))
    expect(snap.agents.map((a) => a.agentId)).toEqual([AGENT])
    expect(snap.drop.agents).toEqual([])
  })
})
