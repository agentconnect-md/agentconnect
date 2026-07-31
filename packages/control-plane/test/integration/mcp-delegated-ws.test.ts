import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { DELEGATED_MCP_ASSERTION_FEATURE, isFrame, type AnyFrame } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema, type AppConfig } from '../../src/config/env.js'
import { systemClock } from '../../src/domain/clock.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { AgentId, DaemonId, OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const DAEMON = 'd1111111-1111-4111-8111-111111111111'
const OTHER_DAEMON = 'd2222222-2222-4222-8222-222222222222'
const AGENT = 'a1111111-1111-4111-8111-111111111111'
const CONVERSATION = 'c1111111-1111-4111-8111-111111111111'
const INVOCATION = '11111111-1111-4111-8111-111111111111'
const SUBPROTOCOL = 'agentconnect.v1'
const API_KEY_PEPPER = 'delegated-ws-pepper-0123456789abcdef'

function testConfig(): AppConfig {
  return AppConfigSchema.parse({
    DATABASE_URL: 'postgresql://delegated-ws/ignored',
    API_KEY_PEPPER,
    SECRETS_PROVIDER: 'memory',
    WS_PATH: '/daemon/ws',
    HEARTBEAT_SEC: 15
  })
}

let running: App | undefined
const sockets = new Set<WebSocket>()

afterEach(async () => {
  for (const socket of sockets) socket.close()
  sockets.clear()
  await running?.shutdown()
  running = undefined
})

function dial(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, SUBPROTOCOL)
  sockets.add(socket)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function sendFrame(socket: WebSocket, type: string, payload: unknown, id = randomUUID()): string {
  socket.send(JSON.stringify({ v: 1, id, ts: new Date().toISOString(), type, payload }))
  return id
}

function requestFrame(
  socket: WebSocket,
  type: string,
  payload: unknown,
  id = randomUUID()
): Promise<{ frame: AnyFrame; raw: Buffer }> {
  const response = new Promise<{ frame: AnyFrame; raw: Buffer }>((resolve, reject) => {
    const onMessage = (data: Buffer): void => {
      const raw = Buffer.from(data)
      const frame = JSON.parse(raw.toString('utf8')) as AnyFrame
      if (frame.corr !== id) return
      socket.off('message', onMessage)
      resolve({ frame, raw })
    }
    socket.on('message', onMessage)
    socket.once('close', (code) => reject(new Error(`closed waiting for correlated reply: ${code}`)))
  })
  sendFrame(socket, type, payload, id)
  return response
}

async function handshake(socket: WebSocket, token: string, daemonId: string): Promise<void> {
  const auth = await requestFrame(socket, 'auth', {
    apiKey: token,
    daemonId,
    agentVersion: '1.5.0'
  })
  if (!isFrame('auth/ok')(auth.frame)) throw new Error('expected auth/ok')

  const registered = await requestFrame(socket, 'register', {
    host: `host-${daemonId}`,
    capabilities: {
      platforms: ['slack'],
      runtimes: ['claude'],
      acp: true,
      features: [DELEGATED_MCP_ASSERTION_FEATURE]
    },
    maxAgents: 4,
    localState: {
      assignments: [],
      crons: [],
      leases: [],
      agents: [],
      integrations: [],
      stagedAgents: []
    }
  })
  if (!isFrame('register/ok')(registered.frame)) throw new Error('expected register/ok')
}

async function provisionDaemon(daemonId: string): Promise<string> {
  const codec = new ApiKeyCodec({ API_KEY_PEPPER })
  const minted = codec.mint()
  await prisma.daemon.create({
    data: { id: daemonId, orgId: DEFAULT_ORG_ID, status: 'provisioned' }
  })
  await prisma.apiKey.create({
    data: {
      principalType: 'daemon',
      orgId: DEFAULT_ORG_ID,
      daemonId,
      hash: minted.hash,
      displayTail: minted.displayTail
    }
  })
  return minted.token
}

function denialPayloadBytes(frame: AnyFrame): Buffer {
  if (!isFrame('error')(frame)) throw new Error('expected error')
  return Buffer.from(JSON.stringify(frame.payload))
}

