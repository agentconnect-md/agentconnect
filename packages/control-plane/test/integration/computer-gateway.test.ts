// The Computer channel end to end over a real socket and real Postgres (computer-use.md §3.6, §8.2).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  COMPUTER_CP_SUBPROTOCOL,
  buildComputerCpFrame,
  type ComputerAuthOk,
  type ComputerCpFrame,
  type ComputerDoctorReport
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PEPPER = 'computer-gw-pepper-0123456789abcdefghij'

let running: App | undefined
afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

async function start(): Promise<{ app: App; base: string }> {
  const config = AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://computer/ignored',
    API_KEY_PEPPER: PEPPER,
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

const profile = {
  name: 'ubuntu-desk',
  os: 'linux',
  osVersion: 'Ubuntu 26.04',
  session: 'x11',
  desktopDaemonVersion: '0.1.0',
  driverVersion: '0.35.2'
}

async function register(app: App): Promise<{ computerId: string; apiKey: string; channelUrl: string }> {
  const minted = await app.http.inject({ method: 'POST', url: `${ORG}/computers/registrations`, payload: {} })
  expect(minted.statusCode).toBe(201)
  const { token } = minted.json() as { token: string }
  const res = await app.http.inject({
    method: 'POST',
    url: '/api/v1/computers/register',
    payload: { token, ...profile }
  })
  expect(res.statusCode).toBe(201)
  return res.json() as { computerId: string; apiKey: string; channelUrl: string }
}

class Client {
  readonly frames: ComputerCpFrame[] = []
  closed: Promise<{ code: number; at: number }>
  private waiters: Array<() => void> = []

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString()) as ComputerCpFrame)
      for (const wake of this.waiters.splice(0)) wake()
    })
    this.closed = new Promise((resolve) => ws.once('close', (code) => resolve({ code, at: Date.now() })))
  }

  static dial(url: string, protocol = COMPUTER_CP_SUBPROTOCOL): Promise<Client> {
    const ws = new WebSocket(url, [protocol])
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new Client(ws)))
      ws.once('error', reject)
    })
  }

  send(frame: ComputerCpFrame): void {
    this.ws.send(JSON.stringify(frame))
  }

  async next(type: string): Promise<ComputerCpFrame> {
    for (;;) {
      const hit = this.frames.find((f) => f.type === type)
      if (hit) return hit
      await new Promise<void>((resolve, reject) => {
        this.waiters.push(resolve)
        void this.closed.then(({ code }) => reject(new Error(`closed ${code} waiting for ${type}`)))
      })
    }
  }

  async auth(apiKey: string): Promise<ComputerAuthOk> {
    this.send(buildComputerCpFrame('computer/auth', { apiKey, desktopDaemonVersion: '0.2.0' }))
    const ok = await this.next('computer/auth/ok')
    return ok.payload as ComputerAuthOk
  }
}

async function getComputer(app: App, id: string) {
  const res = await app.http.inject({ method: 'GET', url: `${ORG}/computers/${id}` })
  expect(res.statusCode).toBe(200)
  return res.json() as Record<string, unknown> & { status: string; doctor: unknown; capabilities: unknown }
}

