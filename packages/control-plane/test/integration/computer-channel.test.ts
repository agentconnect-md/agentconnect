// Computer data-plane credentials over real Postgres, a real desktop socket and a real relay socket (computer-use.md §3.7).
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  COMPUTER_CP_SUBPROTOCOL,
  RELAY_CP_SUBPROTOCOL,
  buildComputerCpFrame,
  buildEnvelope,
  decodeComputerCpFrameTolerant,
  decodeCpEnvelope,
  signComputerChannelToken,
  verifyComputerChannelToken,
  type AnyFrame,
  type ComputerAuthOk,
  type ComputerCpFrame,
  type FrameType,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { PgAgentRepo, PgComputerRepo } from '../../src/persistence/index.js'
import { ComputerChannelGrants } from '../../src/registry/computerChannelGrants.js'
import { ComputerChannelKeys } from '../../src/registry/computerChannelKeys.js'
import { handleComputerChannelGrant } from '../../src/ws/handlers/computer-channel.js'
import type { DaemonConnection } from '../../src/ws/connection.js'
import type { DaemonWsDeps } from '../../src/ws/deps.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const PEPPER = 'computer-channel-pepper-0123456789abcdefghij'
const RELAY_TOKEN = 'computer-relay-secret-0123456789abcdef'
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const OTHER_DAEMON = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = '4691f21b-3911-4d7f-a45d-28ce75d79337'
const RELAY_DAEMON_URL = 'wss://relay-0.example.com/rd/ws'

let running: App | undefined
afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

async function start(): Promise<{ app: App; base: string }> {
  const config = AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://computer/ignored',
    API_KEY_PEPPER: PEPPER,
    RELAY_TOKEN,
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

async function registerComputer(app: App, allowedAgents: string[]): Promise<{ computerId: string; apiKey: string }> {
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
  const policy = await app.http.inject({
    method: 'PUT',
    url: `${ORG}/computers/${reg.computerId}/policy`,
    payload: { allowedAgents }
  })
  expect(policy.statusCode).toBe(200)
  return reg
}

function dial(url: string, protocol: string): Promise<WebSocket> {
  const ws = new WebSocket(url, [protocol])
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function next<T>(ws: WebSocket, decode: (text: string) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      const hit = decode(data.toString())
      if (hit === undefined) return
      ws.off('message', onMsg)
      resolve(hit)
    }
    ws.on('message', onMsg)
    ws.once('close', (code) => reject(new Error(`closed: ${code}`)))
  })
}

const computerFrame =
  <T extends ComputerCpFrame['type']>(type: T) =>
  (text: string) => {
    const decoded = decodeComputerCpFrameTolerant(text)
    return decoded.ok && decoded.frame.type === type
      ? (decoded.frame as Extract<ComputerCpFrame, { type: T }>)
      : undefined
  }

const rawFrame = (type: string) => (text: string) => {
  const frame = JSON.parse(text) as AnyFrame
  return frame.type === type ? frame : undefined
}

function send(ws: WebSocket, type: string, payload: unknown): void {
  ws.send(JSON.stringify({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, payload }))
}

async function openRelay(base: string): Promise<WebSocket> {
  const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)
  const authed = next(ws, rawFrame('rc/auth/ok'))
  send(ws, 'rc/auth', { method: 'token', credential: RELAY_TOKEN })
  await authed
  const registered = next(ws, rawFrame('rc/registered'))
  send(ws, 'rc/register', { name: 'relay-0', daemonUrl: RELAY_DAEMON_URL })
  await registered
  return ws
}

async function relayVerify(relay: WebSocket, credential: string, computerId: string): Promise<RcVerifyResult> {
  const reply = next(relay, rawFrame('rc/verify/ok'))
  send(relay, 'rc/verify', { kind: 'computer-relay-token', credential, computerId })
  return (await reply).payload as RcVerifyResult
}

