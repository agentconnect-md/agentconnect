// The `artifact/*` requests go only to a CP that advertised their feature, and a refusal keeps its named reason (artifacts.md §5.3, §7.1).
import { describe, it, expect } from 'vitest'
import { ARTIFACT_SHARES_FEATURE, ARTIFACTS_FEATURE, buildEnvelope } from '@agentconnect.md/protocol'
import { WireError } from '@agentconnect.md/connection'
import { CpClient, type CpClientDeps } from '../../src/cp/client.js'
import { FakeTransport } from './fake-transport.js'
import { FakeClock } from './fake-clock.js'

const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const AGENT = '33333333-3333-4333-8333-333333333333'
const ORG = 'org-a'

const tick = () => new Promise((r) => setImmediate(r))

/** A frame-mode client that reached READY against a CP advertising `serverFeatures`. */
async function ready(serverFeatures: string[]) {
  const transports: FakeTransport[] = []
  const clock = new FakeClock()
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
    orgForAgent: (id: string) => (id === AGENT ? ORG : undefined),
    configApply: { applyConfigPush() {}, applyReconcileSnapshot() {} },
    clock,
    connect: async () => {
      const transport = new FakeTransport()
      transports.push(transport)
      return transport
    },
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} },
    jitter: () => 0
  } as unknown as CpClientDeps
  const client = new CpClient(deps)
  client.start()
  await tick()
  await handshake(transports[0]!, serverFeatures)
  return { client, t: transports[0]!, transports, clock }
}

async function handshake(t: FakeTransport, serverFeatures: string[]) {
  const authOk = {
    daemonId: DAEMON_ID,
    sessionEpoch: 1,
    heartbeatSec: 15,
    dutyLeaseMs: 120_000,
    serverTime: '2026-09-23T00:00:00.000Z',
    organizationMode: 'frame'
  }
  t.pushInbound(JSON.stringify(buildEnvelope('auth/ok', authOk, { corr: t.lastSent().id })))
  await tick()
  const snapshot = {
    routingEpoch: 1,
    serverFeatures,
    assignments: [],
    crons: [],
    leases: [],
    drop: { assignments: [], crons: [] }
  }
  t.pushInbound(JSON.stringify(buildEnvelope('register/ok', snapshot, { corr: t.lastSent().id })))
  await tick()
}

const ARTIFACT = '44444444-4444-4444-8444-444444444444'
const sentOf = (t: FakeTransport, type: string) => t.sent.map((raw) => JSON.parse(raw)).filter((f) => f.type === type)

const begin = {
  agentId: AGENT,
  sessionId: 'webchat:s-1',
  title: 'Report',
  manifest: {
    entry: 'index.html',
    files: [{ path: 'index.html', sha256: 'a'.repeat(64), bytes: 5, mediaType: 'text/html' }]
  },
  idempotencyKey: 'publish-0001',
  network: 'public' as const
}

