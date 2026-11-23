// Per-org history retention reaches the daemons serving the org: in register/ok and on a policy change (org-session-policy.md, History retention).
import { describe, expect, it } from 'vitest'
import {
  CONFIG_KEY_ORG_HISTORY_RETENTION,
  ORG_HISTORY_RETENTION_FEATURE,
  isFrame,
  type RegisterOk
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { PgOrgSessionPolicyRepo } from '../../src/persistence/repositories/org-session-policy.repo.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-0000000000a1'
const OTHER_DAEMON = 'dddddddd-dddd-4ddd-8ddd-0000000000a2'
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-0000000000a1'
const AUTH_ID = '11111111-1111-4111-8111-0000000000a1'
const REG_ID = '22222222-2222-4222-8222-0000000000a1'
const TOKEN = 'session-policy-token-0123456789abcdef'

async function seedDaemon(id: string): Promise<void> {
  await prisma.daemon.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      sessionEpoch: 1n,
      routingEpoch: 1n,
      maxAgents: 4,
      status: 'ready',
      approvalStatus: 'approved'
    }
  })
}

async function seedAgent(daemonId: string): Promise<void> {
  await prisma.agent.create({
    data: { id: AGENT, orgId: DEFAULT_ORG_ID, name: 'agent-1', runtime: 'claude', daemonId }
  })
}

async function setPolicy(revision: number, historyRetentionDays: number | null): Promise<void> {
  const applied = await new PgOrgSessionPolicyRepo(prisma).apply(DEFAULT_ORG_ID, {
    revision,
    monthlySessionLimit: null,
    historyRetentionDays,
    enforce: false
  })
  expect(applied).toBe(revision)
}

async function register(features: string[]): Promise<RegisterOk> {
  const h = buildWsHarness(prisma)
  const token = await h.mintToken(DAEMON)
  const { stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' }, { id: AUTH_ID })
  await stub.expectFrame('auth/ok')
  stub.inject(
    'register',
    {
      host: 'host-1',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features },
      maxAgents: 4,
      localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
    },
    { id: REG_ID }
  )
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return ok.payload
}

describe('register/ok — org history retention', () => {
  it('carries every served org and the policy among them to a daemon that reads it', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(DAEMON)
    await setPolicy(4, 7)
    const snap = await register([ORG_HISTORY_RETENTION_FEATURE])
    expect(snap.orgHistoryRetention).toEqual({
      orgIds: [DEFAULT_ORG_ID],
      entries: [{ orgId: DEFAULT_ORG_ID, revision: 4, historyRetentionDays: 7 }]
    })
  })

  it('lists an org without a policy and no entry, and carries unlimited as null', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(DAEMON)
    expect((await register([ORG_HISTORY_RETENTION_FEATURE])).orgHistoryRetention).toEqual({
      orgIds: [DEFAULT_ORG_ID],
      entries: []
    })
    await setPolicy(1, null)
    expect((await register([ORG_HISTORY_RETENTION_FEATURE])).orgHistoryRetention?.entries).toEqual([
      { orgId: DEFAULT_ORG_ID, revision: 1, historyRetentionDays: null }
    ])
  })

  it('names the connection’s own org even before it serves an agent', async () => {
    await seedDaemon(DAEMON)
    await setPolicy(2, 30)
    expect((await register([ORG_HISTORY_RETENTION_FEATURE])).orgHistoryRetention).toEqual({
      orgIds: [DEFAULT_ORG_ID],
      entries: [{ orgId: DEFAULT_ORG_ID, revision: 2, historyRetentionDays: 30 }]
    })
  })

  it('omits the field for an older daemon that does not advertise the feature', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(DAEMON)
    await setPolicy(1, 7)
    const snap = await register([])
    expect(snap).not.toHaveProperty('orgHistoryRetention')
    // The daemon-wide window keeps riding exactly as before.
    expect(snap.sessionRetention).toBeDefined()
  })
})

