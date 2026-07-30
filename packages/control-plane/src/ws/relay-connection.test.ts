import { describe, it, expect, vi } from 'vitest'
import {
  buildRelayCpFrame,
  DELEGATED_MCP_ASSERTION_FEATURE,
  RELAY_CP_SUBPROTOCOL,
  type RelayCpFrame,
  type RelayCpFrameType,
  type RcGithubCommentAuthz,
  type RcGithubRerequest,
  type RcGithubRerequestResult,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import { RelayConnection } from './relay-connection.js'
import { RelayRegistry } from './relay-registry.js'
import type { Transport } from './transport.js'
import { RelayAuthService } from '../registry/relayAuthService.js'
import { ApiKeyCodec } from '../registry/apiKey.js'
import type { ApiKeyRepo, RelayRepo, RelayRecord } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import type { WebchatTokenClaims } from '../registry/webchatToken.js'
import { createWebchatTokenVerifier, type WebchatVerificationDeps } from '../registry/webchatVerification.js'

const NOW = 1_700_000_000_000
const clock = { now: () => NOW } as unknown as Clock
const RELAY_TOKEN = 'r'.repeat(48)
const RELAY_ID = '11111111-1111-4111-8111-111111111111'
const WEBCHAT_AGENT_ID = '33333333-3333-4333-8333-333333333333'
const WEBCHAT_DAEMON_ID = '44444444-4444-4444-8444-444444444444'
const WEBCHAT_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555'
const WEBCHAT_DELEGATION_ID = '66666666-6666-4666-8666-666666666666'
const GITHUB_COMMENT_AUTHZ_REQUEST = {
  hookId: '88888888-8888-4888-8888-888888888888',
  installationId: '123',
  repoId: '456',
  repoFullName: 'acme/infra',
  senderLogin: 'octocat',
  configRevision: '7',
  dispatchRevision: '9'
} satisfies RcGithubCommentAuthz
const GITHUB_REREQUEST = {
  checkRunId: '86617583005',
  repoId: '456',
  headSha: 'a'.repeat(40),
  deliveryKey: 'delivery-rerun-1'
} satisfies RcGithubRerequest

/** In-memory server transport — captures replies, feeds inbound frames. */
class FakeServerTransport implements Transport {
  readonly subprotocol = RELAY_CP_SUBPROTOCOL
  readonly remoteAddr = 'test'
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

  feed(type: RelayCpFrameType, payload: unknown): void {
    this.msgCb?.(JSON.stringify(buildRelayCpFrame(type, payload as never)))
  }
  feedFrame(frame: RelayCpFrame): void {
    this.msgCb?.(JSON.stringify(frame))
  }
  /** Simulate the peer/socket closing (fires the FSM's onClose). */
  simulateClose(code: number): void {
    this.closeCb?.(code, 'peer')
  }
  lastRep(type: string): RelayCpFrame | undefined {
    return [...this.sent].reverse().find((f) => f.type === type)
  }
}

function build(
  over: {
    upsertByName?: RelayRepo['upsertByName']
    touchLastSeen?: RelayRepo['touchLastSeen']
    auth?: Pick<RelayAuthService, 'authenticate' | 'verifyDaemonKey' | 'heartbeatSec'>
    verifyWebchatToken?: (token: string) => Promise<RcVerifyResult>
    authorizeGithubComment?: (req: RcGithubCommentAuthz) => Promise<boolean>
    authorizeGithubRerequest?: (req: RcGithubRerequest) => Promise<RcGithubRerequestResult>
  } = {}
) {
  const codec = new ApiKeyCodec({ API_KEY_PEPPER: 'unit-test-pepper-0123456789abcdefghij' })
  const apiKeys = { findByHash: vi.fn(async () => null), touchLastUsed: vi.fn(async () => {}) } as unknown as ApiKeyRepo
  const auth = (over.auth ??
    new RelayAuthService(codec, apiKeys, clock, { RELAY_TOKEN, HEARTBEAT_SEC: 15 })) as RelayAuthService

  const upsertByName = vi.fn(async (name: string, daemonUrl: string): Promise<RelayRecord> => ({
    id: RELAY_ID,
    name,
    daemonUrl,
    lastSeenAt: new Date(NOW),
    createdAt: new Date(NOW)
  }))
  const relays = {
    upsertByName: over.upsertByName ?? upsertByName,
    touchLastSeen: over.touchLastSeen ?? vi.fn(async () => true)
  } as unknown as RelayRepo
  const onRegistered = vi.fn()
  const onRunReport = vi.fn(async () => {})
  const onBotChannels = vi.fn(async () => {})
  const onBotRevoked = vi.fn(async () => {})
  const relayReg = new RelayRegistry()

  const transport = new FakeServerTransport()
  const verifyWebchatToken =
    over.verifyWebchatToken ?? vi.fn(async () => ({ ok: false, reason: 'not tested' }) as RcVerifyResult)
  const authorizeGithubComment = over.authorizeGithubComment ?? vi.fn(async () => false)
  const authorizeGithubRerequest = over.authorizeGithubRerequest ?? vi.fn(async () => ({ allowed: false as const }))
  const conn = new RelayConnection(transport, {
    auth,
    relays,
    clock,
    onRegistered,
    onRunReport,
    onSetChannelAgent: vi.fn(async () => {}),
    onBotChannels,
    onBotRevoked,
    onThreadAssign: vi.fn(async () => {}),
    threadLookup: vi.fn(async (m) => ({ ...m, target: null })),
    onGithubInstallation: vi.fn(async () => {}),
    relayReg,
    verifyWebchatToken,
    authorizeGithubComment,
    authorizeGithubRerequest
  })
  conn.start()
  return {
    conn,
    transport,
    upsertByName: relays.upsertByName,
    touchLastSeen: relays.touchLastSeen,
    onRegistered,
    onRunReport,
    onBotChannels,
    onBotRevoked,
    authorizeGithubComment,
    authorizeGithubRerequest,
    relayReg
  }
}

/** Drive a conn to READY (auth + register), settling microtasks between frames. */
async function toReady(transport: FakeServerTransport): Promise<void> {
  transport.feed('rc/auth', { method: 'token', credential: RELAY_TOKEN })
  await Promise.resolve()
  transport.feed('rc/register', { name: 'pod-0', daemonUrl: 'wss://pod-0.example.test' })
  await Promise.resolve()
}

function buildWebchatVerifier(
  over: {
    enabled?: boolean
    tokenClaims?: WebchatTokenClaims | null
    daemonId?: string | null
    daemonState?: string
    daemonFeatures?: string[]
    establish?: WebchatVerificationDeps['delegations']['establish']
  } = {}
) {
  const verify = vi.fn(async () =>
    over.tokenClaims === undefined
      ? {
          userId: 'user-1',
          user: 'user@example.test',
          agentId: WEBCHAT_AGENT_ID,
          orgId: 'org-1',
          conversationId: WEBCHAT_CONVERSATION_ID
        }
      : over.tokenClaims
  )
  const getAgent = vi.fn(async () => ({
    orgId: 'org-1',
    daemonId: over.daemonId === undefined ? WEBCHAT_DAEMON_ID : over.daemonId
  }))
  const getDaemon = vi.fn(() => ({
    state: over.daemonState ?? 'READY',
    capabilities: {
      platforms: [],
      runtimes: [],
      acp: true,
      features: over.daemonFeatures ?? [DELEGATED_MCP_ASSERTION_FEATURE]
    }
  }))
  const establish =
    over.establish ??
    vi.fn(async () => ({
      id: WEBCHAT_DELEGATION_ID,
      generation: 1,
      expiresAt: '2030-01-01T00:00:00.000Z'
    }))
  return {
    verify,
    getAgent,
    getDaemon,
    establish,
    verifier: createWebchatTokenVerifier({
      enabled: over.enabled ?? true,
      tokens: { verify },
      agents: { get: getAgent },
      daemons: { get: getDaemon },
      delegations: { establish }
    })
  }
}

describe('webchat verification delegation gate', () => {
  it('adds only the opaque delegation reference after ordinary verification and both rollout gates pass', async () => {
    const h = buildWebchatVerifier()

    const result = await h.verifier('browser-credential')

    expect(result).toMatchObject({
      ok: true,
      agentId: WEBCHAT_AGENT_ID,
      daemonId: WEBCHAT_DAEMON_ID,
      conversationId: WEBCHAT_CONVERSATION_ID,
      delegation: { id: WEBCHAT_DELEGATION_ID, generation: 1 }
    })
    expect(h.establish).toHaveBeenCalledWith({
      conversationId: WEBCHAT_CONVERSATION_ID,
      verifiedUserId: 'user-1',
      orgId: 'org-1',
      agentId: WEBCHAT_AGENT_ID,
      daemonId: WEBCHAT_DAEMON_ID
    })
    expect(result).not.toHaveProperty('assertion')
    expect(JSON.stringify(result)).not.toContain('browser-credential')
  })

  it.each([
    { enabled: false, features: [DELEGATED_MCP_ASSERTION_FEATURE], label: 'server gate is off' },
    { enabled: true, features: [], label: 'daemon capability is absent' }
  ])('returns ordinary webchat without establishment when $label', async ({ enabled, features }) => {
    const h = buildWebchatVerifier({ enabled, daemonFeatures: features })

    const result = await h.verifier('browser-credential')

    expect(result).toMatchObject({ ok: true, agentId: WEBCHAT_AGENT_ID, daemonId: WEBCHAT_DAEMON_ID })
    expect(result.delegation).toBeUndefined()
    expect(h.establish).not.toHaveBeenCalled()
  })

  it.each([
    { establish: vi.fn(async () => null), label: 'entitlement is denied' },
    {
      establish: vi.fn(async () => {
        throw new Error('delegation store unavailable')
      }),
      label: 'delegation establishment fails'
    }
  ])('preserves ordinary webchat when $label', async ({ establish }) => {
    const h = buildWebchatVerifier({ establish })

    const result = await h.verifier('browser-credential')

    expect(result).toMatchObject({ ok: true, agentId: WEBCHAT_AGENT_ID, daemonId: WEBCHAT_DAEMON_ID })
    expect(result.delegation).toBeUndefined()
  })

  it('does not attempt delegation before ordinary token and placement checks succeed', async () => {
    const invalid = buildWebchatVerifier({ tokenClaims: null })
    expect(await invalid.verifier('bad-token')).toEqual({ ok: false, reason: 'invalid token' })
    expect(invalid.getAgent).not.toHaveBeenCalled()
    expect(invalid.establish).not.toHaveBeenCalled()

    const unplaced = buildWebchatVerifier({ daemonId: null })
    expect(await unplaced.verifier('valid-token')).toEqual({ ok: false, reason: 'agent unplaced' })
    expect(unplaced.getDaemon).not.toHaveBeenCalled()
    expect(unplaced.establish).not.toHaveBeenCalled()

    const offline = buildWebchatVerifier({ daemonState: 'CLOSED' })
    expect(await offline.verifier('valid-token')).toEqual({ ok: false, reason: 'daemon offline' })
    expect(offline.establish).not.toHaveBeenCalled()
  })
})

describe('RelayConnection FSM', () => {
  it('runs rc/auth → rc/register → READY and upserts the relay row', async () => {
    const { conn, transport, upsertByName, onRegistered } = build()

    transport.feed('rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await Promise.resolve()
    const authOk = transport.lastRep('rc/auth/ok')!
    expect(authOk.payload).toMatchObject({ heartbeatSec: 15 })

    transport.feed('rc/register', { name: 'pod-0', daemonUrl: 'wss://pod-0.example.test' })
    await Promise.resolve()
    expect(upsertByName).toHaveBeenCalledWith('pod-0', 'wss://pod-0.example.test', new Date(NOW))
    expect(transport.lastRep('rc/registered')!.payload).toEqual({ relayId: RELAY_ID })
    expect(conn.state).toBe('READY')
    expect(conn.relayId).toBe(RELAY_ID)
    expect(onRegistered).toHaveBeenCalledOnce()
  })

  it('bumps lastSeen on rc/heartbeat once READY', async () => {
    const { conn, transport, touchLastSeen } = build()
    await toReady(transport)
    transport.feed('rc/heartbeat', {})
    await Promise.resolve()
    expect(touchLastSeen).toHaveBeenCalledWith(RELAY_ID, new Date(NOW))
    expect(conn.state).toBe('READY')
  })

  it('forces a reconnect (close 1012) when a heartbeat finds the row already swept', async () => {
    // The sweeper deleted the row during a stall; touchLastSeen reports it gone.
    const { transport } = build({ touchLastSeen: vi.fn(async () => false) })
    await toReady(transport)
    transport.feed('rc/heartbeat', {})
    await Promise.resolve()
    expect(transport.closed).toEqual({ code: 1012, reason: 'relay row swept — reconnect to re-register' })
  })

  it('keeps the link UP when a heartbeat touchLastSeen throws (transient store blip)', async () => {
    // A store blip on the liveness bump must NOT tear down the shared relay↔CP link (the
    // outer dispatch closes 1011 on a throw) — every daemon/browser this relay serves would
    // drop. The bump is skipped; the next heartbeat retries.
    const { conn, transport } = build({
      touchLastSeen: vi.fn(async () => {
        throw new Error('db down')
      })
    })
    await toReady(transport)
    transport.feed('rc/heartbeat', {})
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.closed).toBeUndefined() // link stays up
    expect(conn.state).toBe('READY')
  })

  it('closes 1011 (not an unhandled rejection) when the register upsert throws', async () => {
    const { transport } = build({
      upsertByName: vi.fn(async () => {
        throw new Error('db down')
      })
    })
    transport.feed('rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await Promise.resolve()
    transport.feed('rc/register', { name: 'pod-0', daemonUrl: 'wss://pod-0.example.test' })
    await Promise.resolve()
    await Promise.resolve() // let the rejected handler settle into the catch
    expect(transport.closed).toEqual({ code: 1011, reason: 'SERVER_INTERNAL' })
  })

  it('rejects a bad credential with AUTH_FAILED + close(4401)', async () => {
    const { transport } = build()
    transport.feed('rc/auth', { method: 'token', credential: 'x'.repeat(48) })
    await Promise.resolve()
    const err = transport.lastRep('error')!
    expect(err.payload).toMatchObject({ code: 'AUTH_FAILED' })
    expect(transport.closed).toEqual({ code: 4401, reason: 'auth failed' })
  })

  it('gates frames by state — rc/register before auth is PROTOCOL_STATE', async () => {
    const { transport } = build()
    transport.feed('rc/register', { name: 'pod-0', daemonUrl: 'wss://pod-0.example.test' })
    await Promise.resolve()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'PROTOCOL_STATE' })
  })

  it('registers in the RelayRegistry on register and removes on close', async () => {
    const { conn, transport, relayReg } = build()
    await toReady(transport)
    expect(relayReg.get(RELAY_ID)).toBe(conn)
    transport.simulateClose(1006)
    expect(relayReg.get(RELAY_ID)).toBeUndefined()
  })

  it('does NOT register in relayReg if the socket closes during the upsert', async () => {
    let resolveUpsert!: (r: RelayRecord) => void
    const { transport, relayReg } = build({
      upsertByName: vi.fn(() => new Promise<RelayRecord>((res) => (resolveUpsert = res)))
    })
    transport.feed('rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await Promise.resolve()
    transport.feed('rc/register', { name: 'pod-0', daemonUrl: 'wss://pod-0.example.test' })
    await Promise.resolve()
    transport.simulateClose(1006) // dies mid-upsert
    resolveUpsert({
      id: RELAY_ID,
      name: 'pod-0',
      daemonUrl: 'wss://pod-0.example.test',
      lastSeenAt: new Date(NOW),
      createdAt: new Date(NOW)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(relayReg.get(RELAY_ID)).toBeUndefined() // never registered a dead socket
  })

  it('supersedes a stale same-relayId connection on register', async () => {
    const relayReg = new (await import('./relay-registry.js')).RelayRegistry()
    const prev = { relayId: RELAY_ID, send: vi.fn(), close: vi.fn() }
    relayReg.add(prev)
    // A fresh connection reclaims the same relayId (restarted pod).
    const codec = new ApiKeyCodec({ API_KEY_PEPPER: 'unit-test-pepper-0123456789abcdefghij' })
    const apiKeys = {
      findByHash: vi.fn(async () => null),
      touchLastUsed: vi.fn(async () => {})
    } as unknown as ApiKeyRepo
    const auth = new RelayAuthService(codec, apiKeys, clock, { RELAY_TOKEN, HEARTBEAT_SEC: 15 })
    const relays = {
      upsertByName: vi.fn(async (name: string, daemonUrl: string): Promise<RelayRecord> => ({
        id: RELAY_ID,
        name,
        daemonUrl,
        lastSeenAt: new Date(NOW),
        createdAt: new Date(NOW)
      })),
      touchLastSeen: vi.fn(async () => true)
    } as unknown as RelayRepo
    const transport = new FakeServerTransport()
    const verifyWebchatToken = vi.fn(async () => ({ ok: false, reason: 'not tested' }) as RcVerifyResult)
    const conn = new RelayConnection(transport, {
      auth,
      relays,
      clock,
      onRegistered: vi.fn(),
      onRunReport: vi.fn(async () => {}),
      onSetChannelAgent: vi.fn(async () => {}),
      onBotChannels: vi.fn(async () => {}),
      onThreadAssign: vi.fn(async () => {}),
      threadLookup: vi.fn(async (m) => ({ ...m, target: null })),
      onGithubInstallation: vi.fn(async () => {}),
      relayReg,
      verifyWebchatToken,
      authorizeGithubComment: vi.fn(async () => false),
      authorizeGithubRerequest: vi.fn(async () => ({ allowed: false }))
    })
    conn.start()
    await toReady(transport)
    expect(prev.close).toHaveBeenCalledWith(1012, 'superseded by a newer relay connection')
    expect(relayReg.get(RELAY_ID)).toBe(conn)
  })

  it('rc/run-report in READY reaches onRunReport; a store blip never closes the link', async () => {
    const { transport, onRunReport } = build()
    await toReady(transport)
    const report = {
      hookId: '88888888-8888-4888-8888-888888888888',
      deliveryKey: 'dk-1',
      firedAt: new Date(NOW).toISOString(),
      agentId: '33333333-3333-4333-8333-333333333333',
      status: 'accepted' as const
    }
    transport.feed('rc/run-report', report)
    await Promise.resolve()
    expect(onRunReport).toHaveBeenCalledWith(expect.objectContaining({ deliveryKey: 'dk-1', status: 'accepted' }))

    // A throwing handler is swallowed (fire-and-forget bookkeeping) — the shared
    // relay↔CP link stays open, unlike other handlers' 1011-on-throw.
    onRunReport.mockRejectedValueOnce(new Error('db down'))
    transport.feed('rc/run-report', { ...report, deliveryKey: 'dk-2' })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.closed).toBeUndefined()
  })

  it('rc/bot-channels in READY reaches the HTTP Slack snapshot handler', async () => {
    const { transport, onBotChannels } = build()
    await toReady(transport)
    const snapshot = {
      botId: '22222222-2222-4222-8222-222222222222',
      channels: [
        { id: 'C1', name: 'deploys' },
        { id: 'C2', name: 'ops', isPrivate: true }
      ]
    }

    transport.feed('rc/bot-channels', snapshot)
    await Promise.resolve()

    expect(onBotChannels).toHaveBeenCalledWith(snapshot)
  })

  it('rc/bot-revoked in READY reaches the revocation handler', async () => {
    const { transport, onBotRevoked } = build()
    await toReady(transport)
    const revoked = { botId: '22222222-2222-4222-8222-222222222222', reason: 'app_uninstalled' as const }

    transport.feed('rc/bot-revoked', revoked)
    await Promise.resolve()

    expect(onBotRevoked).toHaveBeenCalledWith(revoked)
  })

  it('rc/run-report before READY is a PROTOCOL_STATE error', async () => {
    const { transport, onRunReport } = build()
    transport.feed('rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await Promise.resolve()
    transport.feed('rc/run-report', {
      hookId: '88888888-8888-4888-8888-888888888888',
      deliveryKey: 'dk-1',
      firedAt: new Date(NOW).toISOString(),
      agentId: '33333333-3333-4333-8333-333333333333',
      status: 'failed',
      reason: 'daemon_offline'
    })
    await Promise.resolve()
    expect(onRunReport).not.toHaveBeenCalled()
    const err = transport.lastRep('error')
    expect(err?.payload).toMatchObject({ code: 'PROTOCOL_STATE' })
  })

  it('rc/verify(daemon-key) → rc/verify/ok{ok:true} for a valid key', async () => {
    const { transport } = build({
      auth: {
        authenticate: async () => ({ ok: true, identity: 'shared-token' }),
        verifyDaemonKey: async () => ({ daemonId: 'daemon-1', orgId: 'org-1' }),
        heartbeatSec: 15
      }
    })
    await toReady(transport)
    transport.feed('rc/verify', { kind: 'daemon-key', credential: 'the-key' })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('rc/verify/ok')!.payload).toEqual({ ok: true, daemonId: 'daemon-1', orgId: 'org-1' })
  })

  it('rc/verify(daemon-key) → rc/verify/ok{ok:false} for an invalid key', async () => {
    const { transport } = build({
      auth: {
        authenticate: async () => ({ ok: true, identity: 'shared-token' }),
        verifyDaemonKey: async () => null,
        heartbeatSec: 15
      }
    })
    await toReady(transport)
    transport.feed('rc/verify', { kind: 'daemon-key', credential: 'bad' })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('rc/verify/ok')!.payload).toMatchObject({ ok: false })
  })

  it('rc/verify(webchat-token) rejects a relay without the conversation-binding fence', async () => {
    const verifyWebchatToken = vi.fn(async () => ({
      ok: true,
      agentId: '33333333-3333-4333-8333-333333333333',
      daemonId: '44444444-4444-4444-8444-444444444444',
      conversationId: '55555555-5555-4555-8555-555555555555'
    }))
    const { transport } = build({ verifyWebchatToken })
    await toReady(transport)

    transport.feed('rc/verify', { kind: 'webchat-token', credential: 'browser-token' })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('rc/verify/ok')!.payload).toMatchObject({
      ok: false,
      reason: 'unsupported webchat binding'
    })
    expect(verifyWebchatToken).not.toHaveBeenCalled()
    expect(transport.closed).toBeUndefined()

    transport.feed('rc/verify', {
      kind: 'webchat-token',
      credential: 'browser-token',
      conversationBinding: 'v1'
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(verifyWebchatToken).toHaveBeenCalledWith('browser-token')
    expect(transport.lastRep('rc/verify/ok')!.payload).toMatchObject({ ok: true })
  })

  it('rc/verify → retryable error (not a link close) when verify throws', async () => {
    const { transport } = build({
      auth: {
        authenticate: async () => ({ ok: true, identity: 'shared-token' }),
        verifyDaemonKey: async () => {
          throw new Error('db down')
        },
        heartbeatSec: 15
      }
    })
    await toReady(transport)
    transport.feed('rc/verify', { kind: 'daemon-key', credential: 'x' })
    await Promise.resolve()
    await Promise.resolve()
    expect(transport.lastRep('error')!.payload).toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(transport.closed).toBeUndefined() // link stays up
  })

  it('rc/github-comment-authz → correlated allow verdict in READY', async () => {
    const authorizeGithubComment = vi.fn(async () => true)
    const { transport } = build({ authorizeGithubComment })
    await toReady(transport)

    const req = buildRelayCpFrame('rc/github-comment-authz', GITHUB_COMMENT_AUTHZ_REQUEST)
    transport.feedFrame(req)
    await Promise.resolve()
    await Promise.resolve()

    expect(authorizeGithubComment).toHaveBeenCalledWith(req.payload)
    const rep = transport.lastRep('rc/github-comment-authz/ok')!
    expect(rep.corr).toBe(req.id)
    expect(rep.payload).toEqual({ allowed: true })
  })

  it('rc/github-comment-authz reports a retryable failure and keeps the shared relay link usable', async () => {
    const authorizeGithubComment = vi
      .fn<(req: RcGithubCommentAuthz) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('github unavailable'))
    const { conn, transport } = build({ authorizeGithubComment })
    await toReady(transport)
    const failedReq = buildRelayCpFrame('rc/github-comment-authz', GITHUB_COMMENT_AUTHZ_REQUEST)
    transport.feedFrame(failedReq)
    await Promise.resolve()
    await Promise.resolve()

    const error = transport.lastRep('error')!
    expect(error.corr).toBe(failedReq.id)
    expect(error.payload).toMatchObject({ code: 'INTERNAL', retryable: true })
    expect(transport.lastRep('rc/github-comment-authz/ok')).toBeUndefined()
    expect(transport.closed).toBeUndefined()
    expect(conn.state).toBe('READY')
  })

  it('rc/github-rerequest returns the CP-resolved metadata as a correlated reply', async () => {
    const result: RcGithubRerequestResult = {
      allowed: true,
      hookId: GITHUB_COMMENT_AUTHZ_REQUEST.hookId,
      pullNumber: 585,
      baseSha: 'b'.repeat(40),
      configRevision: '7',
      dispatchRevision: '9'
    }
    const authorizeGithubRerequest = vi.fn(async () => result)
    const { transport } = build({ authorizeGithubRerequest })
    await toReady(transport)

    const req = buildRelayCpFrame('rc/github-rerequest', GITHUB_REREQUEST)
    transport.feedFrame(req)
    await Promise.resolve()
    await Promise.resolve()

    expect(authorizeGithubRerequest).toHaveBeenCalledWith(req.payload)
    const rep = transport.lastRep('rc/github-rerequest/ok')!
    expect(rep.corr).toBe(req.id)
    expect(rep.payload).toEqual(result)
  })

  it('rc/github-rerequest reports a retryable failure without closing the relay link', async () => {
    const authorizeGithubRerequest = vi
      .fn<(req: RcGithubRerequest) => Promise<RcGithubRerequestResult>>()
      .mockRejectedValueOnce(new Error('db unavailable'))
    const { conn, transport } = build({ authorizeGithubRerequest })
    await toReady(transport)

    const req = buildRelayCpFrame('rc/github-rerequest', GITHUB_REREQUEST)
    transport.feedFrame(req)
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.lastRep('error')).toMatchObject({ corr: req.id, payload: { code: 'INTERNAL', retryable: true } })
    expect(transport.lastRep('rc/github-rerequest/ok')).toBeUndefined()
    expect(conn.state).toBe('READY')
  })
})