describe('CpClient artifact requests', () => {
  it('offers nothing and sends nothing to a CP without the feature', async () => {
    const { client, t } = await ready([])
    expect(client.supportsArtifacts()).toBe(false)
    await expect(client.beginArtifactPublish(begin)).rejects.toThrow(/does not answer artifact\/publish\/begin/)
    await expect(client.listArtifacts({ agentId: AGENT, sessionId: 's' })).rejects.toThrow(/does not answer/)
    expect(sentOf(t, 'artifact/publish/begin')).toEqual([])
    client.stop()
  })

  it('sends a begin scoped to the agent’s org and resolves the signed uploads', async () => {
    const { client, t } = await ready([ARTIFACTS_FEATURE])
    expect(client.supportsArtifacts()).toBe(true)
    const answer = client.beginArtifactPublish(begin)
    await tick()
    const [sent] = sentOf(t, 'artifact/publish/begin')
    expect(sent.orgId).toBe(ORG)
    expect(sent.payload).toEqual(begin)
    const ok = {
      state: 'pending',
      artifactId: ARTIFACT,
      revision: 1,
      uploads: [
        { path: 'index.html', url: 'https://store.example.test/k?sig=put', headers: { 'content-length': '5' } }
      ],
      expiresAt: 1
    }
    t.pushInbound(JSON.stringify(buildEnvelope('artifact/publish/begin/ok', ok, { corr: sent.id, orgId: ORG })))
    await expect(answer).resolves.toEqual(ok)
    client.stop()
  })

  it('resolves complete, fetch and list replies', async () => {
    const { client, t } = await ready([ARTIFACTS_FEATURE])
    const published = {
      artifactId: ARTIFACT,
      revision: 1,
      title: 'Report',
      linkPath: `/acme/artifacts/${ARTIFACT}?revision=1`,
      audience: { visibility: 'org', owned: true }
    }
    const done = client.completeArtifactPublish({ agentId: AGENT, artifactId: ARTIFACT, revision: 1 })
    await tick()
    const [complete] = sentOf(t, 'artifact/publish/complete')
    t.pushInbound(
      JSON.stringify(buildEnvelope('artifact/publish/complete/ok', published, { corr: complete.id, orgId: ORG }))
    )
    await expect(done).resolves.toEqual(published)

    const listed = client.listArtifacts({ agentId: AGENT, sessionId: 'webchat:s-1' })
    await tick()
    const [list] = sentOf(t, 'artifact/list')
    t.pushInbound(JSON.stringify(buildEnvelope('artifact/list/ok', { artifacts: [] }, { corr: list.id, orgId: ORG })))
    await expect(listed).resolves.toEqual({ artifacts: [] })

    const fetched = client.fetchArtifact({
      agentId: AGENT,
      sessionId: 'webchat:s-1',
      artifactId: ARTIFACT,
      network: 'public'
    })
    await tick()
    const [fetch] = sentOf(t, 'artifact/fetch')
    const ok = {
      artifactId: ARTIFACT,
      revision: 1,
      title: 'Report',
      manifest: begin.manifest,
      downloads: [{ path: 'index.html', url: 'https://store.example.test/k?sig=get' }],
      expiresAt: 1
    }
    t.pushInbound(JSON.stringify(buildEnvelope('artifact/fetch/ok', ok, { corr: fetch.id, orgId: ORG })))
    await expect(fetched).resolves.toEqual(ok)
    client.stop()
  })

  it('shares and unshares only toward a CP that also advertises artifact-shares-v1', async () => {
    const share = { agentId: AGENT, sessionId: 'webchat:s-1', artifactId: ARTIFACT, audience: 'org' as const }
    const older = await ready([ARTIFACTS_FEATURE])
    expect(older.client.supportsArtifacts()).toBe(true)
    expect(older.client.supportsArtifactShares()).toBe(false)
    await expect(older.client.shareArtifact(share)).rejects.toThrow(/does not answer artifact\/share/)
    expect(sentOf(older.t, 'artifact/share')).toEqual([])
    older.client.stop()

    const { client, t } = await ready([ARTIFACTS_FEATURE, ARTIFACT_SHARES_FEATURE])
    expect(client.supportsArtifactShares()).toBe(true)
    const shared = client.shareArtifact(share)
    await tick()
    const [sent] = sentOf(t, 'artifact/share')
    expect(sent.orgId).toBe(ORG)
    const SHARE = '55555555-5555-4555-8555-555555555555'
    const ok = {
      shareId: SHARE,
      artifactId: ARTIFACT,
      revision: 1,
      audience: 'org',
      displayTail: '…abcdef',
      createdAt: '2026-11-27T10:00:00.000Z',
      linkPath: '/share/token-abcdef'
    }
    t.pushInbound(JSON.stringify(buildEnvelope('artifact/share/ok', ok, { corr: sent.id, orgId: ORG })))
    await expect(shared).resolves.toEqual(ok)

    const unshared = client.unshareArtifact({ ...share, shareId: SHARE })
    await tick()
    const [revoke] = sentOf(t, 'artifact/unshare')
    const revoked = {
      shareId: SHARE,
      artifactId: ARTIFACT,
      revision: 1,
      audience: 'org',
      revokedAt: '2026-11-27T10:00:00.000Z'
    }
    t.pushInbound(JSON.stringify(buildEnvelope('artifact/unshare/ok', revoked, { corr: revoke.id, orgId: ORG })))
    await expect(unshared).resolves.toEqual(revoked)
    client.stop()
  })

  it('rejects with the refusal’s code and reason', async () => {
    const { client, t } = await ready([ARTIFACTS_FEATURE])
    const refused = client.beginArtifactPublish({ ...begin, artifactId: ARTIFACT })
    await tick()
    const [sent] = sentOf(t, 'artifact/publish/begin')
    const error = { code: 'SCOPE_DENIED', message: 'not yours', retryable: false, details: { reason: 'not-producer' } }
    t.pushInbound(JSON.stringify(buildEnvelope('error', error, { corr: sent.id })))
    const err = await refused.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WireError)
    expect((err as WireError).code).toBe('SCOPE_DENIED')
    expect((err as WireError).details).toEqual({ reason: 'not-producer' })
    client.stop()
  })
})
