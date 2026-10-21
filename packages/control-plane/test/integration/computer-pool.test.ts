// Managed computers in the Kubernetes pool over real Postgres, a simulated cluster and real desktop sockets (computer-use.md §15.1).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  COMPUTER_CP_SUBPROTOCOL,
  buildComputerCpFrame,
  buildEnvelope,
  decodeComputerCpFrameTolerant,
  decodeCpEnvelope,
  type AnyFrame,
  type ComputerPoolAcquireResult,
  type ComputerPoolClaimState,
  type ComputerPoolOp,
  type ComputerPoolOpResult,
  type FrameType
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock, type Clock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import {
  PgAgentRepo,
  PgApiKeyRepo,
  PgAuditRepo,
  PgComputerLeaseRepo,
  PgComputerRepo
} from '../../src/persistence/index.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { ComputerService } from '../../src/registry/computerService.js'
import { ComputerLeaseService } from '../../src/registry/computerLeaseService.js'
import { ComputerPool, type ComputerPoolMembers } from '../../src/registry/computerPool.js'
import { DEFAULT_COMPUTER_POOL_TIMINGS as T } from '../../src/domain/computerPool.js'
import { defaultComputerPolicy } from '../../src/domain/computer.js'
import { handleComputerLeaseAcquire, handleComputerLeaseRelease } from '../../src/ws/handlers/computer-lease.js'
import { handleComputerPoolAcquire } from '../../src/ws/handlers/computer-pool.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { ComputerId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../src/config/defaults.js'

const PEPPER = 'computer-pool-pepper-0123456789abcdefghijk'
const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const S1 = 'session-one'
const S2 = 'session-two'

let running: App | undefined
const sockets: WebSocket[] = []
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate()
  await running?.shutdown()
  running = undefined
})

async function start(env: Record<string, string> = {}): Promise<{ app: App; base: string; http: string }> {
  const config = AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://computer/ignored',
    API_KEY_PEPPER: PEPPER,
    SECRETS_PROVIDER: 'memory',
    HEARTBEAT_SEC: 15,
    PUBLIC_CP_URL: 'https://cp.example.com',
    ...env
  })
  const app = buildApp({ prisma, config, clock: systemClock, secretsProvider: new MemorySecretsProvider() })
  running = app
  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()
  return { app, base: address.replace(/^http/, 'ws'), http: address }
}

// A desktop daemon's end of the Computer channel: authenticate with the pod's key, then report online.
async function connectDesktop(base: string, apiKey: string): Promise<WebSocket> {
  const ws = new WebSocket(`${base}/api/v1/computers/ws`, [COMPUTER_CP_SUBPROTOCOL])
  sockets.push(ws)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const authed = new Promise<void>((resolve, reject) => {
    ws.on('message', (data: Buffer) => {
      const decoded = decodeComputerCpFrameTolerant(data.toString())
      if (decoded.ok && decoded.frame.type === 'computer/auth/ok') resolve()
    })
    ws.once('close', () => reject(new Error('desktop channel closed before auth')))
  })
  ws.send(JSON.stringify(buildComputerCpFrame('computer/auth', { apiKey, desktopDaemonVersion: '0.3.0' })))
  await authed
  ws.send(JSON.stringify(buildComputerCpFrame('computer/heartbeat', { status: 'online' })))
  return ws
}

interface Pod {
  running: boolean
  ready: boolean
  /** The claim's volume: the key and the files survive sleep and go with the claim. */
  volume: { files: Record<string, string>; key?: { computerId: string; apiKey: string } }
  desktop?: WebSocket
  createdAt: string
}

/** The pool members and the cluster behind them: claims, pods that start on the next pass, and desktops that register over HTTP. */
class FakeCluster implements ComputerPoolMembers {
  readonly pods = new Map<string, Pod>()
  readonly ops: ComputerPoolOp[] = []
  up = true
  neverReady = false
  neverConnects = false
  /** The pod cannot reach the Control Plane, so a pushed registration never lands. */
  pushFails = false
  registrations = 0

  constructor(
    private readonly app: App,
    private readonly base: string
  ) {}