// An agent daemon's end of the daemon wire, answered by the handler directly with the CP's own grant service.
function agentDaemon(daemonId = DAEMON) {
  const replies: Array<{ type: string; payload: unknown }> = []
  const conn = {
    daemonId,
    orgId: DEFAULT_ORG_ID,
    state: 'READY',
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
    clock: systemClock,
    log: { error: () => {}, warn: () => {} },
    computerChannelGrants: new ComputerChannelGrants(
      new PgComputerRepo(prisma),
      new ComputerChannelKeys(PEPPER, 300),
      systemClock,
      { staleAfterMs: 45_000, relays: async () => [] }
    )
  } as unknown as DaemonWsDeps
  return {
    async grant(computerId: string, sessionId = SESSION, agentId = AGENT) {
      const frame = {
        v: 1,
        id: randomUUID(),
        ts: new Date().toISOString(),
        type: 'computer-channel/grant',
        payload: { computerId, agentId, sessionId }
      } as AnyFrame
      await handleComputerChannelGrant(frame, conn, deps)
      return replies.at(-1)!
    }
  }
}

async function connectDesktop(base: string, apiKey: string) {
  const ws = await dial(`${base}/api/v1/computers/ws`, COMPUTER_CP_SUBPROTOCOL)
  const ok = next(ws, computerFrame('computer/auth/ok'))
  const relays = next(ws, computerFrame('computer/relays'))
  ws.send(JSON.stringify(buildComputerCpFrame('computer/auth', { apiKey, desktopDaemonVersion: '0.2.0' })))
  const auth: ComputerAuthOk = (await ok).payload
  return { ws, auth, relays: (await relays).payload.relays }
}

describe('Computer data-plane credentials', () => {
  it('gives the desktop the relay roster and a granted session a token only its desktop accepts', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { app, base } = await start()
    const relay = await openRelay(base)
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    const desktop = await connectDesktop(base, apiKey)
    expect(desktop.relays).toEqual([expect.objectContaining({ url: RELAY_DAEMON_URL })])

    const reply = await agentDaemon().grant(computerId)
    expect(reply).toMatchObject({ type: 'computer-channel/grant/result', payload: { granted: true, mode: 'control' } })
    const { token } = reply.payload as { token: string }
    // The desktop verifies with the key from its own channel; the CP is never asked.
    const key = Buffer.from(desktop.auth.credential.key, 'base64url')
    const verify = (computer: string) =>
      verifyComputerChannelToken(token, {
        aud: 'mcp',
        computerId: computer,
        key: (kid) => (kid === desktop.auth.credential.keyId ? key : undefined),
        now: Date.now()
      })
    expect(verify(computerId)).toMatchObject({ ses: SESSION, agt: AGENT, dmn: DAEMON })
    expect(verify(randomUUID())).toBeNull()

    // The desktop proves its key to a relay; the CP checks it, and stops once the Computer is revoked.
    const now = Date.now()
    const hello = signComputerChannelToken(
      { aud: 'relay', cmp: computerId, kid: desktop.auth.credential.keyId, iat: now, exp: now + 60_000 },
      key
    )
    expect(await relayVerify(relay, hello, computerId)).toMatchObject({ ok: true, computerId, orgId: DEFAULT_ORG_ID })
    expect(await relayVerify(relay, token, computerId)).toMatchObject({ ok: false })
    expect(await relayVerify(relay, hello, randomUUID())).toMatchObject({ ok: false })
    const revoked = await app.http.inject({ method: 'POST', url: `${ORG}/computers/${computerId}/revoke` })
    expect(revoked.statusCode).toBe(200)
    expect(await relayVerify(relay, hello, computerId)).toMatchObject({ ok: false })
    expect((await agentDaemon().grant(computerId)).payload).toMatchObject({ granted: false, code: 'unavailable' })
    relay.close()
    desktop.ws.close()
  })

  it('refuses a daemon that does not serve the agent, an ungranted agent and an offline Computer', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedDaemon(prisma, OTHER_DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const { app, base } = await start()
    const { computerId, apiKey } = await registerComputer(app, [AGENT])
    expect((await agentDaemon().grant(computerId)).payload).toMatchObject({ granted: false, code: 'unavailable' })
    const desktop = await connectDesktop(base, apiKey)
    expect((await agentDaemon(OTHER_DAEMON).grant(computerId)).payload).toMatchObject({ code: 'denied' })
    const ungranted = await app.http.inject({
      method: 'PUT',
      url: `${ORG}/computers/${computerId}/policy`,
      payload: { allowedAgents: [] }
    })
    expect(ungranted.statusCode).toBe(200)
    expect((await agentDaemon().grant(computerId)).payload).toMatchObject({ code: 'denied' })
    desktop.ws.close()
  })
})