describe('PUT session-policy — history retention push', () => {
  function liveness(features: Record<string, string[]>): DaemonLiveness {
    return {
      get: (id: string) =>
        features[id]
          ? { state: 'READY', reachable: true, sessionEpoch: 1, capabilities: { features: features[id]! } }
          : undefined
    } as DaemonLiveness
  }

  async function withApp(
    features: Record<string, string[]>,
    run: (
      put: (body: Record<string, unknown>) => Promise<number>,
      pushes: Array<{ id: string; keys: unknown }>
    ) => Promise<void>
  ) {
    const pushes: Array<{ id: string; keys: unknown }> = []
    const control = {
      configPush: (id: string, keys: Record<string, unknown>) => void pushes.push({ id, keys })
    } as unknown as ControlSender
    const { app, close } = buildHttpApp(prisma, { SESSION_POLICY_TOKEN: TOKEN }, liveness(features), control)
    const put = async (body: Record<string, unknown>) =>
      (
        await app.inject({
          method: 'PUT',
          url: `/api/v1/internal/orgs/${DEFAULT_ORG_ID}/session-policy`,
          headers: { authorization: `Bearer ${TOKEN}` },
          payload: { monthlySessionLimit: null, enforce: false, ...body }
        })
      ).statusCode
    try {
      await run(put, pushes)
    } finally {
      await close()
    }
  }

  it('pushes an applied revision to the READY daemons serving the org that read it, and nothing for a stale one', async () => {
    await seedDaemon(DAEMON)
    await seedDaemon(OTHER_DAEMON)
    await seedAgent(DAEMON)
    await withApp(
      { [DAEMON]: [ORG_HISTORY_RETENTION_FEATURE], [OTHER_DAEMON]: [ORG_HISTORY_RETENTION_FEATURE] },
      async (put, pushes) => {
        expect(await put({ revision: 3, historyRetentionDays: 7 })).toBe(200)
        // Only the daemon serving the org's agent; the other READY daemon serves nothing of it.
        expect(pushes).toEqual([
          {
            id: DAEMON,
            keys: {
              [CONFIG_KEY_ORG_HISTORY_RETENTION]: { orgId: DEFAULT_ORG_ID, revision: 3, historyRetentionDays: 7 }
            }
          }
        ])
        pushes.length = 0
        expect(await put({ revision: 2, historyRetentionDays: 1 })).toBe(200)
        expect(pushes).toEqual([])
        expect(await put({ revision: 5, historyRetentionDays: null })).toBe(200)
        expect(pushes).toEqual([
          {
            id: DAEMON,
            keys: {
              [CONFIG_KEY_ORG_HISTORY_RETENTION]: { orgId: DEFAULT_ORG_ID, revision: 5, historyRetentionDays: null }
            }
          }
        ])
      }
    )
    // A reconnect converges to the same stored policy.
    expect((await register([ORG_HISTORY_RETENTION_FEATURE])).orgHistoryRetention?.entries).toEqual([
      { orgId: DEFAULT_ORG_ID, revision: 5, historyRetentionDays: null }
    ])
  })

  it('sends no push to an older daemon, which keeps its daemon-wide window', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(DAEMON)
    await withApp({ [DAEMON]: [] }, async (put, pushes) => {
      expect(await put({ revision: 1, historyRetentionDays: 7 })).toBe(200)
      expect(pushes).toEqual([])
    })
  })

  it('still applies the policy when a push fails', async () => {
    await seedDaemon(DAEMON)
    await seedAgent(DAEMON)
    const control = {
      configPush: () => {
        throw new Error('socket gone')
      }
    } as unknown as ControlSender
    const { app, close } = buildHttpApp(
      prisma,
      { SESSION_POLICY_TOKEN: TOKEN },
      liveness({ [DAEMON]: [ORG_HISTORY_RETENTION_FEATURE] }),
      control
    )
    try {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/internal/orgs/${DEFAULT_ORG_ID}/session-policy`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { revision: 1, monthlySessionLimit: null, historyRetentionDays: 7, enforce: false }
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ appliedRevision: 1 })
    } finally {
      await close()
    }
  })
})