  available(): boolean {
    return this.up
  }

  async op(op: ComputerPoolOp): Promise<ComputerPoolOpResult | undefined> {
    if (!this.up) return undefined
    this.ops.push(op)
    if (op.op === 'list') {
      return {
        ok: true,
        claims: [...this.pods].map(([computerId, pod]) => ({ computerId, claim: 'present', createdAt: pod.createdAt }))
      }
    }
    const state = (patch: Partial<ComputerPoolClaimState>): ComputerPoolOpResult => ({
      ok: true,
      state: { computerId: op.computerId, claim: 'present', ...patch }
    })
    let pod = this.pods.get(op.computerId)
    if (op.op === 'delete') {
      pod?.desktop?.close()
      this.pods.delete(op.computerId)
      return state({ claim: 'deleted', pod: 'none' })
    }
    if (!pod) {
      if (!op.create) return state({ claim: 'missing', pod: 'none' })
      pod = { running: true, ready: false, volume: { files: {} }, createdAt: new Date().toISOString() }
      this.pods.set(op.computerId, pod)
      return state({ pod: 'starting' })
    }
    if (!op.running) {
      pod.desktop?.close()
      pod.desktop = undefined
      pod.running = false
      pod.ready = false
      return state({ pod: 'suspended' })
    }
    if (!pod.running) {
      pod.running = true
      return state({ pod: 'starting' })
    }
    if (!pod.ready) {
      pod.ready = !this.neverReady
      return state({ pod: 'starting' })
    }
    if (!pod.volume.key && op.registration && !this.pushFails) {
      // What the desktop does with a pushed token: the ordinary registration exchange.
      const res = await this.app.http.inject({
        method: 'POST',
        url: '/api/v1/computers/register',
        payload: {
          token: op.registration.token,
          name: op.registration.name,
          isolation: 'container',
          os: 'linux',
          osVersion: 'Debian 13',
          session: 'xvfb',
          desktopDaemonVersion: '0.3.0',
          driverVersion: '0.35.2'
        }
      })
      expect(res.statusCode).toBe(201)
      const key = res.json() as { computerId: string; apiKey: string }
      pod.volume.key = { computerId: key.computerId, apiKey: key.apiKey }
      this.registrations++
    }
    if (pod.volume.key && !pod.desktop && !this.neverConnects) {
      pod.desktop = await connectDesktop(this.base, pod.volume.key.apiKey)
    }
    return state({
      pod: 'running',
      registered: Boolean(pod.volume.key),
      ...(pod.volume.key ? { registeredComputerId: pod.volume.key.computerId } : {})
    })
  }
}

function frame(type: string, payload: Record<string, unknown>): AnyFrame {
  return { v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload } as AnyFrame
}

