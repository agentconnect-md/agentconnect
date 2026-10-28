/**
 * `daemon/lifecycle/begin` (daemon-auto-upgrade.md §6) and the auto-upgrade parts of `register/ok`.
 * Runs over the `InMemoryDaemonStub` against real Testcontainers Postgres.
 */
import { describe, it, expect } from 'vitest'
import { DAEMON_AUTO_UPGRADE_FEATURE, DAEMON_LIFECYCLE_BEGIN_FEATURE, isFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildWsHarness } from '../fakes/build-ws.js'
import { DaemonId } from '../../src/domain/ids.js'
import { AUTO_UPGRADE_DEADLINE_MS } from '../../src/ws/handlers/daemon-lifecycle-begin.js'

const DAEMON = 'ababab01-abab-4bab-8bab-abababababab'

function registerPayload() {
  return {
    host: 'host-1',
    capabilities: { platforms: [], runtimes: ['claude'], acp: true, features: [DAEMON_AUTO_UPGRADE_FEATURE] },
    maxAgents: 2,
    localState: { assignments: [], crons: [], leases: [], agents: [], integrations: [], stagedAgents: [] }
  }
}

async function connectReady(h: ReturnType<typeof buildWsHarness>, token: string, agentVersion = '1.40.0') {
  const { conn, stub } = h.connect()
  stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion, bootstrapProtocolVersion: 1 })
  await stub.expectFrame('auth/ok')
  stub.inject('register', registerPayload())
  const ok = await stub.expectFrame('register/ok')
  if (!isFrame('register/ok')(ok)) throw new Error('expected register/ok')
  return { conn, stub, registerOk: ok.payload }
}

const beginPayload = (targetVersion = '1.41.0') => ({
  op: 'upgrade',
  trigger: 'auto',
  fromVersion: '1.40.0',
  targetVersion
})

async function begin(stub: Awaited<ReturnType<typeof connectReady>>['stub'], targetVersion?: string) {
  const id = stub.inject('daemon/lifecycle/begin', beginPayload(targetVersion))
  await stub.settled()
  const reply = stub.sent.find((frame) => frame.corr === id)
  if (!reply) throw new Error('expected a correlated reply')
  return reply
}

describe('register/ok — auto-upgrade settings and the announced release', () => {
  it('carries the switch, the release and the begin feature', async () => {
    const h = buildWsHarness(prisma)
    h.deps.daemonRelease = { current: () => ({ channel: 'latest', version: '1.41.0' }) }
    const token = await h.mintToken(DAEMON)
    await prisma.daemon.update({ where: { id: DAEMON }, data: { autoUpgrade: true } })

    const { registerOk } = await connectReady(h, token)
    expect(registerOk.autoUpgrade).toBe(true)
    expect(registerOk.release).toEqual({ channel: 'latest', version: '1.41.0' })
    expect(registerOk.serverFeatures).toContain(DAEMON_LIFECYCLE_BEGIN_FEATURE)
  })

  it('omits the release before the resolver has one and reports the switch off by default', async () => {
    const h = buildWsHarness(prisma)
    h.deps.daemonRelease = { current: () => null }
    const { registerOk } = await connectReady(h, await h.mintToken(DAEMON))
    expect(registerOk.autoUpgrade).toBe(false)
    expect(registerOk.release).toBeUndefined()
  })
})

