import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayCpFrame,
  RELAY_CP_SUBPROTOCOL,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  type RelayCpFrame
} from '@agentconnect.md/protocol'
import { FakeClock, type Transport } from '@agentconnect.md/connection'
import { RelayCpClient, type RelayCpClientDeps } from './relay-cp-client.js'
import type { Logger } from './log.js'

const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const DAEMON_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = 'x'.repeat(32)
const COMMENT_AUTHZ = {
  hookId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  installationId: '1234567',
  repoId: '987654321',
  repoFullName: 'acme/infra',
  senderLogin: 'alice',
  configRevision: '3',
  dispatchRevision: '5'
} as const
const REREQUEST = {
  checkRunId: '86617583005',
  repoId: '987654321',
  headSha: 'a'.repeat(40),
  deliveryKey: 'delivery-rerun-1'
} as const

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Flush the native promise microtask/macrotask queue (the FSM's handshake chain
 *  is promise-driven; its timers use the injected FakeClock). */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

class FakeTransport implements Transport {
  readonly subprotocol = RELAY_CP_SUBPROTOCOL
  sent: RelayCpFrame[] = []
  closed?: { code: number; reason: string }
  private msgCb?: (t: string) => void
  private closeCb?: (c: number, r: string) => void

  send(text: string): void {
    this.sent.push(JSON.parse(text) as RelayCpFrame)
  }
  onMessage(cb: (t: string) => void): void {
    this.msgCb = cb
  }
  onClose(cb: (c: number, r: string) => void): void {
    this.closeCb = cb
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
    this.closeCb?.(code, reason)
  }

  // ── test helpers ──
  inject(frame: RelayCpFrame): void {
    this.msgCb?.(JSON.stringify(frame))
  }
  simulateClose(code: number): void {
    this.closeCb?.(code, 'test')
  }
  lastReq(type: string): RelayCpFrame | undefined {
    return [...this.sent].reverse().find((f) => f.type === type)
  }
}

/** Drive a client from start() through to READY against `transport`. */
async function handshakeToReady(
  client: RelayCpClient,
  transport: FakeTransport,
  heartbeatSec = 15,
  deploymentConfig?: { revision: number; githubWebhookSecret?: string }
): Promise<void> {
  client.start()
  await flush()
  const auth = transport.lastReq('rc/auth')!
  transport.inject(
    buildRelayCpFrame(
      'rc/auth/ok',
      {
        heartbeatSec,
        serverTime: '2026-07-07T00:00:00.000Z',
        ...(deploymentConfig ? { deploymentConfig } : {})
      },
      { corr: auth.id }
    )
  )
  await flush()
  const reg = transport.lastReq('rc/register')!
  transport.inject(buildRelayCpFrame('rc/registered', { relayId: RELAY_ID }, { corr: reg.id }))
  await flush()
}

function makeClient(over: Partial<RelayCpClientDeps> = {}) {
  const clock = new FakeClock()
  const transport = new FakeTransport()
  const onRegistered = vi.fn()
  const onRevoke = vi.fn()
  const onReady = vi.fn()
  const connect = vi.fn(async () => transport)
  const client = new RelayCpClient({
    auth: { method: 'token', credential: TOKEN },
    name: 'relay-0',
    daemonUrl: 'wss://relay-0.example',
    heartbeatDefaultMs: 15_000,
    clock,
    connect,
    log: silentLog,
    jitter: () => 0,
    onRegistered,
    onRevoke,
    onReady,
    ...over
  })
  return { client, clock, transport, connect, onRegistered, onRevoke, onReady }
}