/** The pool as one CP replica runs it, with a clock the test can move forward, and an agent daemon's end of the wire. */
function harness(cluster: FakeCluster) {
  let offset = 0
  const clock: Clock = { ...systemClock, now: () => Date.now() + offset }
  const computerRepo = new PgComputerRepo(prisma)
  const leases = new ComputerLeaseService(new PgComputerLeaseRepo(prisma), clock, {
    holderTtlMs: 45_000,
    staleAfterMs: 45_000
  })
  const computers = new ComputerService(
    new ApiKeyCodec({ API_KEY_PEPPER: PEPPER }),
    computerRepo,
    new PgApiKeyRepo(prisma),
    new PgAuditRepo(prisma),
    clock,
    { leases }
  )
  const pool = new ComputerPool({
    repo: computerRepo,
    agents: new PgAgentRepo(prisma),
    computers,
    leases,
    members: cluster,
    clock,
    advanceThrottleMs: 0
  })
  const replies: Array<{ type: string; payload: unknown }> = []
  const conn = {
    daemonId: DAEMON,
    orgId: DEFAULT_ORG_ID,
    state: 'READY',
    // Replies go through the wire codec, so one the daemon could not decode fails the test.
    replyTo: (_req: AnyFrame, type: string, payload: unknown) => {
      const decoded = decodeCpEnvelope(
        JSON.stringify(buildEnvelope(type as FrameType, payload, { corr: randomUUID() }))
      )
      replies.push(decoded.ok ? { type, payload: decoded.frame.payload } : { type: 'undecodable', payload: decoded })
    },
    sendError: (_corr: string, code: string) => replies.push({ type: 'error', payload: { code } })
  } as unknown as DaemonConnection
  const deps = {
    agent: new PgAgentRepo(prisma),
    log: { error: () => {}, warn: () => {} },
    computerLeases: leases,
    computerPool: pool
  } as unknown as DaemonWsDeps
  const acquireOnce = async (agentId: string, sessionId: string, computerId?: string) => {
    await handleComputerPoolAcquire(
      frame('computer-pool/acquire', { agentId, sessionId, ...(computerId ? { computerId } : {}) }),
      conn,
      deps
    )
    const reply = replies.at(-1)!
    expect(reply.type).toBe('computer-pool/acquire/result')
    return reply.payload as ComputerPoolAcquireResult
  }
  return {
    pool,
    leases,
    later: (ms: number) => (offset += ms),
    now: () => (offset = 0),
    acquireOnce,
    // What a session's tool call does: ask until ready or refused.
    async acquire(agentId: string, sessionId: string, computerId?: string): Promise<ComputerPoolAcquireResult> {
      for (let i = 0; i < 40; i++) {
        const result = await acquireOnce(agentId, sessionId, computerId)
        if (result.state !== 'pending') return result
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error('the managed computer never became ready')
    },
    async lease(computerId: string, agentId: string, sessionId: string) {
      await handleComputerLeaseAcquire(
        frame('computer-lease/acquire', { computerId, agentId, sessionId, requestedAt: new Date().toISOString() }),
        conn,
        deps
      )
      return replies.at(-1)!.payload as { granted: boolean; code?: string; message?: string }
    },
    async release(computerId: string, agentId: string, sessionId: string) {
      await handleComputerLeaseRelease(frame('computer-lease/release', { computerId, agentId, sessionId }), conn, deps)
    }
  }
}

async function seed(mode: 'ephemeral' | 'per-agent' | null, otherMode: 'ephemeral' | 'per-agent' | null = null) {
  await seedDaemon(prisma, DAEMON)
  const use = (m: string | null) =>
    m
      ? { computerUse: { enabled: true, computers: [], managed: { mode: m } } }
      : { computerUse: { enabled: true, computers: [] } }
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, createdByUserId: DEFAULT_OWNER_ID, runtimeOverrides: use(mode) })
  await seedAgent(prisma, OTHER_AGENT, {
    daemonId: DAEMON,
    createdByUserId: DEFAULT_OWNER_ID,
    runtimeOverrides: use(otherMode)
  })
}

const row = (id: string) => prisma.computer.findUnique({ where: { id } })

