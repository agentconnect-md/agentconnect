import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayCpFrame,
  RELAY_CP_SUBPROTOCOL,
  GITLAB_COM_V1_FEATURE,
  GITLAB_INSTANCE_V1_FEATURE,
  GITLAB_RERUN_V1_FEATURE,
  PULL_REQUEST_FEEDBACK_FEATURE,
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
const RUN_REPORT = {
  hookId: COMMENT_AUTHZ.hookId,
  deliveryKey: 'delivery-1',
  firedAt: '2026-07-07T00:00:00.000Z',
  agentId: '33333333-3333-4333-8333-333333333333',
  status: 'failed',
  reason: 'review_request_required'
} as const
const REREQUEST = {
  checkRunId: '86617583005',
  repoId: '987654321',
  headSha: 'a'.repeat(40),
  deliveryKey: 'delivery-rerun-1'
} as const
const HOOK_RERUN = {
  hookId: COMMENT_AUTHZ.hookId,
  agentId: '33333333-3333-4333-8333-333333333333',
  deliveryKey: 'rerun_1',
  configRevision: '3',
  dispatchRevision: '5',
  event: 'merge_request:rerun',
  gitlab: {
    projectId: '4455667',
    projectPath: 'example-group/example-project',
    target: { kind: 'merge_request', iid: 42, headSha: 'b'.repeat(40) }
  }
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

/** Answer the auth + register REQs already sitting on `transport`. */
async function completeHandshake(
  transport: FakeTransport,
  heartbeatSec = 15,
  deploymentConfig?: { revision: number; githubWebhookSecret?: string },
  serverFeatures: string[] = []
): Promise<void> {
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
  transport.inject(buildRelayCpFrame('rc/registered', { relayId: RELAY_ID, serverFeatures }, { corr: reg.id }))
  await flush()
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
  await completeHandshake(transport, heartbeatSec, deploymentConfig)
}

/** A client whose every dial hands out a FRESH transport, so a close can be
 *  followed through the reconnect the way a CP restart is. */
function makeReconnectingClient(over: Partial<RelayCpClientDeps> = {}) {
  const clock = new FakeClock()
  const transports: FakeTransport[] = []
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
    ...over
  })
  /** Close the live transport and complete the handshake on the replacement. */
  const reconnect = async (): Promise<FakeTransport> => {
    clock.advance(1_000)
    await flush()
    const next = transports.at(-1)!
    await completeHandshake(next)
    return next
  }
  return { client, clock, transports, reconnect }
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
      features: [
        WEBCHAT_SESSION_CONTINUATION_FEATURE,
        GITLAB_COM_V1_FEATURE,
        GITLAB_RERUN_V1_FEATURE,
        GITLAB_INSTANCE_V1_FEATURE,
        PULL_REQUEST_FEEDBACK_FEATURE
      ]
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

  it('persists PR feedback only after the CP advertises the compatible receiver', async () => {
    const { client, transport } = makeClient()
    client.start()
    await flush()
    await completeHandshake(transport, 15, undefined, [PULL_REQUEST_FEEDBACK_FEATURE])
    const signal = {
      deliveryKey: 'delivery-feedback-1',
      installationId: '1234567',
      repoId: '987654321',
      repoFullName: 'acme/infra',
      pullNumber: 77
    } as const

    const pending = client.reportPullRequestFeedback(signal)
    await flush()
    const request = transport.lastReq('rc/pull-request-feedback')!
    transport.inject(
      buildRelayCpFrame(
        'rc/pull-request-feedback/ok',
        { deliveryKey: signal.deliveryKey, accepted: true },
        { corr: request.id }
      )
    )
    await expect(pending).resolves.toBe(true)

    transport.simulateClose(1012)
    await expect(client.reportPullRequestFeedback(signal)).rejects.toMatchObject({ retryable: true })
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

  it('authorizeGithubComment() rides out a CP restart instead of failing closed', async () => {
    const { client, transports, reconnect } = makeReconnectingClient()
    client.start()
    await flush()
    await completeHandshake(transports[0]!)
    transports[0]!.simulateClose(1012)

    // The delivery is already answered 202: waiting for the link is the difference
    // between a review and a silently skipped one.
    const pending = client.authorizeGithubComment(COMMENT_AUTHZ)
    await flush()
    expect(transports[0]!.sent.filter((f) => f.type === 'rc/github-comment-authz')).toHaveLength(0)

    const next = await reconnect()
    await flush()
    const req = next.lastReq('rc/github-comment-authz')!
    expect(req.payload).toEqual(COMMENT_AUTHZ)
    next.inject(buildRelayCpFrame('rc/github-comment-authz/ok', { allowed: true }, { corr: req.id }))
    await expect(pending).resolves.toBe(true)
  })

  it('authorizeGithubComment() re-issues a request the dying link swallowed, exactly once', async () => {
    const { client, transports, reconnect } = makeReconnectingClient()
    client.start()
    await flush()
    await completeHandshake(transports[0]!)

    const pending = client.authorizeGithubComment(COMMENT_AUTHZ)
    await flush()
    expect(transports[0]!.lastReq('rc/github-comment-authz')).toBeDefined()
    transports[0]!.simulateClose(1012) // in-flight REQ rejects as retryable

    const next = await reconnect()
    await flush()
    const req = next.lastReq('rc/github-comment-authz')!
    next.inject(buildRelayCpFrame('rc/github-comment-authz/ok', { allowed: false }, { corr: req.id }))

    await expect(pending).resolves.toBe(false)
    expect(next.sent.filter((f) => f.type === 'rc/github-comment-authz')).toHaveLength(1)
  })

  it('authorizeGithubComment() does not re-ask over a link that never died', async () => {
    // A retryable answer is not proof the connection dropped: the CP replies
    // retryable for its own GitHub/DB blips, and an ack timeout is retryable
    // too. Re-issuing on that same link would duplicate the upstream lookup.
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)

    const pending = client.authorizeGithubComment(COMMENT_AUTHZ)
    await flush()
    const req = transport.lastReq('rc/github-comment-authz')!
    transport.inject(
      buildRelayCpFrame('error', { code: 'INTERNAL', message: 'github blip', retryable: true }, { corr: req.id })
    )

    await expect(pending).rejects.toMatchObject({ retryable: true })
    expect(transport.sent.filter((f) => f.type === 'rc/github-comment-authz')).toHaveLength(1)
    expect(client.state).toBe('READY')
  })

  it('authorizeGithubComment() gives up when the ack never comes and the link stays up', async () => {
    const { client, clock, transport } = makeClient()
    await handshakeToReady(client, transport)

    const settled = expect(client.authorizeGithubComment(COMMENT_AUTHZ)).rejects.toMatchObject({ retryable: true })
    await flush()
    clock.advance(5_000) // the single-shot ack budget — retryable, but the link never dropped
    await flush()

    await settled
    expect(transport.sent.filter((f) => f.type === 'rc/github-comment-authz')).toHaveLength(1)
  })

  it('authorizeGithubComment() still fails closed when the link stays down', async () => {
    const { client, clock, transports } = makeReconnectingClient()
    client.start()
    await flush()
    await completeHandshake(transports[0]!)
    transports[0]!.simulateClose(1012)

    const settled = expect(client.authorizeGithubComment(COMMENT_AUTHZ)).rejects.toMatchObject({ retryable: true })
    clock.advance(30_000) // the wait window, with no CP answering the reconnect
    await flush()

    await settled
    for (const transport of transports) {
      expect(transport.sent.filter((f) => f.type === 'rc/github-comment-authz')).toHaveLength(0)
    }
  })

  it('replays run reports queued while the link was down, oldest first', async () => {
    const { client, transports, reconnect } = makeReconnectingClient()
    client.start()
    await flush()
    await completeHandshake(transports[0]!)
    transports[0]!.simulateClose(1012)

    // A delivery refused pre-dispatch never reaches a daemon, so this row is the
    // only trace it ever gets — dropping it shows the console nothing at all.
    client.emitRunReport({ ...RUN_REPORT, deliveryKey: 'delivery-1' })
    client.emitRunReport({ ...RUN_REPORT, deliveryKey: 'delivery-2' })

    const next = await reconnect()
    const replayed = next.sent.filter((f) => f.type === 'rc/run-report')
    expect(replayed.map((f) => (f.payload as { deliveryKey: string }).deliveryKey)).toEqual([
      'delivery-1',
      'delivery-2'
    ])
    expect((replayed[0]!.payload as { firedAt: string }).firedAt).toBe(RUN_REPORT.firedAt)
  })

  it('bounds the queued run reports, dropping the oldest', async () => {
    const { client, transports, reconnect } = makeReconnectingClient()
    client.start()
    await flush()
    await completeHandshake(transports[0]!)
    transports[0]!.simulateClose(1012)

    for (let i = 0; i < 205; i++) client.emitRunReport({ ...RUN_REPORT, deliveryKey: `delivery-${i}` })

    const next = await reconnect()
    const replayed = next.sent.filter((f) => f.type === 'rc/run-report')
    expect(replayed).toHaveLength(200)
    expect((replayed[0]!.payload as { deliveryKey: string }).deliveryKey).toBe('delivery-5')
  })
})

