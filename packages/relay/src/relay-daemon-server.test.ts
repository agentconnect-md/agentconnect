import { describe, it, expect, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import type { FastifyInstance } from 'fastify'
import {
  buildRelayDaemonFrame,
  RELAY_DAEMON_SUBPROTOCOL,
  RELAY_DAEMON_WS_PATH,
  type RcVerifyResult,
  type RelayDaemonFrame
} from '@agentconnect.md/protocol'
import { FakeClock } from '@agentconnect.md/connection'
import { createRelayDaemonServer, type RelayDaemonServer, type RelayDaemonServerDeps } from './relay-daemon-server.js'
import type { Logger } from './log.js'

const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let http: Server | undefined
let rd: RelayDaemonServer | undefined

afterEach(async () => {
  for (const ws of rd?.wss.clients ?? []) ws.terminate()
  rd?.wss.close()
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()))
  http = undefined
  rd = undefined
})

async function start(
  verify: RelayDaemonServerDeps['verify'],
  relayId: () => string | undefined = () => RELAY_ID
): Promise<string> {
  http = createServer()
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', () => r()))
  rd = createRelayDaemonServer({ server: http } as unknown as FastifyInstance, {
    verify,
    relayId,
    clock: new FakeClock(),
    onChat: () => {},
    onWebchatPost: () => {},
    onAgentMsg: async () => ({ deliveryId: 'unused', delivered: false }),
    log: silentLog
  })
  const port = (http.address() as AddressInfo).port
  return `ws://127.0.0.1:${port}`
}

function dial(base: string, sub: string): Promise<WebSocket> {
  const ws = new WebSocket(`${base}${RELAY_DAEMON_WS_PATH}`, sub)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('close', (c) => reject(new Error(`closed before open: ${c}`)))
  })
}
function nextFrame(ws: WebSocket, type: string): Promise<RelayDaemonFrame> {
  return new Promise((resolve, reject) => {
    const onMsg = (d: Buffer): void => {
      const f = JSON.parse(d.toString()) as RelayDaemonFrame
      if (f.type === type) {
        ws.off('message', onMsg)
        resolve(f)
      }
    }
    ws.on('message', onMsg)
    ws.once('close', (c) => reject(new Error(`closed waiting for ${type}: ${c}`)))
  })
}
const closeCode = (ws: WebSocket): Promise<number> => new Promise((r) => ws.once('close', (c) => r(c)))
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('createRelayDaemonServer (rd/* accept edge)', () => {
  it('rd/hello → rd/hello/ok, tracks the daemon, and revoke() drops its socket', async () => {
    const verify = vi.fn(async () => ({ ok: true, daemonId: DAEMON_ID, orgId: 'org-1' }) as RcVerifyResult)
    const base = await start(verify)
    const ws = await dial(base, RELAY_DAEMON_SUBPROTOCOL)

    ws.send(JSON.stringify(buildRelayDaemonFrame('rd/hello', { apiKey: 'k', daemonId: DAEMON_ID })))
    const ok = await nextFrame(ws, 'rd/hello/ok')
    expect(ok.payload).toEqual({ relayId: RELAY_ID })
    expect(verify).toHaveBeenCalledWith('daemon-key', 'k', DAEMON_ID)
    await tick()
    expect(rd!.size()).toBe(1)

    // An org-scoped key daemon is outside the duty plane — never a rendezvous candidate.
    expect(rd!.get(DAEMON_ID)?.credentialKind).toBe('daemon-key')
    expect(rd!.rendezvousCandidate()).toBeUndefined()

    // CP-driven revoke: closes the daemon's rd/* socket and clears the map.
    const closed = closeCode(ws)
    rd!.revoke(DAEMON_ID)
    expect(await closed).toBe(4409)
    await tick()
    expect(rd!.size()).toBe(0)
  })

  it('offers a projected-token pool member as the webchat rendezvous candidate', async () => {
    const verify = vi.fn(async () => ({ ok: true, daemonId: DAEMON_ID }) as RcVerifyResult)
    const base = await start(verify)
    const ws = await dial(base, RELAY_DAEMON_SUBPROTOCOL)

    ws.send(JSON.stringify(buildRelayDaemonFrame('rd/hello', { serviceAccountToken: 't', daemonId: DAEMON_ID })))
    await nextFrame(ws, 'rd/hello/ok')
    expect(verify).toHaveBeenCalledWith('daemon-token', 't', DAEMON_ID)
    await tick()

    const candidate = rd!.rendezvousCandidate()
    expect(candidate?.daemonId).toBe(DAEMON_ID)
    expect(candidate?.conn.credentialKind).toBe('daemon-token')

    rd!.revoke(DAEMON_ID)
    await tick()
    expect(rd!.rendezvousCandidate()).toBeUndefined()
    ws.close()
  })

  it('rejects a client that does not offer the rd subprotocol', async () => {
    const base = await start(async () => ({ ok: true, daemonId: DAEMON_ID, orgId: 'o' }))
    await expect(dial(base, 'agentconnect.v1')).rejects.toThrow()
  })

  it('revoke() for an unknown daemon is a no-op', async () => {
    await start(async () => ({ ok: true, daemonId: DAEMON_ID, orgId: 'o' }))
    expect(() => rd!.revoke('nobody')).not.toThrow()
  })
})