describe('RelayCpClient', () => {
  it('runs rc/auth → rc/register → READY and reports the relayId', async () => {
    const { client, transport, onRegistered, onReady } = makeClient()
    await handshakeToReady(client, transport)

    const auth = transport.lastReq('rc/auth')!
    expect(auth.payload).toEqual({ method: 'token', credential: TOKEN })
    const reg = transport.lastReq('rc/register')!
    expect(reg.payload).toEqual({
      name: 'relay-0',
      daemonUrl: 'wss://relay-0.example',
      features: [WEBCHAT_SESSION_CONTINUATION_FEATURE]
    })

    expect(client.state).toBe('READY')
    expect(client.relayId).toBe(RELAY_ID)
    expect(client.isReady()).toBe(true)
    expect(onRegistered).toHaveBeenCalledWith(RELAY_ID)
    expect(onReady).toHaveBeenCalledOnce()
  })

  it('applies the authenticated deployment snapshot during startup', async () => {
    const onDeploymentConfig = vi.fn()
    const { client, transport } = makeClient({ onDeploymentConfig })
    const snapshot = { revision: 8, githubWebhookSecret: 'ghw_secret' }
    await handshakeToReady(client, transport, 15, snapshot)
    expect(onDeploymentConfig).toHaveBeenCalledOnce()
    expect(onDeploymentConfig).toHaveBeenCalledWith(snapshot)
  })

  it('freezes an absent startup snapshot until the relay process restarts', async () => {
    const clock = new FakeClock()
    const transports: FakeTransport[] = []
    const onDeploymentConfig = vi.fn()
    const client = new RelayCpClient({
      auth: { method: 'token', credential: TOKEN },
      name: 'relay-0',
      daemonUrl: 'wss://relay-0.example',
      heartbeatDefaultMs: 15_000,
      clock,
      connect: async () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      },
      log: silentLog,
      jitter: () => 0,
      onDeploymentConfig
    })

    client.start()
    await flush()
    const first = transports[0]!
    const firstAuth = first.lastReq('rc/auth')!
    first.inject(
      buildRelayCpFrame(
        'rc/auth/ok',
        { heartbeatSec: 15, serverTime: new Date(0).toISOString() },
        { corr: firstAuth.id }
      )
    )
    await flush()
    const firstRegister = first.lastReq('rc/register')!
    first.inject(buildRelayCpFrame('rc/registered', { relayId: RELAY_ID }, { corr: firstRegister.id }))
    await flush()

    first.simulateClose(1012)
    clock.advance(1_000)
    await flush()
    const second = transports[1]!
    const secondAuth = second.lastReq('rc/auth')!
    second.inject(
      buildRelayCpFrame(
        'rc/auth/ok',
        {
          heartbeatSec: 15,
          serverTime: new Date(0).toISOString(),
          deploymentConfig: { revision: 9, githubWebhookSecret: 'must-not-hot-reload' }
        },
        { corr: secondAuth.id }
      )
    )
    await flush()

    expect(onDeploymentConfig).not.toHaveBeenCalled()
    await client.stop()
  })

  it('emits rc/heartbeat at the CP-dictated cadence', async () => {
    const { client, clock, transport } = makeClient()
    await handshakeToReady(client, transport, 20) // heartbeatSec = 20

    transport.sent.length = 0
    clock.advance(20_000)
    expect(transport.lastReq('rc/heartbeat')).toBeDefined()
    transport.sent.length = 0
    clock.advance(20_000)
    expect(transport.lastReq('rc/heartbeat')).toBeDefined() // re-arms
  })

  it('dispatches rc/daemon-revoke to onRevoke', async () => {
    const { client, transport, onRevoke } = makeClient()
    await handshakeToReady(client, transport)
    transport.inject(buildRelayCpFrame('rc/daemon-revoke', { daemonId: DAEMON_ID }))
    expect(onRevoke).toHaveBeenCalledWith(DAEMON_ID)
  })

  it('dispatches owner affinity and participant membership independently', async () => {
    const onAssign = vi.fn()
    const onParticipantAssign = vi.fn()
    const { client, transport } = makeClient({ onAssign, onParticipantAssign })
    await handshakeToReady(client, transport)
    const target = {
      botId: RELAY_ID,
      sessionKey: 'C1/ts',
      agentId: RELAY_ID,
      daemonId: DAEMON_ID
    }

    transport.inject(buildRelayCpFrame('rc/assign', target))
    transport.inject(buildRelayCpFrame('rc/participant-assign', target))

    expect(onAssign).toHaveBeenCalledWith(target)
    expect(onParticipantAssign).toHaveBeenCalledWith(target)
  })

  it('dispatches purpose-separated memory connection bindings', async () => {
    const onMemoryConnectionAssign = vi.fn()
    const onMemoryConnectionUnassign = vi.fn()
    const { client, transport } = makeClient({ onMemoryConnectionAssign, onMemoryConnectionUnassign })
    await handshakeToReady(client, transport)
    const assign = {
      connectionId: RELAY_ID,
      revision: 3,
      upstreamUrl: 'https://memory.example/mcp',
      headers: [{ name: 'Authorization', value: 'upstream-secret' }],
      grantKeyHashes: ['a'.repeat(64)]
    }
    transport.inject(buildRelayCpFrame('rc/memoryconnection-assign', assign))
    transport.inject(
      buildRelayCpFrame('rc/memoryconnection-unassign', {
        connectionId: RELAY_ID,
        revision: 3,
        grantKeyHash: 'a'.repeat(64)
      })
    )

    expect(onMemoryConnectionAssign).toHaveBeenCalledWith(assign)
    expect(onMemoryConnectionUnassign).toHaveBeenCalledWith({
      connectionId: RELAY_ID,
      revision: 3,
      grantKeyHash: 'a'.repeat(64)
    })
  })

  it('emitGithubInstallation sends the doorbell when READY, drops it otherwise', async () => {
    const { client, transport } = makeClient()
    // Not READY yet — the poke is dropped (safe: the CP's pull paths converge).
    client.emitGithubInstallation({ installationId: '1234567', action: 'created' })
    expect(transport.sent).toHaveLength(0)

    await handshakeToReady(client, transport)
    client.emitGithubInstallation({ installationId: '1234567', action: 'created' })
    const poke = transport.lastReq('rc/github-installation')!
    expect(poke.payload).toEqual({ installationId: '1234567', action: 'created' })
  })

  it('emitBotChannels reports the snapshot when READY and signals deferral otherwise', async () => {
    const { client, transport } = makeClient()
    const snapshot = { botId: RELAY_ID, channels: [{ id: 'C1', name: 'deploys' }] }

    expect(client.emitBotChannels(snapshot)).toBe(false)
    expect(transport.sent).toHaveLength(0)

    await handshakeToReady(client, transport)
    expect(client.emitBotChannels(snapshot)).toBe(true)
    expect(transport.lastReq('rc/bot-channels')?.payload).toEqual(snapshot)
  })

  it('emits participant joins without overloading thread-owner reports', async () => {
    const { client, transport } = makeClient()
    const target = {
      botId: RELAY_ID,
      sessionKey: 'C1/ts',
      agentId: RELAY_ID,
      daemonId: DAEMON_ID
    }

    expect(client.emitThreadParticipant(target)).toBe(false)
    await handshakeToReady(client, transport)
    expect(client.emitThreadParticipant(target)).toBe(true)

    expect(transport.lastReq('rc/thread-participant')?.payload).toEqual(target)
    expect(transport.lastReq('rc/thread-assign')).toBeUndefined()
  })

  it('reconnects with backoff on a non-fatal close', async () => {
    const clock = new FakeClock()
    const transports: FakeTransport[] = []
    const connect = vi.fn(async () => {
      const t = new FakeTransport()
      transports.push(t)
      return t
    })
    const client = new RelayCpClient({
      auth: { method: 'token', credential: TOKEN },
      name: 'relay-0',
      daemonUrl: 'wss://relay-0.example',
      heartbeatDefaultMs: 15_000,
      clock,
      connect,
      log: silentLog,
      jitter: () => 0
    })
    client.start()
    await flush()
    expect(connect).toHaveBeenCalledTimes(1)
    // The initial socket dies before/after handshake — non-fatal (1012) → DEGRADED.
    transports[0]!.simulateClose(1012)
    expect(client.state).toBe('DEGRADED')
    // Backoff base = 1000ms (jitter 0). Nothing before, a reconnect after.
    clock.advance(999)
    expect(connect).toHaveBeenCalledTimes(1)
    clock.advance(1)
    await flush()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('treats a 4401 close as fatal and never reconnects', async () => {
    const { client, clock, transport, connect } = makeClient()
    await handshakeToReady(client, transport)
    transport.simulateClose(4401)
    expect(client.state).toBe('CLOSED')
    clock.advance(60_000)
    await flush()
    expect(connect).toHaveBeenCalledTimes(1) // no reconnect
  })

  it('verify() rejects when the link is not READY', async () => {
    const { client } = makeClient()
    await expect(client.verify('daemon-key', 'creds')).rejects.toThrow(/not ready/)
  })

  it('verify() round-trips rc/verify → rc/verify/ok when READY', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)
    const p = client.verify('daemon-key', 'the-daemon-key')
    await flush()
    const req = transport.lastReq('rc/verify')!
    expect(req.payload).toEqual({ kind: 'daemon-key', credential: 'the-daemon-key' })
    transport.inject(
      buildRelayCpFrame('rc/verify/ok', { ok: true, daemonId: DAEMON_ID, orgId: 'org-1' }, { corr: req.id })
    )
    await expect(p).resolves.toMatchObject({ ok: true, daemonId: DAEMON_ID })
  })

  it('marks webchat verification as conversation-binding aware', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)
    const p = client.verify('webchat-token', 'the-browser-token')
    await flush()
    const req = transport.lastReq('rc/verify')!
    expect(req.payload).toEqual({
      kind: 'webchat-token',
      credential: 'the-browser-token',
      conversationBinding: 'v1'
    })
    transport.inject(
      buildRelayCpFrame(
        'rc/verify/ok',
        {
          ok: true,
          agentId: DAEMON_ID,
          daemonId: DAEMON_ID,
          orgId: 'org-1',
          conversationId: DAEMON_ID
        },
        { corr: req.id }
      )
    )
    await expect(p).resolves.toMatchObject({ ok: true, conversationId: DAEMON_ID })
  })

  it('authorizeGithubComment() round-trips one metadata-only request', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)

    const p = client.authorizeGithubComment(COMMENT_AUTHZ)
    await flush()
    const req = transport.lastReq('rc/github-comment-authz')!
    expect(req.payload).toEqual(COMMENT_AUTHZ)
    transport.inject(buildRelayCpFrame('rc/github-comment-authz/ok', { allowed: true }, { corr: req.id }))

    await expect(p).resolves.toBe(true)
    expect(client.state).toBe('READY')
    expect(transport.closed).toBeUndefined()
  })

  it('authorizeGithubComment() treats an old CP error as a single-shot failure and keeps the link READY', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)

    const result = client.authorizeGithubComment(COMMENT_AUTHZ)
    await flush()
    const req = transport.lastReq('rc/github-comment-authz')!
    transport.inject(
      buildRelayCpFrame('error', { code: 'UNKNOWN_FRAME', message: 'unsupported', retryable: false }, { corr: req.id })
    )

    await expect(result).rejects.toMatchObject({ code: 'UNKNOWN_FRAME', retryable: false })
    expect(transport.sent.filter((frame) => frame.type === 'rc/github-comment-authz')).toHaveLength(1)
    expect(client.state).toBe('READY')
    expect(transport.closed).toBeUndefined()
  })

  it('authorizeGithubRerequest() round-trips one metadata-only projection lookup', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)

    const pending = client.authorizeGithubRerequest(REREQUEST)
    await flush()
    const req = transport.lastReq('rc/github-rerequest')!
    expect(req.payload).toEqual(REREQUEST)
    const result = {
      allowed: true as const,
      hookId: COMMENT_AUTHZ.hookId,
      pullNumber: 585,
      configRevision: '3',
      dispatchRevision: '5'
    }
    transport.inject(buildRelayCpFrame('rc/github-rerequest/ok', result, { corr: req.id }))

    await expect(pending).resolves.toEqual(result)
    expect(client.state).toBe('READY')
  })
})