describe('RelayCpClient — rc/hook-rerun admission REP (§16.1)', () => {
  it('answers the handler verdict on the correlated reply', async () => {
    const onHookRerun = vi.fn(() => ({ admitted: true as const, deliveryKey: 'rerun_1' }))
    const { client, transport } = makeClient({ onHookRerun })
    await handshakeToReady(client, transport)

    const req = buildRelayCpFrame('rc/hook-rerun', HOOK_RERUN)
    transport.inject(req)
    await flush()

    expect(onHookRerun).toHaveBeenCalledWith(HOOK_RERUN)
    const rep = transport.lastReq('rc/hook-rerun/ok')!
    expect(rep.corr).toBe(req.id)
    expect(rep.payload).toEqual({ admitted: true, deliveryKey: 'rerun_1' })
  })

  it('carries a definitive refusal back rather than staying silent', async () => {
    const onHookRerun = vi.fn(() => ({ admitted: false as const, code: 'replay_pending' as const }))
    const { client, transport } = makeClient({ onHookRerun })
    await handshakeToReady(client, transport)
    transport.inject(buildRelayCpFrame('rc/hook-rerun', HOOK_RERUN))
    await flush()
    expect(transport.lastReq('rc/hook-rerun/ok')!.payload).toEqual({ admitted: false, code: 'replay_pending' })
  })

  it('errors rather than silently dropping the frame when nothing serves reruns', async () => {
    const { client, transport } = makeClient()
    await handshakeToReady(client, transport)
    const req = buildRelayCpFrame('rc/hook-rerun', HOOK_RERUN)
    transport.inject(req)
    await flush()
    expect(transport.lastReq('rc/hook-rerun/ok')).toBeUndefined()
    const err = transport.lastReq('error')!
    expect(err.corr).toBe(req.id)
    // The CP treats an error REP as ambiguous and stops, never as an admission.
    expect((err.payload as { code: string }).code).toBe('PROTOCOL_STATE')
  })
})
