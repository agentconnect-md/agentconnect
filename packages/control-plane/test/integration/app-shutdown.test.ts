/**
 * Graceful-shutdown drain (deploy-time outage regression).
 *
 * Fastify's `close()` never destroys upgraded WS sockets, and in noServer mode
 * `wss.close()`'s callback only fires once the client set empties on its own —
 * so before `drainWs()` existed, a single connected daemon (or webchat tab)
 * wedged the SIGTERM path forever: the old pod lingered until SIGKILL while its
 * daemons stayed pinned to it instead of reconnecting to the new pod (the
 * every-deploy "whole fleet offline / sessions empty" window).
 *
 * This test proves the fixed ordering — `drainWs() → http.close() → shutdown()`
 * — completes promptly with live WS clients connected, and that each client is
 * closed with `1012` (service restart), which the daemon treats as transient
 * (only 4401 is fatal) and answers with an immediate reconnect.
 *
 * Runs against real Testcontainers Postgres (the handshake mints a real epoch).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { isFrame, type AnyFrame } from '@agentconnect.md/protocol'

import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema, type AppConfig } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'abababab-abab-4bab-8bab-abababababab'
const SUBPROTOCOL = 'agentconnect.v1'
const API_KEY_PEPPER = 'drain-api-key-pepper-0123456789abcdef'

function drainConfig(): AppConfig {
  return AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://drain/ignored', // prisma is injected; URL unused
    API_KEY_PEPPER,
    SECRETS_PROVIDER: 'memory',
    WS_PATH: '/daemon/ws',
    HEARTBEAT_SEC: 15
  })
}

let running: App | undefined

afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

async function start(): Promise<{ app: App; wsUrl: string; token: string }> {
  const config = drainConfig()
  const app = buildApp({
    prisma,
    config,
    clock: systemClock,
    secretsProvider: new MemorySecretsProvider()
  })
  running = app

  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()

  const codec = new ApiKeyCodec({ API_KEY_PEPPER })
  const minted = codec.mint()
  await prisma.daemon.create({ data: { id: DAEMON, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
  await prisma.apiKey.create({
    data: {
      principalType: 'daemon',
      orgId: DEFAULT_ORG_ID,
      daemonId: DAEMON,
      hash: minted.hash,
      displayTail: minted.displayTail
    }
  })

  return { app, wsUrl: `${address.replace(/^http/, 'ws')}${config.WS_PATH}`, token: minted.token }
}

function dial(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, SUBPROTOCOL)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextFrame(ws: WebSocket, type: string): Promise<AnyFrame> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer): void => {
      const frame = JSON.parse(data.toString()) as AnyFrame
      if (frame.type === type) {
        ws.off('message', onMsg)
        resolve(frame)
      }
    }
    ws.on('message', onMsg)
    ws.once('close', (code) => reject(new Error(`closed waiting for ${type}: ${code}`)))
  })
}

function sendFrame(ws: WebSocket, type: string, payload: unknown, id = randomUUID()): string {
  ws.send(JSON.stringify({ v: 1, id, ts: new Date().toISOString(), type, payload }))
  return id
}

/** Resolve with the close code the server sends this client. */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}

async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not complete within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([p, guard])
  } finally {
    clearTimeout(timer)
  }
}

describe('graceful shutdown with connected WS clients', () => {
  it('drainWs → http.close → shutdown completes promptly and closes every client with 1012', async () => {
    const { app, wsUrl, token } = await start()

    // 1. A fully-handshaken daemon (auth → auth/ok → register → register/ok).
    const daemonWs = await dial(wsUrl)
    const authId = sendFrame(daemonWs, 'auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.5.0' })
    const ok = await nextFrame(daemonWs, 'auth/ok')
    if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')
    expect(ok.corr).toBe(authId)
    sendFrame(daemonWs, 'register', {
      host: 'drain-host',
      capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
      maxAgents: 4,
      localState: { assignments: [], crons: [], leases: [] }
    })
    await nextFrame(daemonWs, 'register/ok')

    // 2. A second upgraded-but-idle socket (never authed) — the minimal client
    //    that used to wedge http.close() all by itself.
    const idleWs = await dial(wsUrl)

    const daemonClose = closeCode(daemonWs)
    const idleClose = closeCode(idleWs)

    // 3. The production SIGTERM ordering. Before the drain existed this hung
    //    on http.close() until SIGKILL; now the whole sequence is sub-second.
    await withDeadline(
      (async () => {
        await app.drainWs()
        await app.http.close()
        await app.shutdown()
      })(),
      8000,
      'graceful shutdown with connected WS clients'
    )
    running = undefined // already shut down — skip the afterEach double-run

    // 4. Both clients saw 1012 (service restart) — the daemon's CpClient treats
    //    it as transient and reconnects immediately (only 4401 is fatal).
    expect(await withDeadline(daemonClose, 2000, 'daemon close code')).toBe(1012)
    expect(await withDeadline(idleClose, 2000, 'idle close code')).toBe(1012)
  }, 20000)

  it('shutdown() alone also drains connected clients instead of hanging', async () => {
    const { app, wsUrl } = await start()
    const ws = await dial(wsUrl)
    const closed = closeCode(ws)

    await withDeadline(app.shutdown(), 8000, 'shutdown with a connected client')
    running = undefined

    expect(await withDeadline(closed, 2000, 'close code')).toBe(1012)
  }, 20000)

  it('refuses new WS upgrades once draining — a reconnect race cannot wedge http.close()', async () => {
    const { app, wsUrl } = await start()
    const ws = await dial(wsUrl)
    const closed = closeCode(ws)

    await withDeadline(app.drainWs(), 8000, 'drainWs')
    expect(await withDeadline(closed, 2000, 'close code')).toBe(1012)

    // The wss is out of RUNNING: an upgrade landing in the drain→http.close gap
    // is aborted with 503 instead of minting a fresh socket that would re-wedge
    // http.close() until the failsafe exit.
    await expect(dial(wsUrl)).rejects.toThrow(/503/)

    await withDeadline(app.http.close(), 8000, 'http.close after drain')
    await withDeadline(app.shutdown(), 8000, 'shutdown after drain')
    running = undefined
  }, 20000)
})
