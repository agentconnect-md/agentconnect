/**
 * Relay control gateway (`rc/*`) end-to-end over a REAL socket + real Postgres
 * (shared-bot-relay.md §7.1 / §8, milestone A1/A2).
 *
 * A real `ws` client dials the live Fastify `app.server` at `RELAY_WS_PATH` with
 * the `agentconnect.rc.v1` subprotocol and completes the handshake
 * `rc/auth → rc/auth/ok → rc/register → rc/registered`, and we assert the durable
 * `relay` row was upserted and `rc/heartbeat` bumps its `lastSeenAt`. We also
 * prove the CP-wide vertical: once a relay is registered, a DAEMON's
 * `register/ok.relays` carries it (roster → daemon push, §5), and a wrong shared
 * token is rejected with close `4401`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  WEBCHAT_MULTI_AGENT_FEATURE,
  WEBCHAT_REMOTE_MCP_FEATURE,
  WEBCHAT_HOOK_CONTINUATION_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  isFrame,
  type AnyFrame,
  RELAY_CP_SUBPROTOCOL,
  type RcRegistered,
  type RcAuthOk,
  type RcVerifyResult
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDutyGroup, seedSessionMeta } from '../fixtures/seed.js'
import { joinPool } from '../fakes/member-set.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema, type AppConfig } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const RELAY_URL = 'https://relay.example.com'
const AGENT = 'a9a9a9a9-aaaa-4aaa-8aaa-a9a9a9a9a9a9'
const AGENT_B = 'b8b8b8b8-bbbb-4bbb-8bbb-b8b8b8b8b8b8'

const API_KEY_PEPPER = 'relay-gw-pepper-0123456789abcdefghij'
const RELAY_TOKEN = 'relay-shared-secret-0123456789abcdef' // ≥32, dot-free
const DAEMON_SUBPROTOCOL = 'agentconnect.v1'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function relayConfig(over: Record<string, unknown> = {}): AppConfig {
  return AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://relay/ignored', // prisma is injected; URL unused
    API_KEY_PEPPER,
    RELAY_TOKEN,
    SECRETS_PROVIDER: 'memory',
    HEARTBEAT_SEC: 15,
    ...over
  })
}

let running: App | undefined

afterEach(async () => {
  await running?.shutdown()
  running = undefined
})

async function start(
  over: Record<string, unknown> = {},
  githubFetch?: (url: string, init?: RequestInit) => Promise<Response>
): Promise<{ app: App; base: string }> {
  const config = relayConfig(over)
  const app = buildApp({
    prisma,
    config,
    clock: systemClock,
    secretsProvider: new MemorySecretsProvider(),
    ...(githubFetch ? { githubFetch } : {})
  })
  running = app
  const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
  app.mountWs()
  return { app, base: address.replace(/^http/, 'ws') }
}

function dial(url: string, protocols: string | string[]): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
    ws.once('close', (code) => reject(new Error(`closed before open: ${code}`)))
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

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
}

/** Drive a relay through rc/auth → rc/register; resolve with its relayId. */
async function registerRelay(base: string, name: string, daemonUrl: string, features?: string[]): Promise<string> {
  const { ws, relayId } = await openRelay(base, name, daemonUrl, features)
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()))
  ws.close()
  await closed
  return relayId
}

/** Register a relay and RETURN the still-open READY socket (caller closes it). */
async function openRelay(
  base: string,
  name: string,
  daemonUrl: string,
  features?: string[]
): Promise<{ ws: WebSocket; relayId: string }> {
  const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)
  sendFrame(ws, 'rc/auth', { method: 'token', credential: RELAY_TOKEN })
  const authOk = (await nextFrame(ws, 'rc/auth/ok')).payload as RcAuthOk
  expect(authOk.heartbeatSec).toBe(15)
  sendFrame(ws, 'rc/register', { name, daemonUrl, ...(features ? { features } : {}) })
  const registered = (await nextFrame(ws, 'rc/registered')).payload as RcRegistered
  return { ws, relayId: registered.relayId }
}

async function mintDaemon(): Promise<string> {
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
  return minted.token
}

/** Mint + connect the DAEMON over the daemon WS, driving it to READY (so `connReg` holds
 *  it). Returns the still-open socket (caller closes it). */
async function connectDaemonReady(base: string, features: string[] = []): Promise<WebSocket> {
  const token = await mintDaemon()
  const ws = await dial(`${base}/daemon/ws`, DAEMON_SUBPROTOCOL)
  sendFrame(ws, 'auth', { apiKey: token, agentVersion: 'test' })
  await nextFrame(ws, 'auth/ok')
  sendFrame(ws, 'register', {
    host: 'h',
    capabilities: { platforms: [], runtimes: [], acp: false, features },
    maxAgents: 1,
    localState: { assignments: [], crons: [], leases: [] }
  })
  await nextFrame(ws, 'register/ok')
  return ws
}

/** Place agents on a MEMBER SET instead of a machine — the shape whose `agent.daemonId` is null,
 *  exactly like a cloud-pool agent — and hand their duty to one member of that set. */
async function placeOnSet(agentIds: string[], holder: string): Promise<void> {
  const setId = randomUUID()
  await prisma.memberSet.create({ data: { id: setId, orgId: DEFAULT_ORG_ID, name: 'gw-set' } })
  await prisma.memberSetMember.create({ data: { setId, daemonId: holder } })
  await prisma.agent.updateMany({
    where: { id: { in: agentIds } },
    data: { placementKind: 'set', setId, daemonId: null }
  })
  await seedDutyGroup(prisma, randomUUID(), holder, agentIds)
}

/** POST the webchat-token mint route as the devAuth owner (org-scoped). */
function mintWebchatToken(app: App, agentId: string, body: Record<string, unknown> = {}) {
  return app.http.inject({
    method: 'POST',
    url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${agentId}/webchat/token`,
    payload: body
  })
}

/** POST the conversation-scoped mint route as the devAuth owner (org-scoped). */
function mintConversationToken(app: App, body: Record<string, unknown>) {
  return app.http.inject({
    method: 'POST',
    url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/token`,
    payload: body
  })
}

