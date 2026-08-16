// The daemon end of the frame-scoped organization contract (k8s-daemon-pool.md M4): on an
// install-wide (frame-mode) connection the client refuses to send an org-scoped frame it cannot
// scope, never stamps an org on an install-wide one, checks every inbound org-scoped control
// against its own registry before applying it, and fences a correlated reply on the org of the
// request it answers. On an org-scoped (API-key) connection none of that tightens.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const UNKNOWN_AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'
const CRON = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const ORG_A = 'org-a'
const ORG_B = 'org-b'

const tick = () => new Promise((r) => setImmediate(r))

async function ready(mode: 'frame' | 'connection') {
  const t = new FakeTransport()
  const clock = new FakeClock()
  const warn = vi.fn()
  const runCron = vi.fn(() => ({ ok: true }))
  const deps = {
    url: 'wss://cp.example.test/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15_000,
    maxAgents: 4,
    capabilities: () => ({ platforms: [], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0, mem: 0, agents: 0 }),
    activeSessions: () => 0,
    orgForAgent: (agentId: string) => (agentId === AGENT ? ORG_A : undefined),
    orgForCron: (cronId: string) => (cronId === CRON ? ORG_A : undefined),
    configApply: {
      applyConfigPush() {},
      applyReconcileSnapshot() {},
      applyDutyGrant() {},
      applyDutyRevoke() {},
      upsertCron() {},
      removeCron() {},
      runCron,
      applyRouteAssign() {},
      applyRouteUpdate() {}
    },
    clock,
    connect: async () => t,
    log: { trace() {}, debug() {}, info() {}, warn, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  const auth = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'auth/ok',
        {
          daemonId: DAEMON_ID,
          sessionEpoch: 1,
          heartbeatSec: 15,
          dutyLeaseMs: 120_000,
          serverTime: '2026-08-14T00:00:00.000Z',
          organizationMode: mode
        },
        { corr: auth.id }
      )
    )
  )
  await tick()
  const reg = t.lastSent()
  t.pushInbound(
    JSON.stringify(
      buildEnvelope(
        'register/ok',
        {
          routingEpoch: 1,
          serverFeatures: [],
          assignments: [],
          crons: [],
          leases: [],
          drop: { assignments: [], crons: [] }
        },
        { corr: reg.id }
      )
    )
  )
  await tick()
  return { client, t, warn, runCron }
}

const sent = (t: FakeTransport) => t.sent.map((raw) => JSON.parse(raw))
const errorsFor = (t: FakeTransport, corr: string) => sent(t).filter((f) => f.type === 'error' && f.corr === corr)

/** Push one CP control frame and settle its dispatch. */
async function control(t: FakeTransport, type: string, payload: unknown, orgId?: string): Promise<string> {
  const frame = buildEnvelope(type as never, payload, { ...(orgId ? { orgId } : {}), ext: { epoch: 1 } })
  t.pushInbound(JSON.stringify(frame))
  await tick()
  return frame.id
}

describe('frame mode: inbound controls', () => {
  it('refuses an org-scoped control that names no org, and applies nothing', async () => {
    const { t, warn, runCron } = await ready('frame')
    const id = await control(t, 'cron/run', { cronId: CRON })
    expect(errorsFor(t, id)).toMatchObject([{ payload: { code: 'SCOPE_DENIED' } }])
    expect(runCron).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused cron/run'))
  })

  it('refuses a control naming an org that does not own the targeted resource', async () => {
    const { t, runCron } = await ready('frame')
    const id = await control(t, 'cron/run', { cronId: CRON }, ORG_B)
    expect(errorsFor(t, id)).toMatchObject([
      { payload: { code: 'SCOPE_DENIED', message: 'organization does not match the targeted resource' } }
    ])
    expect(runCron).not.toHaveBeenCalled()
  })

  it('applies a control naming the owning org and echoes it on the reply', async () => {
    const { t, runCron } = await ready('frame')
    const id = await control(t, 'cron/run', { cronId: CRON }, ORG_A)
    expect(runCron).toHaveBeenCalledWith(CRON)
    expect(sent(t).find((f) => f.type === 'ack' && f.corr === id)?.orgId).toBe(ORG_A)
  })

  it('refuses an install-wide control that carries an org', async () => {
    const { t } = await ready('frame')
    const id = await control(t, 'config/push', { keys: {} }, ORG_A)
    expect(errorsFor(t, id)).toMatchObject([{ payload: { code: 'SCOPE_DENIED' } }])
    const bare = await control(t, 'config/push', { keys: {} })
    expect(errorsFor(t, bare)).toEqual([])
  })

  it('drops an uncorrelated generic reply without answering it', async () => {
    const { t } = await ready('frame')
    const before = sent(t).length
    t.pushInbound(
      JSON.stringify(buildEnvelope('error', { code: 'INTERNAL', message: 'late', retryable: false }, { corr: CRON }))
    )
    await tick()
    expect(sent(t).length).toBe(before)
  })
})

