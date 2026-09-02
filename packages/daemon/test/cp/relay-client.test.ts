import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayDaemonFrame,
  GITLAB_COM_V1_FEATURE,
  GITLAB_INSTANCE_V1_FEATURE,
  RD_HEADLESS_AGENT_DELIVERY_V1,
  RD_AGENT_IMPLICIT_ROUTING_V1,
  RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
  RD_WEBCHAT_ATTACH_V1,
  RELAY_DAEMON_SUBPROTOCOL,
  type RelayDaemonFrame,
  type RdMsg,
  type RdChatEvent,
  type RdAck
} from '@agentconnect.md/protocol'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import { RelayClient, type RelayClientDeps } from '../../src/cp/relay-client.js'
import type { Logger } from '../../src/log.js'

const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const URL = 'wss://relay-0.example.test'
const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLog
} as unknown as Logger

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

class FakeTransport implements Transport {
  readonly subprotocol = RELAY_DAEMON_SUBPROTOCOL
  sent: RelayDaemonFrame[] = []
  closed?: { code: number; reason: string }
  private msgCb?: (t: string) => void
  private closeCb?: (c: number, r: string) => void
  send(text: string): void {
    this.sent.push(JSON.parse(text) as RelayDaemonFrame)
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.closeCb = cb
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  inject(frame: RelayDaemonFrame): void {
    this.msgCb?.(JSON.stringify(frame))
  }
  simulateClose(code: number): void {
    this.closeCb?.(code, 'test')
  }
  lastReq(type: string): RelayDaemonFrame | undefined {
    return [...this.sent].reverse().find((f) => f.type === type)
  }
}

function make(
  over: {
    daemonId?: () => string | undefined
    apiKey?: () => string
    clusterIdentityToken?: () => string | undefined
    onRelayMsg?: (msg: RdMsg, chat: (event: RdChatEvent) => void) => RdAck
  } = {}
) {
  const clock = new FakeClock()
  const transports: FakeTransport[] = []
  const connect = vi.fn(async () => {
    const t = new FakeTransport()
    transports.push(t)
    return t
  })
  const client = new RelayClient(RELAY_ID, URL, {
    apiKey: over.apiKey ?? (() => 'daemon-key'),
    ...(over.clusterIdentityToken ? { clusterIdentityToken: over.clusterIdentityToken } : {}),
    daemonId: over.daemonId ?? (() => DAEMON_ID),
    clock,
    connect,
    log: silentLog,
    jitter: () => 0,
    onRelayMsg: over.onRelayMsg ?? ((msg: RdMsg) => ({ msgId: msg.msgId, accepted: true }))
  } as unknown as RelayClientDeps)
  return { client, clock, transports, connect }
}

async function toReady(
  client: RelayClient,
  transports: FakeTransport[],
  relayIdEcho = RELAY_ID
): Promise<FakeTransport> {
  client.start()
  await flush()
  const t = transports[transports.length - 1]!
  const hello = t.lastReq('rd/hello')!
  t.inject(buildRelayDaemonFrame('rd/hello/ok', { relayId: relayIdEcho }, { corr: hello.id }))
  await flush()
  return t
}

describe('RelayClient (daemon → one relay)', () => {
  it('rd/hello → rd/hello/ok (matching relayId) → READY', async () => {
    const { client, transports } = make()
    const t = await toReady(client, transports)
    // Hello also advertises this build's optional `rd/*` behaviors, so the relay can
    // REFUSE a delivery this daemon cannot honor rather than degrade it
    // (send-message-routing-rework.md §8.4).
    expect(t.lastReq('rd/hello')!.payload).toEqual({
      apiKey: 'daemon-key',
      daemonId: DAEMON_ID,
      capabilities: [
        RD_HEADLESS_AGENT_DELIVERY_V1,
        RD_AGENT_IMPLICIT_ROUTING_V1,
        RD_GITHUB_THREAD_WORKTREE_CLEANUP_V2,
        RD_WEBCHAT_ATTACH_V1,
        GITLAB_COM_V1_FEATURE,
        GITLAB_INSTANCE_V1_FEATURE
      ]
    })
    expect(client.state).toBe('READY')
    expect(client.isReady()).toBe(true)
  })

  it('presents the projected token instead of a key when this daemon has one', async () => {
    const reads: number[] = []
    let current = 'projected-1'
    const { client, transports } = make({
      apiKey: () => '',
      clusterIdentityToken: () => {
        reads.push(reads.length)
        return current
      }
    })
    const t = await toReady(client, transports)
    expect(t.lastReq('rd/hello')!.payload).toMatchObject({ serviceAccountToken: 'projected-1' })
    expect((t.lastReq('rd/hello')!.payload as { apiKey?: string }).apiKey).toBeUndefined()
    // Re-read per connect for the same reason as the CP socket: the kubelet rotates it.
    current = 'projected-2'
    await toReady(client, transports)
    expect(reads.length).toBeGreaterThan(1)
  })

  it('treats a relayId echo mismatch as a misroute — never READY, reconnects', async () => {
    const { client, clock, transports, connect } = make()
    await toReady(client, transports, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') // wrong relay
    expect(client.state).not.toBe('READY') // misroute → never serves this socket
    expect(transports[0]!.closed?.code).toBe(1011) // dropped the wrong-instance socket
    clock.advance(1000) // backoff base
    await flush()
    expect(connect).toHaveBeenCalledTimes(2) // redials (deployment must fix per-instance routing)
  })

  it('a 4401 rd/hello rejection is fatal — stops dialing this relay', async () => {
    const { client, clock, transports, connect } = make()
    client.start()
    await flush()
    transports[0]!.simulateClose(4401)
    expect(client.state).toBe('CLOSED')
    clock.advance(60_000)
    await flush()
    expect(connect).toHaveBeenCalledTimes(1) // no redial
  })

  it('reconnects with backoff on a non-fatal close', async () => {
    const { client, clock, transports, connect } = make()
    await toReady(client, transports)
    transports[0]!.simulateClose(1006)
    expect(client.state).toBe('DEGRADED')
    clock.advance(1000)
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('does not dial until the daemonId is adopted', async () => {
    const held: { id: string | undefined } = { id: undefined }
    const { client, clock, connect } = make({ daemonId: () => held.id })
    client.start()
    await flush()
    expect(connect).not.toHaveBeenCalled() // no id yet → deferred
    held.id = DAEMON_ID
    clock.advance(1000)
    await flush()
    expect(connect).toHaveBeenCalledTimes(1) // dials once the id resolves
  })

  it('stop() closes the transport and halts reconnect', async () => {
    const { client, clock, transports, connect } = make()
    await toReady(client, transports)
    await client.stop()
    expect(transports[0]!.closed?.code).toBe(1000)
    clock.advance(60_000)
    await flush()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('stamps a monotonic per-chat seq on rd/chat and prunes the counter on the terminal done', async () => {
    const CHAT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const AGENT = '11111111-1111-4111-8111-111111111111'
    const TURN = '22222222-2222-4222-8222-222222222222'
    // A daemon that streams one output chunk then a done for each inbound turn.
    const stream = (msg: RdMsg, chat: (e: RdChatEvent) => void): RdAck => {
      chat({ kind: 'output', output: { conversationId: CHAT, turnId: TURN, index: 0, status: { model: 'm' } } })
      chat({ kind: 'done', done: { conversationId: CHAT, turnId: TURN } })
      return { msgId: msg.msgId, accepted: true, turnId: TURN }
    }
    const { client, transports } = make({ onRelayMsg: stream })
    const t = await toReady(client, transports)
    const turn = (msgId: string): RelayDaemonFrame =>
      buildRelayDaemonFrame('rd/msg', {
        source: 'webchat',
        agentId: AGENT,
        sessionKey: CHAT,
        msgId,
        chatId: CHAT,
        payload: { op: 'turn', text: 'go' }
      })
    const seqs = (): number[] =>
      t.sent.filter((f) => f.type === 'rd/chat').map((f) => (f.payload as { seq: number }).seq)

    t.inject(turn('m1'))
    await flush()
    expect(seqs()).toEqual([1, 2]) // output=1, done=2
    expect((client as unknown as { seqByChat: Map<string, number> }).seqByChat.has(CHAT)).toBe(false) // pruned on done

    // A second turn on the SAME chat restarts seq at 1 — proves the prune, not a leak.
    t.inject(turn('m2'))
    await flush()
    expect(seqs()).toEqual([1, 2, 1, 2])
  })
})

describe('RelayClient — an inbound frame that fails to decode', () => {
  it('logs the drop with its type, id and size, and answers a correlated error so the relay fails fast', async () => {
    const warn = vi.fn()
    const log = { ...silentLog, warn } as unknown as Logger
    const clock = new FakeClock()
    const transports: FakeTransport[] = []
    const onRelayMsg = vi.fn((msg: RdMsg) => ({ msgId: msg.msgId, accepted: true }))
    const client = new RelayClient(RELAY_ID, URL, {
      apiKey: () => 'daemon-key',
      daemonId: () => DAEMON_ID,
      clock,
      connect: vi.fn(async () => {
        const t = new FakeTransport()
        transports.push(t)
        return t
      }),
      log,
      jitter: () => 0,
      onRelayMsg
    } as unknown as RelayClientDeps)
    const t = await toReady(client, transports)
    // A relay-minted `rd/msg` whose payload the schema rejects (no `source`, no `payload`).
    const bad = buildRelayDaemonFrame('rd/msg', { msgId: 'm-1' } as never)
    t.inject(bad)
    await flush()
    expect(onRelayMsg).not.toHaveBeenCalled()
    expect(t.lastReq('rd/ack')).toBeUndefined()
    // The relay learns the reason at once: a correlated `error` settles its request instead of
    // five silent retries.
    const nak = t.lastReq('error')!
    expect(nak.corr).toBe(bad.id)
    expect(nak.payload).toMatchObject({ code: 'BAD_PAYLOAD', retryable: false })
    expect(String((nak.payload as { message: string }).message)).toContain('source')
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('undecodable'))
    expect(line).toContain(`dropping undecodable rd/msg frame ${bad.id}`)
    expect(line).toMatch(/\(\d+ bytes\)/)
  })
})
