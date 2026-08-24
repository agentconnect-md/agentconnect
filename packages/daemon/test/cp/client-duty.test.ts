// The daemon half of the duty lease exchange on the wire: the heartbeat carries
// the digest only on an install-wide connection, the two C→D EVTs reach
// ConfigApply, and `duty/release` goes out as an org-less REQ.
import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope } from '@agentconnect.md/protocol'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const GROUP = '11111111-1111-4111-8111-111111111111'
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const silent = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setImmediate(r))

/** The install-wide pool, as `auth/ok` announces it. Membership — not the org mode — is what puts
 *  a connection in the duty ledger (daemon-groups.md §3), so it is what these tests vary. */
const POOL_SET = { setId: '9f11e5e7-0000-4000-8000-000000000001', name: 'Cloud' }

async function readyClient(
  over: Partial<CpClientDeps> = {},
  organizationMode: 'connection' | 'frame' = 'frame',
  memberSet: { setId: string; name: string } | null = POOL_SET
) {
  const t = new FakeTransport()
  const clock = new FakeClock()
  const configApply = {
    applyConfigPush: vi.fn(),
    applyDutyGrant: vi.fn(),
    applyDutyRevoke: vi.fn(),
    applyReconcileSnapshot: vi.fn(),
    applyAgentUpsert: vi.fn(async () => ({ ok: true })),
    applyAgentRemove: vi.fn(),
    applyAgentDetach: vi.fn(async () => ({ ok: true })),
    applyAgentActivate: vi.fn(async () => ({ ok: true })),
    upsertCron: vi.fn(),
    removeCron: vi.fn(),
    runCron: vi.fn(() => ({ ok: true })),
    applyRouteAssign: vi.fn(),
    applyRouteUpdate: vi.fn(),
    applyRelayRoster: vi.fn(),
    applyCollabRoutes: vi.fn(),
    applyIntegrationUpsert: vi.fn(),
    applyIntegrationRemove: vi.fn(),
    applyMcpServerUpsert: vi.fn(),
    applyMcpServerRemove: vi.fn(),
    applyMemoryConnectionUpsert: vi.fn(async () => ({ ok: true })),
    applyMemoryConnectionRemove: vi.fn(),
    applyAgentLaunch: vi.fn(async () => ({
      agentId: DAEMON_ID,
      launchId: DAEMON_ID,
      startedAt: '2026-06-26T00:00:00.000Z',
      runtime: 'claude'
    })),
    applyAgentStop: vi.fn(async () => ({ ok: true })),
    applyDaemonDrain: vi.fn(async () => ({ released: [] })),
    applyDaemonRestart: vi.fn(() => ({ accepted: true })),
    applyDaemonUpgrade: vi.fn(() => ({ accepted: true }))
  }
  const deps = {
    url: 'wss://cp/daemon/ws',
    token: 't',
    daemonId: DAEMON_ID,
    agentVersion: '0.0.0',
    host: 'h',
    heartbeatDefaultMs: 15000,
    maxAgents: 4,
    capabilities: () => ({ platforms: ['slack'], runtimes: [], acp: true, features: [] }),
    runtimeProfiles: () => [],
    localState: () => ({ assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }),
    loadSnapshot: () => ({ cpu: 0.1, mem: 0.2, agents: 1 }),
    activeSessions: () => 0,
    configApply: configApply as unknown as CpClientDeps['configApply'],
    workspaceRead: {
      list: vi.fn(async () => ({ agentId: 'a', path: '', exists: true, entries: [] })),
      read: vi.fn(async () => ({ agentId: 'a', path: 'f', exists: false })),
      write: vi.fn(async () => ({ agentId: 'a', path: 'f', size: 0, mtime: '2026-06-26T00:00:00.000Z' })),
      delete: vi.fn(async () => ({ agentId: 'a', path: 'f' }))
    } as unknown as CpClientDeps['workspaceRead'],
    sessionRead: {
      list: vi.fn(() => ({ sessions: [] })),
      history: vi.fn(() => ({ sessionId: DAEMON_ID, messages: [] })),
      toolBody: vi.fn(() => ({ sessionId: DAEMON_ID, toolCallId: 'tool', data: '', totalBytes: 0 }))
    } as unknown as CpClientDeps['sessionRead'],
    clock,
    connect: async () => t,
    log: silent,
    jitter: () => 0,
    ...over
  } as CpClientDeps
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
          sessionEpoch: 5,
          heartbeatSec: 15,
          serverTime: '2026-06-26T00:00:00.000Z',
          organizationMode,
          ...(memberSet ? { memberSet } : {})
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
  t.sent.length = 0
  return { t, clock, client, configApply }
}

/** Every frame the daemon has sent, decoded. */
const outbound = (t: FakeTransport): { type: string; id: string; orgId?: string; payload: any }[] =>
  t.sent.map((raw) => JSON.parse(raw))