describe('delegated MCP daemon control over authenticated READY WebSockets', () => {
  it('mints and revokes through the real router/service/repos with connection-derived daemon authority', async () => {
    const config = testConfig()
    const app = buildApp({
      prisma,
      config,
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider()
    })
    running = app
    const address = await app.http.listen({ port: 0, host: '127.0.0.1' })
    app.mountWs()

    const [token, otherToken] = await Promise.all([provisionDaemon(DAEMON), provisionDaemon(OTHER_DAEMON)])
    await prisma.agent.create({
      data: {
        id: AGENT,
        orgId: DEFAULT_ORG_ID,
        name: 'delegated-ws-agent',
        runtime: 'claude',
        daemonId: DAEMON,
        status: 'active'
      }
    })
    await prisma.presetAgent.create({
      data: {
        orgId: DEFAULT_ORG_ID,
        preset: 'general',
        agentId: AGENT,
        status: 'created'
      }
    })
    await prisma.webchatConversation.create({
      data: {
        id: CONVERSATION,
        orgId: DEFAULT_ORG_ID,
        agentId: AGENT,
        userId: DEFAULT_OWNER_ID
      }
    })

    const wsUrl = `${address.replace(/^http/, 'ws')}${config.WS_PATH}`
    const [socket, otherSocket] = await Promise.all([dial(wsUrl), dial(wsUrl)])
    await Promise.all([handshake(socket, token, DAEMON), handshake(otherSocket, otherToken, OTHER_DAEMON)])

    const now = new Date()
    const delegation = await new PgWebchatMcpDelegationRepo(prisma).establish({
      conversationId: CONVERSATION,
      userId: DEFAULT_OWNER_ID,
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(AGENT),
      daemonId: DaemonId(DAEMON),
      now,
      expiresAt: new Date(now.getTime() + 60 * 60_000)
    })
    expect(delegation).not.toBeNull()

    const mintPayload = {
      delegationId: delegation!.id,
      generation: delegation!.generation,
      agentId: AGENT,
      conversationId: CONVERSATION,
      invocationId: INVOCATION,
      requestHash: 'a'.repeat(64),
      method: 'tools/list'
    }
    const minted = await requestFrame(socket, 'mcp/invocation/mint', mintPayload)
    expect(minted.frame.corr).toBeDefined()
    expect(isFrame('mcp/invocation/minted')(minted.frame)).toBe(true)
    if (!isFrame('mcp/invocation/minted')(minted.frame)) throw new Error('expected minted reply')
    expect(minted.frame.payload).toMatchObject({
      invocationId: INVOCATION,
      assertion: expect.stringMatching(/^ac_mcp_assert_v1_/)
    })
    expect(await prisma.mcpInvocation.findUnique({ where: { id: INVOCATION } })).toMatchObject({
      delegationId: delegation!.id,
      requestHash: mintPayload.requestHash,
      status: 'issued'
    })

    // The same payload on another authenticated READY connection cannot spoof
    // the owning daemon: authority comes exclusively from connection.daemonId.
    const denialId = 'f1111111-1111-4111-8111-111111111111'
    const wrongDaemon = await requestFrame(otherSocket, 'mcp/invocation/mint', mintPayload, denialId)
    const staleGeneration = await requestFrame(
      socket,
      'mcp/invocation/mint',
      { ...mintPayload, generation: delegation!.generation + 1 },
      denialId
    )
    expect(denialPayloadBytes(wrongDaemon.frame)).toEqual(denialPayloadBytes(staleGeneration.frame))
    expect(JSON.parse(denialPayloadBytes(wrongDaemon.frame).toString())).toEqual({
      code: 'DELEGATION_DENIED',
      message: 'Delegated MCP invocation is not authorized.',
      retryable: false
    })

    // The strict wire schema also rejects any attempt to add a daemon identity
    // field before the handler/service boundary.
    const spoofed = await requestFrame(otherSocket, 'mcp/invocation/mint', {
      ...mintPayload,
      daemonId: DAEMON
    })
    expect(spoofed.frame).toMatchObject({
      type: 'error',
      payload: { code: 'BAD_PAYLOAD', retryable: false }
    })

    const revokePayload = {
      delegationId: delegation!.id,
      generation: delegation!.generation,
      reason: 'session_closed'
    }
    const wrongDaemonRevoke = await requestFrame(otherSocket, 'webchat/mcp-delegation/revoke', revokePayload, denialId)
    expect(denialPayloadBytes(wrongDaemonRevoke.frame)).toEqual(denialPayloadBytes(wrongDaemon.frame))
    const staleGenerationRevoke = await requestFrame(
      socket,
      'webchat/mcp-delegation/revoke',
      { ...revokePayload, generation: delegation!.generation + 1 },
      denialId
    )
    expect(denialPayloadBytes(staleGenerationRevoke.frame)).toEqual(denialPayloadBytes(wrongDaemon.frame))

    const revoked = await requestFrame(socket, 'webchat/mcp-delegation/revoke', revokePayload)
    expect(revoked.frame).toMatchObject({
      type: 'webchat/mcp-delegation/revoked',
      payload: {
        delegationId: delegation!.id,
        generation: delegation!.generation,
        revoked: true
      }
    })
    expect(await prisma.webchatMcpDelegation.findUnique({ where: { id: delegation!.id } })).toMatchObject({
      revokedAt: expect.any(Date),
      revokedReason: 'session_closed'
    })

    const repeated = await requestFrame(socket, 'webchat/mcp-delegation/revoke', revokePayload)
    expect(repeated.frame).toMatchObject({
      type: 'webchat/mcp-delegation/revoked',
      payload: { revoked: true }
    })
  })
})