describe('frame mode: outbound frames', () => {
  it('refuses to send an org-scoped frame it cannot scope', async () => {
    const { client, t } = await ready('frame')
    const before = sent(t).length
    await expect(client.channelAgents({ platform: 'slack', requesterAgentId: UNKNOWN_AGENT })).rejects.toMatchObject({
      code: 'SCOPE_DENIED'
    })
    expect(sent(t).length).toBe(before)
  })

  it('stamps the resolved org on an org-scoped frame and none on an install-wide one', async () => {
    const { client, t } = await ready('frame')
    void client.channelAgents({ platform: 'slack', requesterAgentId: AGENT }).catch(() => {})
    void client.claimDuty(AGENT).catch(() => {})
    await tick()
    expect(sent(t).find((f) => f.type === 'channel/agents')?.orgId).toBe(ORG_A)
    // The claim names an agent this member knows, and still carries no org: duty frames are install-wide.
    expect(sent(t).find((f) => f.type === 'duty/claim')).toMatchObject({ payload: { agentId: AGENT } })
    expect(sent(t).find((f) => f.type === 'duty/claim')?.orgId).toBeUndefined()
  })
})

describe('frame mode: correlated replies', () => {
  it('fails the request when the reply does not carry its org, and never resolves it', async () => {
    const { client, t, warn } = await ready('frame')
    const pending = client.fetchDutyAgent(AGENT, ORG_A)
    await tick()
    const req = sent(t).find((f) => f.type === 'duty/fetch')!
    expect(req.orgId).toBe(ORG_A)
    t.pushInbound(JSON.stringify(buildEnvelope('duty/fetch/ok', {}, { corr: req.id })))
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped duty/fetch/ok reply'))
  })

  it('fails the request when the reply names another org', async () => {
    const { client, t } = await ready('frame')
    const pending = client.fetchDutyAgent(AGENT, ORG_A)
    await tick()
    const req = sent(t).find((f) => f.type === 'duty/fetch')!
    t.pushInbound(JSON.stringify(buildEnvelope('duty/fetch/ok', {}, { corr: req.id, orgId: ORG_B })))
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })

  it('settles the request when the reply carries its org; an error reply needs none', async () => {
    const { client, t } = await ready('frame')
    const pending = client.fetchDutyAgent(AGENT, ORG_A)
    await tick()
    const req = sent(t).find((f) => f.type === 'duty/fetch')!
    t.pushInbound(JSON.stringify(buildEnvelope('duty/fetch/ok', {}, { corr: req.id, orgId: ORG_A })))
    await expect(pending).resolves.toEqual({})
    const failing = client.fetchDutyAgent(AGENT, ORG_A)
    await tick()
    const req2 = sent(t)
      .filter((f) => f.type === 'duty/fetch')
      .at(-1)!
    t.pushInbound(
      JSON.stringify(
        buildEnvelope('error', { code: 'LEASE_DENIED', message: 'no', retryable: false }, { corr: req2.id })
      )
    )
    await expect(failing).rejects.toMatchObject({ code: 'LEASE_DENIED' })
  })

  it('a reply to an install-wide request must not name an org', async () => {
    const { client, t } = await ready('frame')
    const pending = client.claimDuty(AGENT)
    await tick()
    const req = sent(t).find((f) => f.type === 'duty/claim')!
    t.pushInbound(JSON.stringify(buildEnvelope('duty/claim/ok', { granted: false }, { corr: req.id, orgId: ORG_A })))
    await expect(pending).rejects.toMatchObject({ code: 'SCOPE_DENIED' })
  })
})

describe('connection mode (API key): unchanged', () => {
  it('applies an unscoped control and takes an install-wide control that names the org', async () => {
    const { t, runCron } = await ready('connection')
    const bare = await control(t, 'cron/run', { cronId: CRON })
    expect(errorsFor(t, bare)).toEqual([])
    expect(runCron).toHaveBeenCalledWith(CRON)
    const push = await control(t, 'config/push', { keys: {} }, ORG_A)
    expect(errorsFor(t, push)).toEqual([])
  })

  it('sends an org-scoped frame for an agent it cannot place in an org, and settles an org-less reply', async () => {
    const { client, t } = await ready('connection')
    const pending = client.channelAgents({ platform: 'slack', requesterAgentId: UNKNOWN_AGENT })
    await tick()
    const req = sent(t).find((f) => f.type === 'channel/agents')!
    expect(req.orgId).toBeUndefined()
    t.pushInbound(
      JSON.stringify(buildEnvelope('channel/agents/ok', { platform: 'slack', agents: [] }, { corr: req.id }))
    )
    await expect(pending).resolves.toEqual({ platform: 'slack', agents: [] })
  })
})
