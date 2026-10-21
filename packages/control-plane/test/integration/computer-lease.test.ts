// Computer control leases over real Postgres and a real desktop socket (computer-use.md §4.4).
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
  type FrameType,
  type ComputerControlLease
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import {
  PgAgentRepo,
  PgComputerLeaseRepo,
  PgHookRepo,
  PgSessionRepo,
  PgWebchatConversationRepo
} from '../../src/persistence/index.js'
import { ComputerLeaseService } from '../../src/registry/computerLeaseService.js'
import { AgentMutationGate } from '../../src/orchestrator/agentMutationGate.js'
import { InMemorySessionEventSink } from '../../src/events/sink.js'
import { handleComputerLeaseAcquire, handleComputerLeaseRelease } from '../../src/ws/handlers/computer-lease.js'
import { handleEventSession } from '../../src/ws/handlers/index.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_AGENT = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION = '4691f21b-3911-4d7f-a45d-28ce75d79337'
const OTHER_SESSION = 'session-two'

let running: App | undefined
afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

async function start(): Promise<{ app: App; base: string }> {
  const config = AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://computer/ignored',
    API_KEY_PEPPER: 'computer-lease-pepper-0123456789abcdefghij',
    SECRETS_PROVIDER: 'memory',
    HEARTBEAT_SEC: 15,
    PUBLIC_CP_URL: 'https://cp.example.com'
  })
  const app = buildApp({ prisma, config, clock: systemClock, secretsProvider: new MemorySecretsProvider() })
  running = app
  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()
  return { app, base: address.replace(/^http/, 'ws') }
}

async function registerComputer(app: App, agents: string[]): Promise<{ computerId: string; apiKey: string }> {
  const minted = await app.http.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
  const { token } = minted.json() as { token: string }
  const res = await app.http.inject({
    method: 'POST',
    url: '/api/v1/computers/register',
    payload: {
      token,
      name: 'ubuntu-desk',
      os: 'linux',
      osVersion: 'Ubuntu 26.04',
      session: 'x11',
      desktopDaemonVersion: '0.1.0',
      driverVersion: '0.35.2'
    }
  })
  expect(res.statusCode).toBe(201)
  const reg = res.json() as { computerId: string; apiKey: string }
  const access = await app.http.inject({
    method: 'PUT',
    url: `${ORG}/computers/${reg.computerId}/agent-access`,
    payload: { mode: 'selected', agents }
  })
  expect(access.statusCode).toBe(200)
  return reg
}