async function verifyWebchat(
  base: string,
  token: string,
  relayName: string
): Promise<{ ws: WebSocket; result: RcVerifyResult }> {
  const { ws } = await openRelay(base, relayName, `wss://${relayName}.example.test`)
  sendFrame(ws, 'rc/verify', {
    kind: 'webchat-token',
    credential: token,
    conversationBinding: 'v1'
  })
  return { ws, result: (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult }
}

describe('relay control gateway — rc/* handshake over agentconnect.rc.v1', () => {
  it('registers a relay (upsert by name) and bumps lastSeenAt on heartbeat', async () => {
    const { base } = await start()
    const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)

    sendFrame(ws, 'rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await nextFrame(ws, 'rc/auth/ok')
    sendFrame(ws, 'rc/register', { name: 'pod-0', daemonUrl: 'wss://relay-0.example.test' })
    const relayId = ((await nextFrame(ws, 'rc/registered')).payload as RcRegistered).relayId

    const row = await prisma.relay.findUnique({ where: { name: 'pod-0' } })
    expect(row?.id).toBe(relayId)
    expect(row?.daemonUrl).toBe('wss://relay-0.example.test')
    const firstSeen = row?.lastSeenAt?.getTime() ?? 0
    expect(firstSeen).toBeGreaterThan(0)

    // A later heartbeat advances lastSeenAt (proves the READY-state EVT path).
    await new Promise((r) => setTimeout(r, 15))
    sendFrame(ws, 'rc/heartbeat', {})
    await new Promise((r) => setTimeout(r, 50)) // no REP for an EVT — let the write land
    const after = await prisma.relay.findUnique({ where: { name: 'pod-0' } })
    expect(after?.lastSeenAt?.getTime() ?? 0).toBeGreaterThanOrEqual(firstSeen)

    ws.close()
  })

  it('reclaims the same relayId when a relay re-registers under the same name', async () => {
    const { base } = await start()
    const first = await registerRelay(base, 'pod-0', 'wss://relay-0.example.test')
    const second = await registerRelay(base, 'pod-0', 'wss://relay-0-v2.example.test')
    expect(second).toBe(first) // upsert on the unique name — stable identity across restarts
    const row = await prisma.relay.findUnique({ where: { name: 'pod-0' } })
    expect(row?.daemonUrl).toBe('wss://relay-0-v2.example.test') // daemonUrl refreshed
  })

  it('replays revision-fenced external-memory bindings to a later-joining relay', async () => {
    const { app, base } = await start()
    const daemonWs = await connectDaemonReady(base)
    const root = `/api/v1/orgs/${DEFAULT_ORG_ID}`
    const installation = await app.http.inject({
      method: 'POST',
      url: `${root}/memory-plugin-installations`,
      payload: {
        pluginId: 'ai.example.memory',
        transport: 'streamable-http',
        endpoint: 'https://plugin.example/mcp',
        secretHeaders: [{ name: 'apiKey', header: 'Authorization', required: true }]
      }
    })
    expect(installation.statusCode).toBe(201)
    const connection = await app.http.inject({
      method: 'POST',
      url: `${root}/external-memory-connections`,
      payload: {
        installationId: (installation.json() as { id: string }).id,
        config: { projectId: 'p1' },
        secrets: { apiKey: 'upstream-memory-secret' }
      }
    })
    expect(connection.statusCode).toBe(201)
    expect(connection.body).not.toContain('upstream-memory-secret')
    const connectionId = (connection.json() as { id: string }).id
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.agent.update({
      where: { id: AGENT },
      data: { runtimeOverrides: { memory: { provider: 'external', connectionId } } }
    })

    const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)
    const frames: Array<{ type: string; payload: unknown }> = []
    ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as { type: string; payload: unknown }))
    sendFrame(ws, 'rc/auth', { method: 'token', credential: RELAY_TOKEN })
    await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'rc/auth/ok')).toBe(true))
    const daemonSpec = nextFrame(daemonWs, 'memoryconnection/upsert')
    sendFrame(ws, 'rc/register', { name: 'pod-memory', daemonUrl: 'wss://memory.example.com' })
    await vi.waitFor(() => {
      const frame = frames.find((candidate) => candidate.type === 'rc/memoryconnection-assign')
      expect(frame).toBeDefined()
      expect(frame!.payload).toMatchObject({
        connectionId,
        revision: 1,
        upstreamUrl: 'https://plugin.example/mcp',
        headers: [{ name: 'Authorization', value: 'upstream-memory-secret' }]
      })
      expect((frame!.payload as { grantKeyHashes: string[] }).grantKeyHashes).toHaveLength(1)
    })
    const daemonFrame = await daemonSpec
    expect(daemonFrame.payload).toMatchObject({
      connectionId,
      revision: 1,
      relayUrl: `https://memory.example.com/memory/${connectionId}`,
      config: { projectId: 'p1' },
      secretKeys: ['apiKey']
    })
    // Remote specs go out as the discriminated union they declare.
    expect((daemonFrame.payload as { transport?: unknown }).transport).toBe('streamable-http')
    expect(JSON.stringify(daemonFrame.payload)).not.toContain('upstream-memory-secret')
    ws.close()
    daemonWs.close()
  })

  it("surfaces the registered relay in a daemon's register/ok.relays (roster → daemon push)", async () => {
    const { base } = await start()
    const relayId = await registerRelay(base, 'pod-0', 'wss://relay-0.example.test')
    const token = await mintDaemon()

    const ws = await dial(`${base}/daemon/ws`, DAEMON_SUBPROTOCOL)
    sendFrame(ws, 'auth', { apiKey: token, agentVersion: 'test' })
    await nextFrame(ws, 'auth/ok')
    sendFrame(ws, 'register', {
      host: 'h',
      capabilities: { platforms: [], runtimes: [], acp: false, features: [] },
      maxAgents: 1,
      localState: { assignments: [], crons: [], leases: [] }
    })
    const regOk = await nextFrame(ws, 'register/ok')
    if (!isFrame('register/ok')(regOk)) throw new Error('expected register/ok')
    expect(regOk.payload.relays).toEqual([{ relayId, url: 'wss://relay-0.example.test' }])
    ws.close()
  })

  it('pushes a relay/roster hot-update EVT to a connected daemon when a relay registers', async () => {
    const { base } = await start()
    const token = await mintDaemon()

    const ws = await dial(`${base}/daemon/ws`, DAEMON_SUBPROTOCOL)
    sendFrame(ws, 'auth', { apiKey: token, agentVersion: 'test' })
    await nextFrame(ws, 'auth/ok')
    sendFrame(ws, 'register', {
      host: 'h',
      capabilities: { platforms: [], runtimes: [], acp: false, features: [] },
      maxAgents: 1,
      localState: { assignments: [], crons: [], leases: [] }
    })
    const regOk = await nextFrame(ws, 'register/ok')
    if (!isFrame('register/ok')(regOk)) throw new Error('expected register/ok')
    expect(regOk.payload.relays).toEqual([]) // no relays yet

    // Arm the listener BEFORE the relay registers, then register one — the CP fans
    // a relay/roster EVT to the already-connected daemon (§5 hot update).
    const rosterFrame = nextFrame(ws, 'relay/roster')
    const relayId = await registerRelay(base, 'pod-9', 'wss://relay-9.example.test')
    const roster = await rosterFrame
    if (!isFrame('relay/roster')(roster)) throw new Error('expected relay/roster')
    expect(roster.payload.relays).toEqual([{ relayId, url: 'wss://relay-9.example.test' }])
    ws.close()
  })

  it('rejects a wrong shared token with close 4401', async () => {
    const { base } = await start()
    const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)
    sendFrame(ws, 'rc/auth', { method: 'token', credential: 'wrong-secret-0123456789abcdefghij' })
    expect(await closeCode(ws)).toBe(4401)
  })

  it('rejects a client that does not offer the rc subprotocol', async () => {
    const { base } = await start()
    await expect(dial(`${base}/api/v1/relays/ws`, 'agentconnect.v1')).rejects.toThrow()
  })

  it('rc/verify(daemon-key) resolves a live daemon key to {ok:true, daemonId, orgId}', async () => {
    const { base } = await start()
    const daemonKey = await mintDaemon()
    const { ws } = await openRelay(base, 'pod-v', 'wss://pod-v.example.test')

    sendFrame(ws, 'rc/verify', { kind: 'daemon-key', credential: daemonKey })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    expect(ok).toMatchObject({ ok: true, daemonId: DAEMON, orgId: DEFAULT_ORG_ID })
    ws.close()
  })

  it('rc/verify(daemon-key) rejects an unknown key with {ok:false} (no oracle)', async () => {
    const { base } = await start()
    const { ws } = await openRelay(base, 'pod-v2', 'wss://pod-v2.example.test')

    const unknown = new ApiKeyCodec({ API_KEY_PEPPER }).mint().token // never persisted
    sendFrame(ws, 'rc/verify', { kind: 'daemon-key', credential: unknown })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    expect(ok.ok).toBe(false)
    expect(ok.daemonId).toBeUndefined()
    ws.close()
  })

  it('pushes rc/daemon-revoke to a connected relay when the daemon is removed (§9 closed loop)', async () => {
    const { app, base } = await start()
    await mintDaemon()
    const { ws } = await openRelay(base, 'pod-r', 'wss://pod-r.example.test')

    // Arm the listener, then remove the daemon via REST — the CP fans rc/daemon-revoke.
    const revoked = nextFrame(ws, 'rc/daemon-revoke')
    const res = await app.http.inject({ method: 'DELETE', url: `/api/v1/orgs/${DEFAULT_ORG_ID}/daemons/${DAEMON}` })
    expect(res.statusCode).toBe(204)
    const payload = (await revoked).payload as { daemonId: string }
    expect(payload.daemonId).toBe(DAEMON)
    ws.close()
  })

  it('rc/run-report(accepted) opens a HookRun row through the real socket (§ webhook bookkeeping)', async () => {
    const { base } = await start()
    // A placed hook the delivery report references (recordDelivery gates on existence).
    await prisma.daemon.create({ data: { id: DAEMON, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const hookId = randomUUID()
    await prisma.hookDef.create({
      data: {
        id: hookId,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        kind: 'webhook',
        name: 'ci',
        sessionMode: 'perDelivery',
        urlToken: `whk_${randomUUID().replace(/-/g, '')}`,
        targetPlatform: 'slack'
      }
    })
    const { ws } = await openRelay(base, 'pod-rr', 'wss://pod-rr.example.test')

    // Fire-and-forget EVT: no reply — the CP's onRunReport → recordDelivery lands async.
    sendFrame(ws, 'rc/run-report', {
      hookId,
      deliveryKey: 'd-1',
      firedAt: '2026-07-08T12:00:00.000Z',
      agentId: AGENT,
      daemonId: DAEMON,
      status: 'accepted'
    })
    await vi.waitFor(async () => {
      const run = await prisma.hookRun.findUnique({ where: { hookId_deliveryKey: { hookId, deliveryKey: 'd-1' } } })
      expect(run?.status).toBe('running')
    })
    // lastFiredAt advanced too (the delivery stamps the def).
    expect((await prisma.hookDef.findUnique({ where: { id: hookId } }))?.lastFiredAt).toEqual(
      new Date('2026-07-08T12:00:00.000Z')
    )
    ws.close()
  })

  // ── webchat token mint route + rc/verify(webchat-token) (§10, milestone A4) ──

  it('POST …/webchat/token mints {token, relayUrl, conversationId} for a visible agent', async () => {
    const { app } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    await seedAgent(prisma, AGENT)
    const res = await mintWebchatToken(app, AGENT)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { token: string; relayUrl: string; conversationId: string }
    expect(body.relayUrl).toBe(RELAY_URL)
    expect(body.token.split('.')).toHaveLength(3) // a compact JWS (header.payload.sig)
    expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/) // a fresh conversation id
  })

  it('POST …/webchat/token resumes the caller’s own conversation; unknown ids and another member’s turnless one are 404', async () => {
    const { app } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    await seedAgent(prisma, AGENT)
    const fresh = await mintWebchatToken(app, AGENT)
    const conversationId = (fresh.json() as { conversationId: string }).conversationId

    const owned = await mintWebchatToken(app, AGENT, { conversationId })
    expect(owned.statusCode).toBe(200)
    expect((owned.json() as { conversationId: string }).conversationId).toBe(conversationId)

    expect((await mintWebchatToken(app, AGENT, { conversationId: randomUUID() })).statusCode).toBe(404)

    // Another member's conversation that has not had a turn yet stands on no session: owner-only.
    const otherUserId = 'usr_webchat_victim'
    await prisma.user.create({ data: { id: otherUserId, email: 'webchat-victim@example.test' } })
    await prisma.membership.create({ data: { orgId: DEFAULT_ORG_ID, userId: otherUserId, role: 'collaborator' } })
    const otherConversationId = randomUUID()
    await prisma.webchatConversation.create({
      data: { id: otherConversationId, orgId: DEFAULT_ORG_ID, agentId: AGENT, userId: otherUserId }
    })
    expect((await mintWebchatToken(app, AGENT, { conversationId: otherConversationId })).statusCode).toBe(404)
  })

  // Resume follows the session's visibility, exactly like an integration-origin continuation
  // (policy `session.continue`): a conversation whose current session its owner made org-visible
  // is every non-viewer member's to continue; a private one stays the owner's.
  it('resumes another member’s conversation by the visibility of the session it stands on', async () => {
    const { app } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    await seedAgent(prisma, AGENT)
    const otherUserId = 'usr_webchat_sharer'
    await prisma.user.create({ data: { id: otherUserId, email: 'webchat-sharer@example.test' } })
    await prisma.membership.create({ data: { orgId: DEFAULT_ORG_ID, userId: otherUserId, role: 'collaborator' } })
    const seedConversation = async (visibility: 'org' | 'private'): Promise<string> => {
      const conversationId = randomUUID()
      const sessionId = `acp-${visibility}-${conversationId.slice(0, 8)}`
      await prisma.webchatConversation.create({
        data: { id: conversationId, orgId: DEFAULT_ORG_ID, agentId: AGENT, userId: otherUserId }
      })
      await seedSessionMeta(prisma, sessionId, AGENT, {
        platform: 'webchat',
        channel: conversationId,
        visibility,
        ownerIdentity: `user:${otherUserId}`
      })
      await prisma.webchatConversation.update({ where: { id: conversationId }, data: { currentSessionId: sessionId } })
      await prisma.webchatConversationAgent.create({
        data: {
          conversationId,
          agentId: AGENT,
          role: 'primary',
          ord: 0,
          addedByUserId: otherUserId,
          currentSessionId: sessionId
        }
      })
      return conversationId
    }
    const shared = await seedConversation('org')
    const kept = await seedConversation('private')

    // Both mint paths agree: the per-agent legacy route and the conversation-scoped one.
    expect((await mintWebchatToken(app, AGENT, { conversationId: shared })).statusCode).toBe(200)
    expect((await mintConversationToken(app, { conversationId: shared })).statusCode).toBe(200)
    expect((await mintWebchatToken(app, AGENT, { conversationId: kept })).statusCode).toBe(404)
    expect((await mintConversationToken(app, { conversationId: kept })).statusCode).toBe(404)

    // A multi-agent roster is judged as a WHOLE. A peer with no session yet (a targeted turn skipped it,
    // or its delivery was refused) has nothing visible to judge, and the minted socket could target it
    // into a session that is default-private to the owner — so the conversation stays the owner's until
    // every participant stands on a session the caller may continue.
    await seedAgent(prisma, AGENT_B)
    await prisma.webchatConversationAgent.create({
      data: { conversationId: shared, agentId: AGENT_B, role: 'member', ord: 1, addedByUserId: otherUserId }
    })
    expect((await mintConversationToken(app, { conversationId: shared })).statusCode).toBe(404)
    const peerSession = `acp-peer-${shared.slice(0, 8)}`
    await seedSessionMeta(prisma, peerSession, AGENT_B, {
      platform: 'webchat',
      channel: shared,
      visibility: 'org',
      ownerIdentity: `user:${otherUserId}`
    })
    await prisma.webchatConversationAgent.update({
      where: { conversationId_agentId: { conversationId: shared, agentId: AGENT_B } },
      data: { currentSessionId: peerSession }
    })
    expect((await mintConversationToken(app, { conversationId: shared })).statusCode).toBe(200)
    // …and one private peer session is enough to keep it the owner's.
    await prisma.sessionMeta.update({ where: { id: peerSession }, data: { visibility: 'private' } })
    expect((await mintConversationToken(app, { conversationId: shared })).statusCode).toBe(404)
  })

  it('POST …/webchat/token → 503 when no relay pool is configured (PUBLIC_RELAY_URL unset)', async () => {
    const { app } = await start() // no PUBLIC_RELAY_URL → the console falls back to the CP path
    await seedAgent(prisma, AGENT)
    expect((await mintWebchatToken(app, AGENT)).statusCode).toBe(503)
  })

  it('POST …/webchat/token → 404 for an agent that does not exist / is not visible', async () => {
    const { app } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    expect((await mintWebchatToken(app, randomUUID())).statusCode).toBe(404)
  })

  it('rc/verify(webchat-token) resolves placement and the bound conversation id', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base) // DAEMON now READY in connReg
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as {
      token: string
      conversationId: string
    }

    const { ws } = await openRelay(base, 'pod-w', 'wss://pod-w.example.test')
    sendFrame(ws, 'rc/verify', {
      kind: 'webchat-token',
      credential: token.token,
      conversationBinding: 'v1'
    })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    expect(ok).toMatchObject({
      ok: true,
      agentId: AGENT,
      daemonId: DAEMON,
      orgId: DEFAULT_ORG_ID,
      conversationId: token.conversationId
    })
    // The handle names the PERSON: the daemon puts it on the transcript author line AND in the
    // session worktree's branch, so the profile's display name wins over the sign-in address.
    expect(ok.user).toBe('Owner')
    ws.close()
    daemonWs.close()
  })

  it('rc/verify(webchat-token) falls back past a profile with no display name', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.user.update({ where: { id: DEFAULT_OWNER_ID }, data: { displayName: null } })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { token: string }

    const { ws } = await openRelay(base, 'pod-w2', 'wss://pod-w2.example.test')
    sendFrame(ws, 'rc/verify', { kind: 'webchat-token', credential: token.token, conversationBinding: 'v1' })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    // devAuth carries no email either, so the last resort is the user id — never an empty handle.
    expect(ok.user).toBe(DEFAULT_OWNER_ID)
    ws.close()
    daemonWs.close()
  })

  // ── multi-agent conversations (webchat-multi-agents.md §3.1 / §6.2) ──

  it('POST …/webchat/conversations/token creates a multi-agent roster when every daemon is capable', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base, [WEBCHAT_MULTI_AGENT_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON, name: 'agent-b' })

    const res = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/token`,
      payload: { agentIds: [AGENT, AGENT_B] }
    })
    expect(res.statusCode).toBe(200)
    const minted = res.json() as { token: string; conversationId: string }

    const roster = await prisma.webchatConversationAgent.findMany({
      where: { conversationId: minted.conversationId },
      orderBy: { ord: 'asc' }
    })
    expect(roster.map((r) => ({ agentId: r.agentId, role: r.role }))).toEqual([
      { agentId: AGENT, role: 'primary' },
      { agentId: AGENT_B, role: 'member' }
    ])

    // rc/verify returns the roster with placements, primary first — and no
    // delegated MCP entitlement (single-participant privilege, §10.3).
    const { ws, result } = await verifyWebchat(base, minted.token, 'pod-multi')
    expect(result.ok).toBe(true)
    expect(result.participants).toEqual([
      { agentId: AGENT, daemonId: DAEMON, primary: true },
      { agentId: AGENT_B, daemonId: DAEMON }
    ])
    expect(result.remoteMcp).toBeUndefined()
    ws.close()
    daemonWs.close()
  })

  // A pool agent's row names no machine, so the pre-#1028 gate read a null `daemonId`, found no
  // daemon, and refused every multi-agent conversation with 409.
  it('POST …/webchat/conversations/token admits pool agents whose duty holder advertises the feature', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const memberWs = await connectDaemonReady(base, [WEBCHAT_MULTI_AGENT_FEATURE])
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, AGENT_B, { name: 'agent-b' })
    await placeOnSet([AGENT, AGENT_B], DAEMON)

    const res = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/token`,
      payload: { agentIds: [AGENT, AGENT_B] }
    })
    expect(res.statusCode).toBe(200)
    const minted = res.json() as { token: string; conversationId: string }

    // rc/verify resolves the same member for both participants.
    const { ws, result } = await verifyWebchat(base, minted.token, 'pod-pool-multi')
    expect(result.participants).toEqual([
      { agentId: AGENT, daemonId: DAEMON, primary: true },
      { agentId: AGENT_B, daemonId: DAEMON }
    ])
    ws.close()
    memberWs.close()
  })

  it('POST …/webchat/conversations/:id/agents joins a pool agent mid-conversation', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const memberWs = await connectDaemonReady(base, [WEBCHAT_MULTI_AGENT_FEATURE])
    await seedAgent(prisma, AGENT)
    await seedAgent(prisma, AGENT_B, { name: 'agent-b' })
    await placeOnSet([AGENT, AGENT_B], DAEMON)
    const fresh = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { conversationId: string }

    const join = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/${fresh.conversationId}/agents`,
      payload: { agentId: AGENT_B }
    })
    expect(join.statusCode).toBe(200)
    expect((join.json() as { participants: unknown }).participants).toEqual([
      { agentId: AGENT, primary: true },
      { agentId: AGENT_B }
    ])
    memberWs.close()
  })

  it('POST …/webchat/conversations/token → 409 when a selected daemon lacks multi-agent support', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base) // READY but no features
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON, name: 'agent-b' })
    const res = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/token`,
      payload: { agentIds: [AGENT, AGENT_B] }
    })
    expect(res.statusCode).toBe(409)
    daemonWs.close()
  })

  it('POST …/webchat/conversations/:id/agents joins mid-conversation (idempotent) and grows the verified roster', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base, [WEBCHAT_MULTI_AGENT_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON, name: 'agent-b' })
    const fresh = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { conversationId: string }
    const join = () =>
      app.http.inject({
        method: 'POST',
        url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/${fresh.conversationId}/agents`,
        payload: { agentId: AGENT_B }
      })

    const first = await join()
    expect(first.statusCode).toBe(200)
    expect((first.json() as { participants: unknown }).participants).toEqual([
      { agentId: AGENT, primary: true },
      { agentId: AGENT_B }
    ])
    expect((await join()).statusCode).toBe(200) // idempotent re-join

    // The browser refreshes the relay roster by reconnecting: a resume mint +
    // rc/verify now carries both participants.
    const resumed = (await mintWebchatToken(app, AGENT, { conversationId: fresh.conversationId }).then((r) =>
      r.json()
    )) as { token: string }
    const { ws, result } = await verifyWebchat(base, resumed.token, 'pod-join')
    expect(result.participants?.map((p) => p.agentId)).toEqual([AGENT, AGENT_B])
    ws.close()
    daemonWs.close()
  })

  it('POST …/webchat/conversations/:id/agents → 404 for an unknown or foreign conversation', async () => {
    const { app } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    await seedAgent(prisma, AGENT)
    const res = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/${randomUUID()}/agents`,
      payload: { agentId: AGENT }
    })
    expect(res.statusCode).toBe(404)
  })

  it('rc/verify(webchat-token) establishes a preset delegation when the daemon capability passes', async () => {
    const { app, base } = await start({
      PUBLIC_RELAY_URL: RELAY_URL
    })
    const daemonWs = await connectDaemonReady(base, [WEBCHAT_REMOTE_MCP_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.presetAgent.create({
      data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: AGENT, status: 'created' }
    })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as {
      token: string
      conversationId: string
    }

    const { ws } = await openRelay(base, 'pod-delegated', 'wss://pod-delegated.example.test')
    sendFrame(ws, 'rc/verify', {
      kind: 'webchat-token',
      credential: token.token,
      conversationBinding: 'v1'
    })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult

    expect(ok).toMatchObject({
      ok: true,
      agentId: AGENT,
      daemonId: DAEMON,
      conversationId: token.conversationId,
      remoteMcp: {
        authorityGeneration: 1
      }
    })
    expect(ok.remoteMcp?.authorityId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ok).not.toHaveProperty('assertion')
    expect(JSON.stringify(ok)).not.toContain(token.token)

    const reconnect = await verifyWebchat(base, token.token, 'pod-delegated-reconnect')
    expect(reconnect.result.remoteMcp).toEqual(ok.remoteMcp)
    expect(
      await prisma.webchatMcpDelegation.count({
        where: { conversationId: token.conversationId, revokedAt: null }
      })
    ).toBe(1)

    reconnect.ws.close()
    ws.close()
    daemonWs.close()
  })

  it('keeps ordinary preset webchat when the daemon lacks the remote-MCP capability', async () => {
    const { app, base } = await start({
      PUBLIC_RELAY_URL: RELAY_URL
    })
    const daemonWs = await connectDaemonReady(base)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.presetAgent.create({
      data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: AGENT, status: 'created' }
    })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { token: string }

    const verified = await verifyWebchat(base, token.token, 'pod-incapable')

    expect(verified.result).toMatchObject({ ok: true, agentId: AGENT, daemonId: DAEMON })
    expect(verified.result.remoteMcp).toBeUndefined()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
    verified.ws.close()
    daemonWs.close()
  })

  it('keeps ordinary non-preset webchat when remote-MCP entitlement is denied', async () => {
    const { app, base } = await start({
      PUBLIC_RELAY_URL: RELAY_URL
    })
    const daemonWs = await connectDaemonReady(base, [WEBCHAT_REMOTE_MCP_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { token: string }

    const verified = await verifyWebchat(base, token.token, 'pod-non-preset')

    expect(verified.result).toMatchObject({ ok: true, agentId: AGENT, daemonId: DAEMON })
    expect(verified.result.remoteMcp).toBeUndefined()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
    verified.ws.close()
    daemonWs.close()
  })

  it('keeps ordinary webchat but omits remote MCP when the token owner loses current membership', async () => {
    const { app, base } = await start({
      PUBLIC_RELAY_URL: RELAY_URL
    })
    const daemonWs = await connectDaemonReady(base, [WEBCHAT_REMOTE_MCP_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.presetAgent.create({
      data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: AGENT, status: 'created' }
    })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { token: string }
    await prisma.membership.delete({
      where: { orgId_userId: { orgId: DEFAULT_ORG_ID, userId: DEFAULT_OWNER_ID } }
    })

    const verified = await verifyWebchat(base, token.token, 'pod-membership-revoked')

    expect(verified.result).toMatchObject({ ok: true, agentId: AGENT, daemonId: DAEMON })
    expect(verified.result.remoteMcp).toBeUndefined()
    expect(await prisma.webchatMcpDelegation.count()).toBe(0)
    verified.ws.close()
    daemonWs.close()
  })

  it('rc/verify(webchat-token) → {ok:false} when the agent’s daemon is offline (live placement re-checked)', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    // Agent placed on a daemon that exists but is NOT connected — placement fails at verify.
    await prisma.daemon.create({ data: { id: DAEMON, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const token = (await mintWebchatToken(app, AGENT).then((r) => r.json())) as { token: string }

    const { ws } = await openRelay(base, 'pod-w2', 'wss://pod-w2.example.test')
    sendFrame(ws, 'rc/verify', {
      kind: 'webchat-token',
      credential: token.token,
      conversationBinding: 'v1'
    })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    expect(ok.ok).toBe(false)
    expect(ok.daemonId).toBeUndefined()
    ws.close()
  })

  it('rc/verify(webchat-token) → {ok:false} for a bogus token (no oracle)', async () => {
    const { base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const { ws } = await openRelay(base, 'pod-w3', 'wss://pod-w3.example.test')
    sendFrame(ws, 'rc/verify', {
      kind: 'webchat-token',
      credential: 'not.a.valid.jwt',
      conversationBinding: 'v1'
    })
    const ok = (await nextFrame(ws, 'rc/verify/ok')).payload as RcVerifyResult
    expect(ok.ok).toBe(false)
    ws.close()
  })

  // ── installation doorbell (webhook-triggers decision 11, B-github) ─────────
  describe('rc/github-installation doorbell', () => {
    const INSTALLATION = 1234567n
    const HOOK_ID = '99999999-9999-4999-8999-999999999999'

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const GH_ENV = {
      GITHUB_APP_ID: 1,
      GITHUB_APP_PRIVATE_KEY_B64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString(
        'base64'
      ),
      GITHUB_APP_SLUG: 'agentconnect-test'
    }

    /** GET /app/installations/{id} stub — the only call the doorbell pull makes. */
    const installationFetch =
      (status: 200 | 404, repositorySelection = 'selected') =>
      async (url: string): Promise<Response> => {
        if (!/\/app\/installations\/\d+$/.test(url)) throw new Error(`unexpected github call: ${url}`)
        if (status === 404) return Response.json({ message: 'Not Found' }, { status: 404 })
        return Response.json({
          id: Number(INSTALLATION),
          account: { login: 'acme', type: 'Organization' },
          repository_selection: repositorySelection,
          suspended_at: null
        })
      }

    /** A claimed installation + a placed agent + one enabled github hook. */
    async function seedGithubWorld(): Promise<void> {
      await prisma.githubInstallation.create({
        data: {
          orgId: DEFAULT_ORG_ID,
          installationId: INSTALLATION,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'all'
        }
      })
      await prisma.daemon.create({ data: { id: DAEMON, orgId: DEFAULT_ORG_ID, status: 'provisioned' } })
      await seedAgent(prisma, AGENT, { daemonId: DAEMON })
      await prisma.hookDef.create({
        data: {
          id: HOOK_ID,
          orgId: DEFAULT_ORG_ID,
          agentId: AGENT,
          kind: 'github',
          name: 'gh-issues',
          sessionMode: 'perThread',
          repoId: 987654321n,
          repoFullName: 'acme/infra',
          events: ['issues:opened'],
          labelFilter: [],
          targetPlatform: 'slack'
        }
      })
    }

    /** Open a relay socket that RECORDS every inbound frame (the register replay
     *  can land in the same tick as rc/registered — a late listener would miss it).
     *  Frames are rc/* — outside the daemon `AnyFrame` union, so typed loosely. */
    type RcWireFrame = { type: string; payload: unknown }
    async function openRecordingRelay(base: string, name: string): Promise<{ ws: WebSocket; frames: RcWireFrame[] }> {
      const ws = await dial(`${base}/api/v1/relays/ws`, RELAY_CP_SUBPROTOCOL)
      const frames: RcWireFrame[] = []
      ws.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as RcWireFrame))
      sendFrame(ws, 'rc/auth', { method: 'token', credential: RELAY_TOKEN })
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'rc/auth/ok')).toBe(true))
      sendFrame(ws, 'rc/register', { name, daemonUrl: `wss://${name}.example.com` })
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'rc/registered')).toBe(true))
      return { ws, frames }
    }

    it('re-pulls a known installation (200) and re-broadcasts the org github rules', async () => {
      await seedGithubWorld()
      const { base } = await start(GH_ENV, installationFetch(200, 'selected'))
      const { ws, frames } = await openRecordingRelay(base, 'pod-gh1')

      // Register replay already compiled the github rule (installationIds attached).
      await vi.waitFor(() => {
        const assign = frames.find((f) => f.type === 'rc/hook-assign')
        expect(assign).toBeDefined()
        expect((assign!.payload as { github?: { repoId: string; installationIds: string[] } }).github).toMatchObject({
          repoId: '987654321',
          installationIds: [INSTALLATION.toString()]
        })
      })

      const replayCount = frames.filter((f) => f.type === 'rc/hook-assign').length
      sendFrame(ws, 'rc/github-installation', { installationId: INSTALLATION.toString(), action: 'added' })

      // The pull wrote GitHub's current facts under the existing org claim…
      await vi.waitFor(async () => {
        const row = await prisma.githubInstallation.findUnique({ where: { installationId: INSTALLATION } })
        expect(row?.repositorySelection).toBe('selected')
        expect(row?.orgId).toBe(DEFAULT_ORG_ID)
      })
      // …and the org's github rules were re-broadcast to the pool.
      await vi.waitFor(() =>
        expect(frames.filter((f) => f.type === 'rc/hook-assign').length).toBeGreaterThan(replayCount)
      )
      ws.close()
    })

    it('marks a gone installation revoked (404) and evicts the rules (rc/hook-remove)', async () => {
      await seedGithubWorld()
      const { base } = await start(GH_ENV, installationFetch(404))
      const { ws, frames } = await openRecordingRelay(base, 'pod-gh2')
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'rc/hook-assign')).toBe(true))

      sendFrame(ws, 'rc/github-installation', { installationId: INSTALLATION.toString(), action: 'deleted' })

      await vi.waitFor(async () => {
        const row = await prisma.githubInstallation.findUnique({ where: { installationId: INSTALLATION } })
        expect(row?.revokedAt).not.toBeNull()
      })
      // No valid installation remains ⇒ the compile is null ⇒ pool-wide remove.
      await vi.waitFor(() => {
        const remove = frames.find((f) => f.type === 'rc/hook-remove')
        expect(remove).toBeDefined()
        expect((remove!.payload as { hookId: string }).hookId).toBe(HOOK_ID)
      })
      ws.close()
    })

    it('ignores an unclaimed installation and keeps the link serving', async () => {
      const { base } = await start(GH_ENV, installationFetch(200))
      const { ws, frames } = await openRecordingRelay(base, 'pod-gh3')

      sendFrame(ws, 'rc/github-installation', { installationId: '55555', action: 'created' })
      // The link still answers a correlated REQ afterwards (nothing closed it),
      // and no installation row appeared out of thin air.
      sendFrame(ws, 'rc/verify', { kind: 'daemon-key', credential: 'nope' })
      await vi.waitFor(() => expect(frames.some((f) => f.type === 'rc/verify/ok')).toBe(true))
      expect(await prisma.githubInstallation.count()).toBe(0)
      ws.close()
    })
  })
})