describe('daemon/lifecycle/begin', () => {
  it('opens an armed auto upgrade at the connection epoch and settles it on READY at the target', async () => {
    const h = buildWsHarness(prisma)
    const token = await h.mintToken(DAEMON)
    const { conn, stub } = await connectReady(h, token)

    const reply = await begin(stub)
    if (!isFrame('daemon/lifecycle/begin/ok')(reply)) throw new Error(`expected begin/ok, got ${reply.type}`)
    const op = await h.deps.lifecycleOps.getById(reply.payload.operationId)
    expect(op).toMatchObject({
      op: 'upgrade',
      trigger: 'auto',
      status: 'pending',
      initiator: null,
      targetVersion: '1.41.0',
      commandEpoch: BigInt(conn.sessionEpoch)
    })
    expect(op?.acceptedAt?.getTime()).toBe(h.clock.now())
    expect(op?.deadline.getTime()).toBe(h.clock.now() + AUTO_UPGRADE_DEADLINE_MS)

    // The relaunched daemon on the target version re-registers at a newer epoch: success. Its
    // bootstrap auth gets no lifecycle directive, since the op is the daemon's own.
    const next = h.connect()
    next.stub.inject('auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.41.0', bootstrapProtocolVersion: 1 })
    const authOk = await next.stub.expectFrame('auth/ok')
    if (!isFrame('auth/ok')(authOk)) throw new Error('expected auth/ok')
    expect(authOk.payload.lifecycle).toBeUndefined()
    next.stub.inject('register', registerPayload())
    await next.stub.expectFrame('register/ok')
    await next.stub.settled()
    expect((await h.deps.lifecycleOps.getById(reply.payload.operationId))?.status).toBe('succeeded')
  })

  it('answers CONFLICT while another operation is pending, manual or automatic', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h, await h.mintToken(DAEMON))

    const first = await begin(stub)
    expect(first.type).toBe('daemon/lifecycle/begin/ok')
    const second = await begin(stub, '1.42.0')
    expect(second.type).toBe('error')
    if (!isFrame('error')(second)) throw new Error('expected error')
    expect(second.payload).toMatchObject({ code: 'CONFLICT', retryable: true })
  })

  it('conflicts with a pending manual operation, and admits a new one once that has expired', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h, await h.mintToken(DAEMON))
    const manual = await h.deps.lifecycleOps.open({
      daemonId: DaemonId(DAEMON),
      op: 'restart',
      commandEpoch: 1n,
      deadline: new Date(h.clock.now() + 60_000)
    })

    const refused = await begin(stub)
    if (!isFrame('error')(refused)) throw new Error('expected error')
    expect(refused.payload.code).toBe('CONFLICT')

    h.clock.advance(60_001)
    const admitted = await begin(stub)
    expect(admitted.type).toBe('daemon/lifecycle/begin/ok')
    expect((await h.deps.lifecycleOps.getById(manual.id))?.status).toBe('failed')
  })

  it('settles a busy report as deferred, a rolled-back report as failed', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h, await h.mintToken(DAEMON))
    const report = async (operationId: string, reason: string) => {
      stub.inject('daemon/lifecycle/progress', { operationId, phase: 'failed', reason })
      await stub.settled()
    }

    const busy = await begin(stub)
    if (!isFrame('daemon/lifecycle/begin/ok')(busy)) throw new Error('expected begin/ok')
    await report(busy.payload.operationId, 'busy')
    expect(await h.deps.lifecycleOps.getById(busy.payload.operationId)).toMatchObject({
      status: 'deferred',
      outcome: 'busy'
    })
    // The console's latest-op read skips the deferred row.
    expect(await h.deps.lifecycleOps.latestForDaemon(DaemonId(DAEMON))).toBeNull()

    const rolledBack = await begin(stub)
    if (!isFrame('daemon/lifecycle/begin/ok')(rolledBack)) throw new Error('expected begin/ok')
    await report(rolledBack.payload.operationId, 'rolled back: crashed on start')
    expect(await h.deps.lifecycleOps.getById(rolledBack.payload.operationId)).toMatchObject({
      status: 'failed',
      outcome: 'rolled back: crashed on start'
    })
  })

  it('records a busy report on a manual operation as an ordinary failure', async () => {
    const h = buildWsHarness(prisma)
    const { conn, stub } = await connectReady(h, await h.mintToken(DAEMON))
    const manual = await h.deps.lifecycleOps.open({
      daemonId: DaemonId(DAEMON),
      op: 'upgrade',
      targetVersion: '1.41.0',
      commandEpoch: BigInt(conn.sessionEpoch),
      deadline: new Date(h.clock.now() + 60_000)
    })
    stub.inject('daemon/lifecycle/progress', { operationId: manual.id, phase: 'failed', reason: 'busy' })
    await stub.settled()
    expect((await h.deps.lifecycleOps.getById(manual.id))?.status).toBe('failed')
  })

  it('is refused before READY', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = h.connect()
    stub.inject('auth', { apiKey: await h.mintToken(DAEMON), daemonId: DAEMON, agentVersion: '1.40.0' })
    await stub.expectFrame('auth/ok')
    const reply = await begin(stub)
    if (!isFrame('error')(reply)) throw new Error('expected error')
    expect(reply.payload.code).toBe('PROTOCOL_STATE')
    expect(await h.deps.lifecycleOps.pendingForDaemon(DaemonId(DAEMON))).toBeNull()
  })

  it('deletes only deferred rows older than the cutoff', async () => {
    const h = buildWsHarness(prisma)
    const { stub } = await connectReady(h, await h.mintToken(DAEMON))
    const deferred = await begin(stub)
    if (!isFrame('daemon/lifecycle/begin/ok')(deferred)) throw new Error('expected begin/ok')
    stub.inject('daemon/lifecycle/progress', {
      operationId: deferred.payload.operationId,
      phase: 'failed',
      reason: 'busy'
    })
    await stub.settled()

    const ops = h.deps.lifecycleOps
    expect(await ops.deleteDeferredBefore(new Date(h.clock.now() - 1))).toBe(0)
    expect(await ops.deleteDeferredBefore(new Date(h.clock.now() + 1))).toBe(1)
    expect(await ops.getById(deferred.payload.operationId)).toBeNull()
  })
})