// The desktop daemon's end of the Computer channel.
class Desktop {
  readonly leases: Array<ComputerControlLease | null> = []
  readonly unreadable: string[] = []
  private waiters: Array<() => void> = []

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      // Decode as the desktop does, so a frame it could not read fails the test.
      const decoded = decodeComputerCpFrameTolerant(data.toString())
      if (!decoded.ok) this.unreadable.push(data.toString())
      else if (decoded.frame.type === 'computer/lease') this.leases.push(decoded.frame.payload.lease)
      for (const wake of this.waiters.splice(0)) wake()
    })
  }

  static async connect(base: string, apiKey: string): Promise<Desktop> {
    const ws = new WebSocket(`${base}/api/v1/computers/ws`, [COMPUTER_CP_SUBPROTOCOL])
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const desktop = new Desktop(ws)
    ws.send(JSON.stringify(buildComputerCpFrame('computer/auth', { apiKey, desktopDaemonVersion: '0.2.0' })))
    await desktop.told(1)
    return desktop
  }

  beat(status: 'online' | 'busy' | 'paused' = 'online'): void {
    this.ws.send(JSON.stringify(buildComputerCpFrame('computer/heartbeat', { status })))
  }

  async told(count: number): Promise<ComputerControlLease | null> {
    const deadline = Date.now() + 5000
    while (this.leases.length < count) {
      if (Date.now() > deadline) throw new Error(`desktop was told ${this.leases.length} leases, wanted ${count}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
    return this.leases[count - 1]!
  }
}

function frame(type: string, payload: Record<string, unknown>): AnyFrame {
  return { v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload } as AnyFrame
}

// An agent daemon's end of the daemon wire, answered by the handlers directly; a separate service plays another CP replica.
function agentDaemon(daemonId = DAEMON) {
  const replies: Array<{ type: string; payload: unknown }> = []
  const closing = new AbortController()
  const conn = {
    closedSignal: closing.signal,
    daemonId,
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
    agentMutations: new AgentMutationGate(),
    hook: new PgHookRepo(prisma),
    session: new PgSessionRepo(prisma),
    webchatConversation: new PgWebchatConversationRepo(prisma),
    events: new InMemorySessionEventSink(),
    clock: systemClock,
    log: { error: () => {}, warn: () => {} },
    computerLeases: new ComputerLeaseService(new PgComputerLeaseRepo(prisma), systemClock, {
      holderTtlMs: 45_000,
      staleAfterMs: 45_000
    })
  } as unknown as DaemonWsDeps
  return {
    async acquire(computerId: string, sessionId: string, agentId = AGENT, at = new Date(), waitMs?: number) {
      await handleComputerLeaseAcquire(
        frame('computer-lease/acquire', {
          computerId,
          agentId,
          sessionId,
          requestedAt: at.toISOString(),
          ...(waitMs === undefined ? {} : { waitMs })
        }),
        conn,
        deps
      )
      return replies.at(-1)!
    },
    close() {
      closing.abort()
    },
    async release(computerId: string, sessionId: string, agentId = AGENT) {
      await handleComputerLeaseRelease(frame('computer-lease/release', { computerId, agentId, sessionId }), conn, deps)
      return replies.at(-1)!
    },
    async session(phase: 'start' | 'end' | 'problem', sessionId = SESSION, at = new Date()) {
      await handleEventSession(
        frame('event/session', {
          sessionId,
          agentId: AGENT,
          phase,
          platform: 'slack',
          channel: 'C123',
          thread: sessionId === SESSION ? 'T9' : `T-${sessionId}`,
          ts: at.toISOString()
        }),
        conn,
        deps
      )
    }
  }
}

async function seed(): Promise<void> {
  await seedDaemon(prisma, DAEMON)
  await seedDaemon(prisma, OTHER_DAEMON)
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
}

describe('Computer control lease', () => {
  it('grants one session, names it to another, tells the desktop, and releases it when the turn ends', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT, OTHER_AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    expect(await desktop.told(1)).toBeNull()

    const daemon = agentDaemon()
    await daemon.session('start')
    const granted = await daemon.acquire(computerId, SESSION)
    expect(granted).toMatchObject({
      type: 'computer-lease/acquire/result',
      payload: { granted: true, lease: { computerId, holder: { sessionId: SESSION, agentId: AGENT } } }
    })
    const busy = await daemon.acquire(computerId, OTHER_SESSION, OTHER_AGENT)
    expect(busy.payload).toMatchObject({
      granted: false,
      code: 'computer_busy',
      holder: { sessionId: SESSION, agentId: AGENT, agentName: `agent-${AGENT}` }
    })

    // The lease was granted on another replica, so the desktop learns it with its next heartbeat.
    desktop.beat('busy')
    expect(await desktop.told(2)).toMatchObject({ holder: { sessionId: SESSION } })

    await daemon.session('end')
    expect(await prisma.computerLease.count({ where: { computerId } })).toBe(0)
    desktop.beat()
    expect(await desktop.told(3)).toBeNull()

    expect((await daemon.acquire(computerId, OTHER_SESSION, OTHER_AGENT)).payload).toMatchObject({ granted: true })
    expect(desktop.unreadable).toEqual([])
    desktop.ws.close()
  })

  it('releases the lease when the turn fails or is interrupted', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    const daemon = agentDaemon()
    await daemon.session('start')
    expect((await daemon.acquire(computerId, SESSION)).payload).toMatchObject({ granted: true })
    await daemon.session('problem')
    expect(await prisma.computerLease.count({ where: { computerId } })).toBe(0)
    desktop.ws.close()
  })

  it('names an agent with an over-long display name in frames both daemons can read', async () => {
    await seed()
    await prisma.agent.update({ where: { id: AGENT }, data: { displayName: 'n'.repeat(300) } })
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT, OTHER_AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    const daemon = agentDaemon()
    expect((await daemon.acquire(computerId, SESSION)).payload).toMatchObject({
      granted: true,
      lease: { holder: { agentName: 'n'.repeat(200) } }
    })
    expect((await daemon.acquire(computerId, OTHER_SESSION, OTHER_AGENT)).payload).toMatchObject({
      code: 'computer_busy',
      holder: { agentName: 'n'.repeat(200) }
    })
    desktop.beat('busy')
    expect(await desktop.told(2)).toMatchObject({ holder: { agentName: 'n'.repeat(200) } })
    expect(desktop.unreadable).toEqual([])
    desktop.ws.close()
  })

  it('keeps a lease the session took after the reported end, and lets the holder release it', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    const daemon = agentDaemon()
    // An offline Computer grants nothing.
    expect((await daemon.acquire(computerId, SESSION)).payload).toMatchObject({ granted: false, code: 'unavailable' })
    const desktop = await Desktop.connect(base, apiKey)
    // The next turn takes the lease a few seconds after the previous turn ended, on the daemon's clock.
    const ended = new Date(Date.now() - 20_000)
    expect((await daemon.acquire(computerId, SESSION, AGENT, new Date(ended.getTime() + 5_000))).payload).toMatchObject(
      {
        granted: true
      }
    )
    // The previous turn's end arrives late (a durable replay) and leaves the later lease alone.
    await daemon.session('end', SESSION, ended)
    expect(await prisma.computerLease.count({ where: { computerId } })).toBe(1)
    expect(await daemon.release(computerId, SESSION)).toMatchObject({ type: 'ack', payload: { ok: true } })
    expect(await prisma.computerLease.count({ where: { computerId } })).toBe(0)
    desktop.ws.close()
  })

  it('lets a pause on the desktop pre-empt the lease and refuses input until it resumes', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    const daemon = agentDaemon()
    expect((await daemon.acquire(computerId, SESSION)).payload).toMatchObject({ granted: true })
    desktop.beat('paused')
    await expect.poll(() => prisma.computerLease.count({ where: { computerId } })).toBe(0)
    expect((await daemon.acquire(computerId, SESSION)).payload).toMatchObject({
      granted: false,
      code: 'human_in_control'
    })
    desktop.beat('online')
    await expect.poll(async () => (await daemon.acquire(computerId, SESSION)).payload).toMatchObject({ granted: true })
    desktop.ws.close()
  })

  it('refuses a daemon that does not serve the agent and an agent the policy does not grant', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    expect((await agentDaemon(OTHER_DAEMON).acquire(computerId, SESSION)).payload).toMatchObject({
      granted: false,
      code: 'denied'
    })
    expect((await agentDaemon().acquire(computerId, OTHER_SESSION, OTHER_AGENT)).payload).toMatchObject({
      granted: false,
      code: 'denied'
    })
    desktop.ws.close()
  })

  it("queues sessions first come, first served across replicas and hands over when the holder's turn ends", async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT, OTHER_AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    // Two CP replicas over one database; each daemon's asks may reach either.
    const replicaA = agentDaemon()
    const replicaB = agentDaemon()
    const THIRD = 'session-three'
    const secondAt = new Date()
    const thirdAt = new Date(secondAt.getTime() + 1)
    await replicaA.session('start')
    expect((await replicaA.acquire(computerId, SESSION)).payload).toMatchObject({ granted: true })
    expect((await replicaA.acquire(computerId, OTHER_SESSION, OTHER_AGENT, secondAt, 0)).payload).toMatchObject({
      granted: false,
      code: 'computer_busy',
      holder: { sessionId: SESSION },
      queued: { position: 1 }
    })
    expect((await replicaA.acquire(computerId, THIRD, AGENT, thirdAt, 0)).payload).toMatchObject({
      queued: { position: 2 }
    })
    // Replica A is gone; the queue lives in the database, so replica B keeps the order.
    expect((await replicaB.acquire(computerId, THIRD, AGENT, thirdAt, 0)).payload).toMatchObject({
      queued: { position: 2 }
    })
    expect(await prisma.computerLeaseWaiter.count({ where: { computerId } })).toBe(2)

    // The second session's ask is held on replica B while the holder's turn ends through another replica.
    const held = replicaB.acquire(computerId, OTHER_SESSION, OTHER_AGENT, secondAt, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await agentDaemon().session('end')
    expect((await held).payload).toMatchObject({
      granted: true,
      lease: { holder: { sessionId: OTHER_SESSION, agentId: OTHER_AGENT } }
    })
    expect((await replicaB.acquire(computerId, THIRD, AGENT, thirdAt, 0)).payload).toMatchObject({
      holder: { sessionId: OTHER_SESSION },
      queued: { position: 1 }
    })

    // The third session's turn ends while it waits: a late ask of that wait gets a final answer and the marker stays.
    await replicaB.session('end', THIRD, new Date(thirdAt.getTime() + 10))
    const ended = {
      granted: false,
      code: 'computer_busy',
      message: "this session's turn ended while it waited for this computer"
    }
    expect((await replicaA.acquire(computerId, THIRD, AGENT, thirdAt, 0)).payload).toMatchObject(ended)
    expect(await prisma.computerLeaseWaiter.count({ where: { computerId } })).toBe(1)
    // A duplicate late ask of the same wait, with the Computer now free, is refused too and never takes the lease.
    await replicaA.release(computerId, OTHER_SESSION, OTHER_AGENT)
    expect((await replicaB.acquire(computerId, THIRD, AGENT, thirdAt, 0)).payload).toMatchObject(ended)
    expect(await prisma.computerLeaseWaiter.count({ where: { computerId } })).toBe(1)
    // A later turn of that session starts a fresh wait and takes the free Computer.
    expect(
      (await replicaB.acquire(computerId, THIRD, AGENT, new Date(thirdAt.getTime() + 20), 0)).payload
    ).toMatchObject({ granted: true })
    expect(await prisma.computerLeaseWaiter.count({ where: { computerId } })).toBe(0)
    expect(desktop.unreadable).toEqual([])
    desktop.ws.close()
  })

  it('stops a held acquire once its daemon connection closes, so a release does not grant it', async () => {
    await seed()
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT, OTHER_AGENT])
    const desktop = await Desktop.connect(base, apiKey)
    const holder = agentDaemon()
    const lost = agentDaemon()
    expect((await holder.acquire(computerId, SESSION)).payload).toMatchObject({ granted: true })
    const startedAt = Date.now()
    const held = lost.acquire(computerId, OTHER_SESSION, OTHER_AGENT, new Date(), 5_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    lost.close()
    expect((await held).payload).toMatchObject({ granted: false, queued: { position: 1 } })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
    await holder.release(computerId, SESSION)
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    expect(await prisma.computerLease.count({ where: { computerId } })).toBe(0)
    desktop.ws.close()
  })
})