const until = async (check: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('Computer channel', () => {
  it('names the channel at registration and serves it on the public and internal paths', async () => {
    const { app, base } = await start()
    const reg = await register(app)
    expect(reg.channelUrl).toBe('wss://cp.example.com/v1/computers/ws')
    for (const path of ['/v1/computers/ws', '/api/v1/computers/ws']) {
      const client = await Client.dial(`${base}${path}`)
      expect((await client.auth(reg.apiKey)).computerId).toBe(reg.computerId)
      client.ws.close()
      await client.closed
    }
  })

  it('shows a connected desktop online with its capabilities and doctor results, and offline after it leaves', async () => {
    const { app, base } = await start()
    const reg = await register(app)
    expect(await getComputer(app, reg.computerId)).toMatchObject({ status: 'offline', doctor: null })

    const client = await Client.dial(`${base}/api/v1/computers/ws`)
    const ok = await client.auth(reg.apiKey)
    expect(ok).toMatchObject({ orgId: DEFAULT_ORG_ID, name: 'ubuntu-desk', heartbeatSec: 15 })
    expect(ok.policy.agentMode).toBe('control')
    expect(Date.parse(ok.credential.expiresAt) - Date.now()).toBeGreaterThan(140_000)
    expect(await getComputer(app, reg.computerId)).toMatchObject({ status: 'online', desktopDaemonVersion: '0.2.0' })

    const doctor: ComputerDoctorReport = {
      checkedAt: new Date().toISOString(),
      checks: [
        { name: 'session', status: 'ok', detail: 'X11 display :0' },
        { name: 'ffmpeg', status: 'fail', detail: 'not found', fix: 'run: agentconnect computer install-ffmpeg' }
      ]
    }
    const capabilities = {
      screenshot: true,
      input: true,
      viewer: false,
      displays: [{ id: 'primary', width: 1920, height: 1080, scale: 1 }]
    }
    client.send(buildComputerCpFrame('computer/heartbeat', { status: 'busy', session: 'x11', capabilities, doctor }))
    await until(async () => (await getComputer(app, reg.computerId)).status === 'busy')
    const shown = await getComputer(app, reg.computerId)
    expect(shown.doctor).toEqual(doctor)
    expect(shown.capabilities).toMatchObject(capabilities)

    client.ws.close()
    await client.closed
    await until(async () => (await getComputer(app, reg.computerId)).status === 'offline')
  })

  it('stores the audit a desktop reports and serves it to the owner, with typed text by length only', async () => {
    const { app, base } = await start()
    const { computerId, apiKey } = await register(app)
    const client = await Client.dial(`${base}/v1/computers/ws`)
    expect((await client.auth(apiKey)).features).toEqual(['computer-audit-v1'])
    const report = buildComputerCpFrame('computer/audit', {
      entries: [
        {
          id: randomUUID(),
          at: new Date().toISOString(),
          tool: 'computer_type',
          client: 'local',
          outcome: 'ok',
          args: { text: 'hunter2' },
          ms: 9
        }
      ]
    })
    client.send(report)
    expect((await client.next('computer/audit/ok')).payload).toEqual({ stored: 1 })
    const page = await app.http.inject({ method: 'GET', url: `${ORG}/computers/${computerId}/audit` })
    expect(page.json()).toMatchObject({ entries: [{ tool: 'computer_type', args: {}, textLength: 7 }] })
    expect(page.body).not.toContain('hunter2')
    client.ws.close()
  })

  it('refuses a wrong key, a wrong subprotocol and a frame before auth', async () => {
    const { app, base } = await start()
    await register(app)
    const bad = await Client.dial(`${base}/api/v1/computers/ws`)
    bad.send(buildComputerCpFrame('computer/auth', { apiKey: 'ack_not-a-real-key', desktopDaemonVersion: '1' }))
    expect((await bad.closed).code).toBe(4401)

    await expect(Client.dial(`${base}/api/v1/computers/ws`, 'agentconnect.v1')).rejects.toThrow()

    const early = await Client.dial(`${base}/api/v1/computers/ws`)
    early.send(buildComputerCpFrame('computer/heartbeat', { status: 'online' }))
    expect((await early.closed).code).toBe(4400)
  })

  it('refuses a daemon key on the Computer channel', async () => {
    const { base } = await start()
    const minted = new ApiKeyCodec({ API_KEY_PEPPER: PEPPER }).mint()
    const daemonId = randomUUID()
    await prisma.daemon.create({ data: { id: daemonId, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId,
        hash: minted.hash,
        displayTail: minted.displayTail
      }
    })
    const daemonKey = minted.token
    const client = await Client.dial(`${base}/api/v1/computers/ws`)
    client.send(buildComputerCpFrame('computer/auth', { apiKey: daemonKey, desktopDaemonVersion: '1' }))
    expect((await client.closed).code).toBe(4401)
  })

  it('disconnects a revoked desktop within 5 s and refuses its key afterwards', async () => {
    const { app, base } = await start()
    const reg = await register(app)
    const client = await Client.dial(`${base}/api/v1/computers/ws`)
    await client.auth(reg.apiKey)

    const revokedAt = Date.now()
    const res = await app.http.inject({ method: 'POST', url: `${ORG}/computers/${reg.computerId}/revoke` })
    expect(res.statusCode).toBe(200)
    expect((await client.next('computer/revoke')).payload).toEqual({ reason: 'revoked' })
    const closed = await client.closed
    expect(closed.code).toBe(4401)
    expect(closed.at - revokedAt).toBeLessThan(5000)
    expect((await getComputer(app, reg.computerId)).status).toBe('revoked')

    const again = await Client.dial(`${base}/api/v1/computers/ws`)
    again.send(buildComputerCpFrame('computer/auth', { apiKey: reg.apiKey, desktopDaemonVersion: '1' }))
    expect((await again.closed).code).toBe(4401)
  })

  it('pushes a policy change and ends the channel when the Computer is deleted', async () => {
    const { app, base } = await start()
    const reg = await register(app)
    const client = await Client.dial(`${base}/api/v1/computers/ws`)
    const ok = await client.auth(reg.apiKey)
    const res = await app.http.inject({
      method: 'PUT',
      url: `${ORG}/computers/${reg.computerId}/policy`,
      payload: { ...ok.policy, agentMode: 'view', leaseIdleSeconds: 60 }
    })
    expect(res.statusCode).toBe(200)
    expect((await client.next('computer/policy')).payload).toMatchObject({
      policy: { agentMode: 'view', leaseIdleSeconds: 60 }
    })

    const del = await app.http.inject({ method: 'DELETE', url: `${ORG}/computers/${reg.computerId}` })
    expect(del.statusCode).toBe(204)
    expect((await client.next('computer/revoke')).payload).toEqual({ reason: 'deleted' })
    expect((await client.closed).code).toBe(4401)
  })

  it('ends the channels of a removed member’s desktops', async () => {
    const { app, base } = await start()
    const users = new PgUserRepo(prisma)
    const { userId } = await users.provisionOidcUser({
      oidcSubject: 'leaver',
      email: 'leaver@acme.dev',
      emailVerified: true
    })
    await users.addMemberByEmail(DEFAULT_ORG_ID, 'leaver@acme.dev', 'collaborator')
    const reg = await register(app)
    // Hand the Computer to the departing member, as if they had registered it.
    await prisma.computer.update({ where: { id: reg.computerId }, data: { ownerUserId: userId, sharedWith: [userId] } })
    const client = await Client.dial(`${base}/api/v1/computers/ws`)
    await client.auth(reg.apiKey)

    const res = await app.http.inject({ method: 'DELETE', url: `${ORG}/members/${userId}` })
    expect(res.statusCode).toBe(204)
    expect((await client.next('computer/revoke')).payload).toEqual({ reason: 'owner_removed' })
    expect((await client.closed).code).toBe(4401)
  })
})