describe('managed computers in the pool', () => {
  it('ephemeral: a session gets a fresh desktop only it may control, and nothing survives reclamation', async () => {
    await seed('ephemeral')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)

    const first = await h.acquireOnce(AGENT, S1)
    expect(first).toMatchObject({ state: 'pending', phase: 'provisioning' })
    const ready = await h.acquire(AGENT, S1)
    expect(ready).toMatchObject({ state: 'ready', allocation: 'ephemeral' })
    const id = (ready as { computerId: string }).computerId
    expect(await row(id)).toMatchObject({
      kind: 'managed',
      allocation: 'ephemeral',
      ownerAgentId: AGENT,
      poolSessionId: S1,
      poolPhase: 'awake',
      status: 'online',
      isolation: 'container',
      session: 'xvfb',
      ownerUserId: DEFAULT_OWNER_ID
    })
    // The browser task's lease is the session's; another session of the same agent gets its own desktop.
    expect(await h.lease(id, AGENT, S1)).toMatchObject({ granted: true })
    expect(await h.lease(id, AGENT, S2)).toMatchObject({ granted: false, code: 'denied' })
    const second = await h.acquire(AGENT, S2)
    expect(second).toMatchObject({ state: 'ready' })
    expect((second as { computerId: string }).computerId).not.toBe(id)
    expect(cluster.registrations).toBe(2)

    cluster.pods.get(id)!.volume.files['Downloads/report.pdf'] = 'secret'
    await h.release(id, AGENT, S1)
    h.later(T.ephemeralIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    expect(cluster.pods.has(id)).toBe(false)
    expect(await row(id)).toBeNull()
    expect(await prisma.apiKey.count({ where: { computerId: id } })).toBe(0)
    // The session asks again and gets a fresh, empty desktop.
    const fresh = await h.acquire(AGENT, S1)
    const freshId = (fresh as { computerId: string }).computerId
    expect(freshId).not.toBe(id)
    expect(cluster.pods.get(freshId)!.volume.files).toEqual({})
  })

  it('per-agent: one per agent, sleeps keeping its volume, wakes with its files, and no other agent gets it', async () => {
    await seed('per-agent', 'per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)

    const ready = await h.acquire(AGENT, S1)
    const id = (ready as { computerId: string }).computerId
    expect(ready).toMatchObject({ state: 'ready', allocation: 'per-agent' })
    // Another session of the same agent shares the agent's one computer.
    expect(await h.acquire(AGENT, S2)).toEqual(ready)
    cluster.pods.get(id)!.volume.files['.mozilla/cookies.sqlite'] = 'signed-in'

    h.later(T.sleepIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    expect(await row(id)).toMatchObject({ poolPhase: 'sleeping', status: 'sleeping' })
    expect(cluster.pods.get(id)!.running).toBe(false)
    expect(await h.lease(id, AGENT, S1)).toMatchObject({ granted: false, code: 'unavailable' })

    // A second agent never gets it: its own computer, and a refusal on this one.
    const other = await h.acquire(OTHER_AGENT, S1)
    expect((other as { computerId: string }).computerId).not.toBe(id)
    expect(await h.acquireOnce(OTHER_AGENT, S1, id)).toMatchObject({ state: 'failed', code: 'denied' })

    const woken = await h.acquire(AGENT, S1)
    expect(woken).toEqual(ready)
    expect(await row(id)).toMatchObject({ poolPhase: 'awake', status: 'online' })
    expect(cluster.pods.get(id)!.volume.files['.mozilla/cookies.sqlite']).toBe('signed-in')
    // It woke on the key its volume kept: no second registration for it.
    expect(await prisma.computerRegistration.count({ where: { computerId: id } })).toBe(1)
    expect(await h.lease(id, AGENT, S1)).toMatchObject({ granted: true })
  })

  it('manual: a pool computer assigned to two agents is used by both, one at a time under the lease', async () => {
    await seed(null)
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)
    const created = await h.pool.createManual(OrgId(DEFAULT_ORG_ID), {
      name: 'Shared browser',
      ownerUserId: DEFAULT_OWNER_ID,
      policy: { ...defaultComputerPolicy(DEFAULT_OWNER_ID), allowedAgents: [AGENT, OTHER_AGENT] }
    })
    expect(created).toMatchObject({ allocation: 'manual', ownerAgentId: null, poolPhase: 'provisioning' })
    const id = created!.id
    for (let i = 0; i < 10 && (await row(id))?.poolPhase !== 'awake'; i++) await h.pool.sweep()

    expect(await h.acquire(AGENT, S1, id)).toMatchObject({ state: 'ready', allocation: 'manual' })
    expect(await h.acquire(OTHER_AGENT, S2, id)).toMatchObject({ state: 'ready' })
    expect(await h.lease(id, AGENT, S1)).toMatchObject({ granted: true })
    expect(await h.lease(id, OTHER_AGENT, S2)).toMatchObject({ granted: false, code: 'computer_busy' })
    await h.release(id, AGENT, S1)
    expect(await h.lease(id, OTHER_AGENT, S2)).toMatchObject({ granted: true })

    // Idle, it sleeps; a use wakes it; deleting it removes the pod and volume before the record.
    await h.release(id, OTHER_AGENT, S2)
    h.later(T.sleepIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    expect(await row(id)).toMatchObject({ poolPhase: 'sleeping' })
    expect(await h.acquire(OTHER_AGENT, S2, id)).toMatchObject({ state: 'ready' })
    await h.pool.remove(OrgId(DEFAULT_ORG_ID), ComputerId(id))
    expect(cluster.pods.has(id)).toBe(false)
    expect(await row(id)).toBeNull()
  })

  it('fails clearly when the pod is never ready, and starts over on the next use', async () => {
    await seed('ephemeral')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    cluster.neverReady = true
    const h = harness(cluster)
    expect(await h.acquireOnce(AGENT, S1)).toMatchObject({ state: 'pending' })
    expect(await h.acquireOnce(AGENT, S1)).toMatchObject({ state: 'pending', phase: 'provisioning' })
    h.later(T.provisionTimeoutMs + 1000)
    await h.pool.sweep()
    h.now()
    expect(cluster.pods.size).toBe(0)
    expect(await h.acquireOnce(AGENT, S1)).toEqual({
      state: 'failed',
      code: 'failed',
      message: 'the desktop pod never became ready'
    })
  })

  it('fails clearly when the Computer never comes online after registering', async () => {
    await seed('per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    cluster.neverConnects = true
    const h = harness(cluster)
    for (let i = 0; i < 6; i++) await h.acquireOnce(AGENT, S1)
    const id = (await prisma.computer.findFirst({ where: { ownerAgentId: AGENT } }))!.id
    expect(await row(id)).toMatchObject({ poolPhase: 'registering' })
    expect(await h.acquireOnce(AGENT, S1)).toMatchObject({ state: 'pending', phase: 'registering', computerId: id })
    h.later(T.registerTimeoutMs + 1000)
    await h.pool.sweep()
    h.now()
    expect(await row(id)).toBeNull()
    expect(await h.acquireOnce(AGENT, S1)).toMatchObject({
      state: 'failed',
      message: 'the desktop never registered with the Control Plane'
    })
  })

  it('reports a per-agent computer whose volume is gone, then gives the agent a new one', async () => {
    await seed('per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)
    const id = ((await h.acquire(AGENT, S1)) as { computerId: string }).computerId
    h.later(T.sleepIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    // Someone deleted the claim, and with it the volume, while it slept.
    cluster.pods.delete(id)
    expect(await h.acquire(AGENT, S1)).toMatchObject({ state: 'failed', code: 'volume_missing' })
    expect(await row(id)).toBeNull()
    const replacement = await h.acquire(AGENT, S1)
    expect(replacement).toMatchObject({ state: 'ready' })
    expect((replacement as { computerId: string }).computerId).not.toBe(id)
  })

  it('replaces a revoked per-agent computer, and keeps a revoked manual one revoked', async () => {
    await seed('per-agent', 'per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)
    const id = ((await h.acquire(AGENT, S1)) as { computerId: string }).computerId
    h.later(T.sleepIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    const computers = new ComputerService(
      new ApiKeyCodec({ API_KEY_PEPPER: PEPPER }),
      new PgComputerRepo(prisma),
      new PgApiKeyRepo(prisma),
      new PgAuditRepo(prisma),
      systemClock
    )
    await computers.revoke(OrgId(DEFAULT_ORG_ID), ComputerId(id))
    await h.pool.sweep()
    // The sweep never writes a revoked computer back to sleeping; the agent's next use gets a fresh one.
    expect((await row(id))?.status ?? 'revoked').toBe('revoked')
    const fresh = await h.acquire(AGENT, S1)
    expect(fresh).toMatchObject({ state: 'ready', allocation: 'per-agent' })
    expect((fresh as { computerId: string }).computerId).not.toBe(id)
    expect(await row(id)).toBeNull()
    expect(cluster.pods.has(id)).toBe(false)

    const manual = await h.pool.createManual(OrgId(DEFAULT_ORG_ID), {
      name: 'Shared browser',
      ownerUserId: DEFAULT_OWNER_ID,
      policy: { ...defaultComputerPolicy(DEFAULT_OWNER_ID), allowedAgents: [AGENT] }
    })
    const manualId = manual!.id
    for (let i = 0; i < 10 && (await row(manualId))?.poolPhase !== 'awake'; i++) await h.pool.sweep()
    await computers.revoke(OrgId(DEFAULT_ORG_ID), ComputerId(manualId))
    await h.pool.sweep()
    h.later(T.sleepIdleMs + 60_000)
    await h.pool.sweep()
    h.now()
    expect(await row(manualId)).toMatchObject({ status: 'revoked', poolPhase: 'sleeping' })
    expect(cluster.pods.get(manualId)!.running).toBe(false)
    expect(await h.acquireOnce(AGENT, S1, manualId)).toMatchObject({
      state: 'failed',
      message: 'this computer is revoked'
    })
    expect(await row(manualId)).toMatchObject({ status: 'revoked', poolPhase: 'sleeping' })
  })

  it('pushes one registration again rather than minting one per pass', async () => {
    await seed('per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    cluster.pushFails = true
    const h = harness(cluster)
    for (let i = 0; i < 8; i++) await h.acquireOnce(AGENT, S1)
    const id = (await prisma.computer.findFirst({ where: { ownerAgentId: AGENT } }))!.id
    const pushes = cluster.ops.filter((op) => op.op === 'ensure' && op.registration).length
    expect(pushes).toBeGreaterThan(1)
    expect(await prisma.computerRegistration.count({ where: { computerId: id } })).toBe(1)
    cluster.pushFails = false
    expect(await h.acquire(AGENT, S1)).toMatchObject({ state: 'ready', computerId: id })
    expect(await prisma.computerRegistration.count({ where: { computerId: id } })).toBe(1)
  })

  it('gives a manual computer made without a policy the ordinary approvals', async () => {
    await seed(null)
    const { app, base } = await start()
    const h = harness(new FakeCluster(app, base))
    const created = await h.pool.createManual(OrgId(DEFAULT_ORG_ID), { name: 'Desk', ownerUserId: DEFAULT_OWNER_ID })
    expect(created!.policy.approvals).toEqual(defaultComputerPolicy(DEFAULT_OWNER_ID).approvals)
    expect(created!.policy.approvals.firstInputPerSession).toBe(true)
  })

  it('refuses without a pool member, and without a managed setting', async () => {
    await seed('ephemeral')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    cluster.up = false
    const h = harness(cluster)
    expect(await h.acquireOnce(AGENT, S1)).toMatchObject({ state: 'failed', code: 'no_pool' })
    expect(await h.acquireOnce(OTHER_AGENT, S1)).toMatchObject({ state: 'failed', code: 'not_configured' })
  })

  it('collects a desktop claim whose Computer is gone, and reclaims a deleted agent’s computer', async () => {
    await seed('per-agent')
    const { app, base } = await start()
    const cluster = new FakeCluster(app, base)
    const h = harness(cluster)
    const orphan = randomUUID()
    cluster.pods.set(orphan, {
      running: true,
      ready: true,
      volume: { files: {} },
      createdAt: new Date(0).toISOString()
    })
    const id = ((await h.acquire(AGENT, S1)) as { computerId: string }).computerId
    await prisma.agent.delete({ where: { id: AGENT } })
    await h.pool.sweep()
    expect(cluster.pods.has(orphan)).toBe(false)
    expect(cluster.pods.has(id)).toBe(false)
    expect(await row(id)).toBeNull()
  })

  it('serves the create route only where the pool runs', async () => {
    const off = await start()
    const res = await off.app.http.inject({ method: 'POST', url: `${ORG}/computers/pool`, payload: { name: 'Desk' } })
    expect(res.statusCode).toBe(503)
    await off.app.shutdown()
    running = undefined
    const on = await start({ COMPUTER_POOL_ENABLED: 'true' })
    // No member is connected to this replica, so it cannot start one.
    const none = await on.app.http.inject({ method: 'POST', url: `${ORG}/computers/pool`, payload: { name: 'Desk' } })
    expect(none.statusCode).toBe(503)
    const bad = await on.app.http.inject({
      method: 'POST',
      url: `${ORG}/computers/pool`,
      payload: { name: 'Desk', policy: { allowedAgents: [randomUUID()] } }
    })
    expect(bad.statusCode).toBe(400)
  })
})
