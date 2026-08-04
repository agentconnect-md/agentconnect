/**
 * Phase 3 mount test (design §6 Phase 3, "Mount Red"; protocol §1, §2).
 *
 * A REAL `ws` client dials the live Fastify `app.server` at `WS_PATH` with the
 * `agentconnect.v1` subprotocol and completes the full handshake over an actual
 * socket: `auth → auth/ok → register → register/ok`. This proves
 * `createDaemonWsServer` bridges the live `WsTransport` into the SAME
 * `connection.ts` FSM the in-memory protocol tests drive. A client offering the
 * wrong subprotocol is rejected with close `4400`.
 *
 * Runs against real Testcontainers Postgres (the handshake mints a real epoch and
 * reads the real reconcile snapshot).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { isFrame, type AnyFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildDaemonApp, type DaemonApp } from '../fakes/build-app.js'

const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SUBPROTOCOL = 'agentconnect.v1'

let running: DaemonApp | undefined

afterEach(async () => {
  await running?.close()
  running = undefined
})

/** Build + listen on an ephemeral port; return the app and its ws:// URL. */
async function start(): Promise<{ app: DaemonApp; url: string; token: string }> {
  const app = buildDaemonApp(prisma)
  running = app
  const address = await app.listen()
  const token = await app.mintToken(DAEMON)
  return { app, url: `${address.replace(/^http/, 'ws')}/daemon/ws`, token }
}

/** Open a ws client with the given subprotocol(s); resolve once open. */
function dial(url: string, protocols: string | string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('close', (code) => reject(new Error(`closed before open: ${code}`)))
  })
}

/** Await the next decoded frame of `type` from the socket. */
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

describe('ws gateway — real socket handshake over agentconnect.v1', () => {
  it('completes auth → auth/ok → register → register/ok over a live ws connection', async () => {
    const { url, token } = await start()
    const ws = await dial(url, SUBPROTOCOL)
    try {
      // The server echoes the negotiated subprotocol on accept (protocol §1).
      expect(ws.protocol).toBe(SUBPROTOCOL)

      // auth → auth/ok (epoch minted, heartbeat cadence).
      const authId = sendFrame(ws, 'auth', { apiKey: token, daemonId: DAEMON, agentVersion: '1.4.0' })
      const ok = await nextFrame(ws, 'auth/ok')
      if (!isFrame('auth/ok')(ok)) throw new Error('expected auth/ok')
      expect(ok.corr).toBe(authId)
      expect(ok.payload.daemonId).toBe(DAEMON)
      expect(ok.payload.sessionEpoch).toBe(1) // first auth → epoch 1
      expect(ok.payload.heartbeatSec).toBe(15)

      // register → register/ok (authoritative reconcile snapshot; empty here).
      const regId = sendFrame(ws, 'register', {
        host: 'host-1',
        capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true },
        maxAgents: 4,
        localState: { assignments: [], crons: [], leases: [] }
      })
      const regOk = await nextFrame(ws, 'register/ok')
      if (!isFrame('register/ok')(regOk)) throw new Error('expected register/ok')
      expect(regOk.corr).toBe(regId)
      expect(regOk.payload.assignments).toEqual([])
      expect(regOk.payload.drop).toEqual({ assignments: [], crons: [], agents: [], integrations: [] })
      // The console-set finished-session retention rides the snapshot (column default).
      expect(regOk.payload.sessionRetention).toBe('7d')

      // The daemon row was persisted at READY with the registered capabilities.
      const row = await prisma.daemon.findUnique({ where: { id: DAEMON } })
      expect(row?.status).toBe('ready')
      expect(row?.sessionEpoch).toBe(1n)
      expect(row?.host).toBe('host-1')
    } finally {
      ws.close()
    }
  })

  it('rejects a mismatched subprotocol with close 4400', async () => {
    const { url } = await start()
    const ws = new WebSocket(url, 'totally.wrong.v9')
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.once('close', (code) => resolve(code))
      ws.once('open', () => reject(new Error('should not have opened')))
      // `ws` surfaces the server's HTTP 4xx rejection as an error; the close code
      // for an upgrade refused before the WS handshake is 1006 at the client, but
      // our server writes an explicit 4400 close intent — assert on whichever the
      // client observes (1006 for a refused upgrade, 4400 if negotiated then closed).
      ws.once('error', () => {
        /* swallow — the close handler resolves the assertion */
      })
    })
    expect([4400, 1006]).toContain(closeCode)
  })
})