const beat = async (t: FakeTransport, clock: FakeClock) => {
  clock.advance(15_000)
  await tick()
  return outbound(t).find((f) => f.type === 'heartbeat')
}

describe('daemon duty lease exchange', () => {
  it('an install-wide heartbeat carries the digest and headroom', async () => {
    const duties = vi.fn(() => ({ held: [{ groupId: GROUP, term: '2' }], headroom: 3 }))
    const { t, clock } = await readyClient({ duties })

    const hb = await beat(t, clock)
    expect(hb?.payload).toMatchObject({ duties: { held: [{ groupId: GROUP, term: '2' }], headroom: 3 } })
    expect(duties).toHaveBeenCalled()
  })

  it('a daemon in NO member set never sends duties, even when the getter is present', async () => {
    const duties = vi.fn(() => ({ held: [], headroom: 4 }))
    const { t, clock } = await readyClient({ duties }, 'connection', null)

    const hb = await beat(t, clock)
    expect(hb?.payload).not.toHaveProperty('duties')
    expect(duties).not.toHaveBeenCalled()
  })

  it('an ORG-SCOPED member sends them all the same — the org mode is not the predicate', async () => {
    // This is the regression: the gate used to read `organizationMode === 'frame'`, which agreed
    // with membership only while the pool was the one set that existed. An org's own group member
    // authenticates in `connection` mode, so it went duty-gated and silent — refusing to serve
    // what it held no lease for while never asking the CP for one.
    const duties = vi.fn(() => ({ held: [{ groupId: GROUP, term: '7' }], headroom: 1 }))
    const { t, clock } = await readyClient({ duties }, 'connection', { setId: GROUP, name: 'edge' })

    const hb = await beat(t, clock)
    expect(hb?.payload).toMatchObject({ duties: { held: [{ groupId: GROUP, term: '7' }], headroom: 1 } })
  })

  it('a daemon with no duty getter sends a plain heartbeat (path dormant)', async () => {
    const { t, clock } = await readyClient({})

    const hb = await beat(t, clock)
    expect(hb).toBeDefined()
    expect(hb?.payload).not.toHaveProperty('duties')
  })

  it('duty/grant and duty/revoke reach ConfigApply as org-less EVTs, with no reply', async () => {
    const { t, configApply } = await readyClient({})

    const grants = [{ groupId: GROUP, orgId: 'org-1', term: '1', members: [{ kind: 'agent', refId: AGENT }] }]
    t.pushInbound(JSON.stringify(buildEnvelope('duty/grant', { grants })))
    await tick()
    expect(configApply.applyDutyGrant).toHaveBeenCalledWith(grants)

    const revocations = [{ groupId: GROUP, reason: 'superseded' }]
    t.pushInbound(JSON.stringify(buildEnvelope('duty/revoke', { revocations })))
    await tick()
    expect(configApply.applyDutyRevoke).toHaveBeenCalledWith(revocations)

    // EVTs: nothing goes back, in particular no SCOPE_DENIED for the missing org.
    expect(outbound(t).filter((f) => f.type === 'error')).toEqual([])
    expect(outbound(t).filter((f) => f.type === 'ack')).toEqual([])
  })

  it('duty/release goes out as an org-less REQ and settles on the ack', async () => {
    const { t, client } = await readyClient({})

    const done = client.releaseDuties([GROUP])
    await tick()
    const req = outbound(t).find((f) => f.type === 'duty/release')
    expect(req?.payload).toEqual({ groupIds: [GROUP] })
    expect(req?.orgId).toBeUndefined()

    t.pushInbound(JSON.stringify(buildEnvelope('ack', { ok: true }, { corr: req!.id as string })))
    await expect(done).resolves.toBeUndefined()
  })

  it('duty/fetch carries the granted org and settles on duty/fetch/ok', async () => {
    const { t, client } = await readyClient({})

    const done = client.fetchDutyAgent(AGENT, 'org-1')
    await tick()
    const req = outbound(t).find((f) => f.type === 'duty/fetch')
    expect(req?.payload).toEqual({ agentId: AGENT })
    // The frame names its own org: the daemon does not yet know this agent, so
    // there is nothing local to resolve it from.
    expect(req?.orgId).toBe('org-1')

    // The reply echoes the request org — a frame-mode member fences it on that.
    t.pushInbound(JSON.stringify(buildEnvelope('duty/fetch/ok', {}, { corr: req!.id as string, orgId: 'org-1' })))
    await expect(done).resolves.toEqual({})
  })

  it('releasing nothing is a no-op — no frame at all', async () => {
    const { t, client } = await readyClient({})
    await client.releaseDuties([])
    expect(outbound(t).filter((f) => f.type === 'duty/release')).toEqual([])
  })
})
