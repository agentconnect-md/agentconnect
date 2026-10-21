import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { restCredential, streamLink, TestTurnClient, udpLink, type TurnLink } from '../../test/turn-client.js'
import { CLASS } from './codec.js'
import { startTurnListeners, type TurnListenerOptions, type TurnListeners } from './listeners.js'
import { TurnServer } from './server.js'

const SECRET = 'k'.repeat(40)
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function selfSigned(): { certFile: string; keyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relay-turn-tls-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const certFile = join(dir, 'cert.pem')
  const keyFile = join(dir, 'key.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=turn.test',
      '-keyout',
      keyFile,
      '-out',
      certFile
    ],
    { stdio: 'ignore' }
  )
  return { certFile, keyFile }
}

async function start(
  tls?: { certFile: string; keyFile: string },
  limits: Partial<
    Pick<TurnListenerOptions, 'maxPendingConnections' | 'maxPendingPerAddress' | 'firstFrameTimeoutMs'>
  > = {
    maxPendingConnections: 4
  }
): Promise<{ turn: TurnServer; ports: TurnListeners }> {
  const turn = new TurnServer({
    realm: 'agentconnect',
    relayedAddress: '198.18.1.1',
    secret: () => SECRET,
    limits: { maxAllocations: 10, maxAllocationsPerUser: 4, maxBitsPerSecond: 10_000_000, idleTimeoutMs: 60_000 },
    log: quiet
  })
  const ports = await startTurnListeners({
    turn,
    host: '127.0.0.1',
    port: 0,
    ...(tls ? { tls: { port: 0, ...tls } } : {}),
    maxConnections: 4,
    ...limits,
    log: quiet
  })
  cleanup.push(() => ports.close())
  cleanup.push(() => turn.close())
  return { turn, ports }
}

const credential = (who: string) => restCredential(SECRET, who, Math.floor(Date.now() / 1000) + 600)

async function exchange(a: TurnLink, b: TurnLink): Promise<void> {
  cleanup.push(
    () => a.close(),
    () => b.close()
  )
  const desktop = new TestTurnClient(a, credential('computer-c1'))
  const viewer = new TestTurnClient(b, credential('viewer-u1'))
  expect((await desktop.allocate()).cls).toBe(CLASS.success)
  expect((await viewer.allocate()).cls).toBe(CLASS.success)
  await desktop.permit(viewer.relayed!)
  await viewer.bind(0x4000, desktop.relayed!)
  desktop.sendTo(viewer.relayed!, Buffer.from('video'))
  viewer.sendOnChannel(0x4000, Buffer.from('input'))
  await expect.poll(() => viewer.received.length).toBe(1)
  await expect.poll(() => desktop.received.length).toBe(1)
  expect(viewer.received[0]).toEqual({ peer: 0x4000, data: Buffer.from('video') })
  expect(desktop.received[0]).toEqual({ peer: viewer.relayed, data: Buffer.from('input') })
}

describe('TURN listeners', () => {
  it('relays between a UDP client and a TCP client', async () => {
    const { ports } = await start()
    await exchange(await udpLink(ports.udpPort), await streamLink(ports.tcpPort))
  })

  it.skipIf(!opensslAvailable())('relays between a UDP client and a TLS client', async () => {
    const { ports } = await start(selfSigned())
    await exchange(await udpLink(ports.udpPort), await streamLink(ports.tlsPort!, true))
  })

  it('deletes a stream allocation when its connection closes, and refuses connections past the limit', async () => {
    const { turn, ports } = await start()
    const tcp = await streamLink(ports.tcpPort)
    await new TestTurnClient(tcp, credential('viewer-u1')).allocate()
    expect(turn.allocations).toBe(1)
    tcp.close()
    await expect.poll(() => turn.allocations).toBe(0)
    const links = await Promise.all([0, 1, 2, 3].map(() => streamLink(ports.tcpPort)))
    cleanup.push(() => links.forEach((l) => l.close()))
    const extra = await streamLink(ports.tcpPort)
    await expect.poll(() => extra.socket.destroyed || extra.socket.readableEnded).toBe(true)
  })

  it('caps unallocated connections per remote IP, and frees the slot once one allocates', async () => {
    const { ports } = await start(undefined, { maxPendingConnections: 4, maxPendingPerAddress: 2 })
    const [a, b] = await Promise.all([streamLink(ports.tcpPort), streamLink(ports.tcpPort)])
    cleanup.push(
      () => a.close(),
      () => b.close()
    )
    const refused = await streamLink(ports.tcpPort)
    await expect.poll(() => refused.socket.destroyed || refused.socket.readableEnded).toBe(true)
    expect((await new TestTurnClient(a, credential('viewer-u1')).allocate()).cls).toBe(CLASS.success)
    const next = await streamLink(ports.tcpPort)
    cleanup.push(() => next.close())
    expect((await new TestTurnClient(next, credential('viewer-u1')).allocate()).cls).toBe(CLASS.success)
  })

  it('closes a connection that sends nothing before the first-frame deadline', async () => {
    const { ports } = await start(undefined, { maxPendingConnections: 4, firstFrameTimeoutMs: 100 })
    const silent = await streamLink(ports.tcpPort)
    await expect.poll(() => silent.socket.destroyed || silent.socket.readableEnded).toBe(true)
  })

  it('closes a stream that sends garbage', async () => {
    const { ports } = await start()
    const tcp = await streamLink(ports.tcpPort)
    tcp.send(Buffer.from([0xff, 0xff, 0xff, 0xff]))
    await expect.poll(() => tcp.socket.destroyed || tcp.socket.readableEnded).toBe(true)
  })
})