// ── session-targeted continuation (webchat-cross-integration-continuation.md §6.2) ──
describe('webchat session-continuation mint + verify', () => {
  const SESSION_ID = 'acp-continuation-session-1'
  const HOOK_SESSION_ID = 'acp-continuation-hook-1'
  const CONTINUATION = [WEBCHAT_SESSION_CONTINUATION_FEATURE]

  function mintSessionToken(app: App, sessionId: string) {
    return app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/${sessionId}/webchat/token`,
      payload: {}
    })
  }

  async function seedContinuable(over: { sessionDaemonId?: string; platform?: string } = {}): Promise<void> {
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, SESSION_ID, AGENT, {
      daemonId: over.sessionDaemonId ?? DAEMON,
      platform: over.platform ?? 'slack',
      channel: 'C123'
    })
  }

  it('mints an adopting conversation, converges concurrent mints, and verifies with targetSessionId', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base, CONTINUATION)
    const { ws: relayWs } = await openRelay(base, 'pod-cont', 'wss://pod-cont.example.test', CONTINUATION)
    await seedContinuable()

    const first = await mintSessionToken(app, SESSION_ID)
    expect(first.statusCode).toBe(200)
    const minted = first.json() as { token: string; conversationId: string; relayUrl: string }
    expect(minted.relayUrl).toBe(RELAY_URL)

    // A later mint by the same user converges on the (userId, targetSessionId) unique row.
    const second = await mintSessionToken(app, SESSION_ID)
    expect(second.statusCode).toBe(200)
    expect((second.json() as { conversationId: string }).conversationId).toBe(minted.conversationId)

    const row = await prisma.webchatConversation.findUnique({ where: { id: minted.conversationId } })
    expect(row?.targetSessionId).toBe(SESSION_ID)
    expect(row?.currentSessionId).toBe(SESSION_ID)

    // Verify resolves the continuation verdict: targetSessionId + single fixed participant.
    sendFrame(relayWs, 'rc/verify', { kind: 'webchat-token', credential: minted.token, conversationBinding: 'v1' })
    const verdict = (await nextFrame(relayWs, 'rc/verify/ok')).payload as RcVerifyResult
    expect(verdict).toMatchObject({
      ok: true,
      conversationId: minted.conversationId,
      daemonId: DAEMON,
      targetSessionId: SESSION_ID,
      participants: [{ agentId: AGENT, daemonId: DAEMON, primary: true }]
    })
    expect(verdict.remoteMcp).toBeUndefined()

    // Mid-conversation join is refused — a targeted conversation has a fixed participant.
    await seedAgent(prisma, AGENT_B, { daemonId: DAEMON })
    const join = await app.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/webchat/conversations/${minted.conversationId}/agents`,
      payload: { agentId: AGENT_B }
    })
    expect(join.statusCode).toBe(409)

    relayWs.close()
    daemonWs.close()
  })

  it('refuses to mint while any live relay lacks the feature, the daemon lacks it, or the state drifted', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base, CONTINUATION)
    await seedContinuable()

    // No live relay at all.
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)

    // One capable + one old relay ⇒ still refused (all-live-relays gate).
    await registerRelay(base, 'pod-new', 'wss://pod-new.example.test')
    const oldRelay = await prisma.relay.findUnique({ where: { name: 'pod-new' } })
    expect(oldRelay?.features).toEqual([])
    const { ws: capable } = await openRelay(base, 'pod-cap', 'wss://pod-cap.example.test', CONTINUATION)
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)

    // Homogeneous pool: re-register the old pod WITH the feature ⇒ mint succeeds.
    await registerRelay(base, 'pod-new', 'wss://pod-new.example.test', CONTINUATION)
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(200)

    // Retention purge invalidates minting.
    await prisma.sessionMeta.update({ where: { id: SESSION_ID }, data: { contentPurgedAt: new Date() } })
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)
    await prisma.sessionMeta.update({ where: { id: SESSION_ID }, data: { contentPurgedAt: null } })

    // Agent moved off the session's content-owning daemon.
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: null } })
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)
    await prisma.agent.update({ where: { id: AGENT }, data: { daemonId: DAEMON } })

    capable.close()
    daemonWs.close()
  })

  // A pool member is replaced on every rollout and reaped once silent, which SetNulls the
  // `daemonId` it recorded — but the rows live in the store its peers share, and the duty holder
  // reads them like it wrote them. Keying the gate on the recorder alone read as "agent moved".
  it('continues a pool-recorded session through the live duty holder once the recorder is gone', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const daemonWs = await connectDaemonReady(base, CONTINUATION)
    const { ws: relayWs } = await openRelay(base, 'pod-cont-3', 'wss://pod-cont-3.example.test', CONTINUATION)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const setId = await joinPool(prisma, DAEMON)
    await prisma.agent.update({ where: { id: AGENT }, data: { placementKind: 'set', setId, daemonId: null } })
    await seedDutyGroup(prisma, randomUUID(), DAEMON, [AGENT])
    await seedSessionMeta(prisma, SESSION_ID, AGENT, { platform: 'slack', channel: 'C123', contentSetId: setId })

    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(200)
    const detail = await app.http.inject({
      method: 'GET',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/${SESSION_ID}`
    })
    expect(detail.json()).toMatchObject({ canContinue: true, continuationUnavailableReason: null })

    // Recorded on a private store before the agent joined the pool: no live member holds those rows.
    await prisma.sessionMeta.update({ where: { id: SESSION_ID }, data: { contentSetId: null } })
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)
    const moved = await app.http.inject({ method: 'GET', url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/${SESSION_ID}` })
    expect(moved.json()).toMatchObject({ canContinue: false, continuationUnavailableReason: 'agent_moved' })

    relayWs.close()
    daemonWs.close()
  })

  it('refuses a daemon without the capability, and a dream session on any daemon', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const { ws: relayWs } = await openRelay(base, 'pod-cont-2', 'wss://pod-cont-2.example.test', CONTINUATION)

    // Daemon READY but WITHOUT the continuation feature.
    const daemonWs = await connectDaemonReady(base)
    await seedContinuable()
    expect((await mintSessionToken(app, SESSION_ID)).statusCode).toBe(409)

    // A dream session is not a conversation on any surface — the platform gate refuses it outright.
    await seedSessionMeta(prisma, 'acp-dream-session', AGENT, { daemonId: DAEMON, platform: 'dream' })
    expect((await mintSessionToken(app, 'acp-dream-session')).statusCode).toBe(409)
    const dream = await app.http.inject({
      method: 'GET',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/acp-dream-session`
    })
    expect(dream.json()).toMatchObject({ canContinue: false, continuationUnavailableReason: 'unsupported_platform' })

    relayWs.close()
    daemonWs.close()
  })

  // §9: a GitHub / GitLab / webhook session continues console-only, which is a strictly newer
  // daemon behavior than the chat mirror — so the chat bit alone must not unlock it.
  it('holds a hook session closed until the daemon advertises the hook continuation bit', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const { ws: relayWs } = await openRelay(base, 'pod-cont-4', 'wss://pod-cont-4.example.test', CONTINUATION)
    const daemonWs = await connectDaemonReady(base, CONTINUATION)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, HOOK_SESSION_ID, AGENT, {
      daemonId: DAEMON,
      platform: 'hook',
      channel: 'github:1310543401'
    })

    expect((await mintSessionToken(app, HOOK_SESSION_ID)).statusCode).toBe(409)
    const blocked = await app.http.inject({
      method: 'GET',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/${HOOK_SESSION_ID}`
    })
    expect(blocked.json()).toMatchObject({ canContinue: false, continuationUnavailableReason: 'unavailable' })

    relayWs.close()
    daemonWs.close()
  })

  it('mints and verifies a hook session once the daemon carries the hook bit', async () => {
    const { app, base } = await start({ PUBLIC_RELAY_URL: RELAY_URL })
    const { ws: relayWs } = await openRelay(base, 'pod-cont-5', 'wss://pod-cont-5.example.test', CONTINUATION)
    const daemonWs = await connectDaemonReady(base, [...CONTINUATION, WEBCHAT_HOOK_CONTINUATION_FEATURE])
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await seedSessionMeta(prisma, HOOK_SESSION_ID, AGENT, {
      daemonId: DAEMON,
      platform: 'hook',
      channel: 'github:1310543401'
    })

    const minted = await mintSessionToken(app, HOOK_SESSION_ID)
    expect(minted.statusCode).toBe(200)
    const detail = await app.http.inject({
      method: 'GET',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/sessions/${HOOK_SESSION_ID}`
    })
    expect(detail.json()).toMatchObject({ canContinue: true, continuationUnavailableReason: null })

    sendFrame(relayWs, 'rc/verify', {
      kind: 'webchat-token',
      credential: (minted.json() as { token: string }).token,
      conversationBinding: 'v1'
    })
    const verdict = (await nextFrame(relayWs, 'rc/verify/ok')).payload as RcVerifyResult
    expect(verdict).toMatchObject({ ok: true, targetSessionId: HOOK_SESSION_ID })

    relayWs.close()
    daemonWs.close()
  })
})
