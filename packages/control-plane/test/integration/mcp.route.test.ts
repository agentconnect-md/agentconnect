/**
 * `POST /api/v1/mcp` — the AgentConnect MCP endpoint (agent-assistant.md §6,
 * P0 read-only tools + P1 write tools).
 *
 * Drives the real MCP wire (stateless streamable-HTTP, JSON mode) through the
 * full Fastify stack: personal-API-key auth, tool dispatch via internal inject
 * (so RBAC + per-resource visibility come from the real routes), scope
 * confinement, the shared per-credential rate limiter, the §6.4 confirm gate,
 * and the per-call audit trail. Users other than the seeded owner are
 * impersonated via a second app whose devAuth principal is overridden
 * (`appAs`), used ONLY to mint their personal key — every MCP request then
 * runs against the main app authenticated by that key alone.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedDutyGroup } from '../fixtures/seed.js'
import { joinPool, poolSetId } from '../fakes/member-set.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { MCP_TOOLS } from '../../src/http/mcp/tools.js'
import { McpRateLimiter } from '../../src/http/mcp/rate-limit.js'
import { systemClock } from '../../src/domain/clock.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import { WebchatMcpGrantTokenCodec } from '../../src/registry/webchatMcpGrantToken.js'
import { WEBCHAT_REMOTE_MCP_FEATURE } from '@agentconnect.md/protocol'

const MCP_URL = '/api/v1/mcp'

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface ToolCallResult {
  isError?: boolean
  content: Array<{ type: string; text: string }>
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()))
})

function build(configOverrides?: Parameters<typeof buildHttpApp>[1]): HttpApp {
  const app = buildHttpApp(prisma, configOverrides)
  opened.push(app)
  return app
}

/** A user provisioned into the default org with a role + their minted personal key. */
async function makeUserWithKey(role: OrgMemberRole): Promise<{ userId: string; key: string }> {
  const sub = `mcp-${randomUUID()}`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email: `${sub}@acme.dev`, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, `${sub}@acme.dev`, role)
  return { userId, key: await mintKeyAs(userId) }
}

/** Mint a personal key for `userId` via a devAuth-overridden app (own the principal). */
async function mintKeyAs(userId: string): Promise<string> {
  const minter = buildHttpApp(prisma, { DEFAULT_OWNER_ID: userId })
  opened.push(minter)
  const res = await minter.app.inject({ method: 'POST', url: '/api/v1/me/keys', payload: { orgId: DEFAULT_ORG_ID } })
  expect(res.statusCode).toBe(201)
  return (res.json() as { apiKey: string }).apiKey
}

/** Parse an MCP response body — the SDK v2 handler streams the JSON-RPC message over SSE
 *  (`event: message\ndata: {…}`); plain-JSON replies (401/400/405) fall through. */
function mcpMessage(res: { body: string }): JsonRpcResponse {
  const dataLine = res.body.split(/\r?\n/).find((l) => l.startsWith('data:'))
  const raw = dataLine ? dataLine.slice(dataLine.indexOf(':') + 1).trim() : res.body
  return JSON.parse(raw) as JsonRpcResponse
}

let nextId = 1
async function rpc(app: HttpApp, key: string | null, method: string, params?: Record<string, unknown>) {
  const res = await app.app.inject({
    method: 'POST',
    url: MCP_URL,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    payload: { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }
  })
  return res
}

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'vitest', version: '0.0.0' }
}

async function callTool(app: HttpApp, key: string, name: string, args?: Record<string, unknown>) {
  const res = await rpc(app, key, 'tools/call', { name, arguments: args ?? {} })
  expect(res.statusCode).toBe(200)
  const body = mcpMessage(res)
  expect(body.error).toBeUndefined()
  return body.result as unknown as ToolCallResult
}

const toolText = (r: ToolCallResult): string => r.content[0]!.text

describe('POST /api/v1/mcp — auth', () => {
  it('requires a personal API key: devAuth/no-key reads 401 with a WWW-Authenticate challenge', async () => {
    const app = build()
    const res = await rpc(app, null, 'initialize', INIT_PARAMS)
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toContain('Bearer')
    expect((res.json() as { message: string }).message).toContain('personal API key')
  })

  it('rejects an unknown dot-free bearer key (401) and still carries the Bearer challenge', async () => {
    const app = build()
    const res = await rpc(app, 'notarealkey0000000000000000000000000000000000000', 'initialize', INIT_PARAMS)
    expect(res.statusCode).toBe(401)
    // The invalid-key 401 is short-circuited in the auth preHandler; the route's
    // onSend hook must still stamp the discovery challenge (RFC 9110 / P2 OAuth).
    expect(res.headers['www-authenticate']).toContain('Bearer')
  })

  it('a revoked key stops authenticating and its 401 carries the Bearer challenge', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    // Revoke every key the user holds, then the next MCP call must be denied.
    const keys = await prisma.apiKey.findMany({ where: { userId } })
    await prisma.apiKey.updateMany({ where: { id: { in: keys.map((k) => k.id) } }, data: { revokedAt: new Date() } })
    const res = await rpc(app, key, 'tools/list')
    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toContain('Bearer')
  })

  it('GET/DELETE are 405 (stateless server: no SSE stream, no session)', async () => {
    const app = build()
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await app.app.inject({ method, url: MCP_URL })
      expect(res.statusCode).toBe(405)
      expect(res.headers.allow).toBe('POST')
    }
  })

  it('a JSON-RPC batch array is rejected (400) — cannot hang the request', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    // A batch carrying a request + its cancellation is the DoS trigger the
    // stateless transport can otherwise never resolve; the route rejects arrays.
    const res = await app.app.inject({
      method: 'POST',
      url: MCP_URL,
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      payload: [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'listAgents', arguments: {} } },
        { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }
      ]
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as JsonRpcResponse).error?.code).toBe(-32600)
  })
})

describe('delegated webchat MCP operations', () => {
  /** An org-less pool member holding the agent's duty — the shape whose `agent.daemonId` is null
   *  and whose row the reaper deletes on every rollout. */
  async function seedPoolMember(daemonId: string, agentId: string): Promise<void> {
    await prisma.daemon.create({
      data: { id: daemonId, orgId: null, maxAgents: 8, status: 'ready', sessionEpoch: 1n }
    })
    await joinPool(prisma, daemonId)
    await seedDutyGroup(prisma, randomUUID(), daemonId, [agentId])
  }

  async function delegatedFixture(opts: { registerSession?: boolean; pool?: boolean } = {}) {
    const daemonId = randomUUID()
    const hostAgentId = randomUUID()
    const conversationId = randomUUID()
    if (opts.pool) {
      await seedAgent(prisma, hostAgentId)
      await prisma.agent.update({
        where: { id: hostAgentId },
        data: { placementKind: 'set', setId: await poolSetId(prisma), daemonId: null }
      })
      await seedPoolMember(daemonId, hostAgentId)
    } else {
      await seedDaemon(prisma, daemonId)
      await seedAgent(prisma, hostAgentId, { daemonId })
    }
    await prisma.webchatConversation.create({
      data: {
        id: conversationId,
        orgId: DEFAULT_ORG_ID,
        agentId: hostAgentId,
        userId: DEFAULT_OWNER_ID,
        delegationGeneration: 1
      }
    })
    const authority = await prisma.webchatMcpDelegation.create({
      data: {
        conversationId,
        generation: 1,
        userId: DEFAULT_OWNER_ID,
        orgId: DEFAULT_ORG_ID,
        agentId: hostAgentId,
        expiresAt: new Date(Date.now() + 60_000)
      }
    })
    const credential = new WebchatMcpGrantTokenCodec(TEST_API_KEY_PEPPER).mint()
    await prisma.webchatMcpAccessGrant.create({
      data: {
        authorityId: authority.id,
        descriptorInstanceId: randomUUID(),
        grantRevision: 1,
        tokenHash: credential.tokenHash,
        status: 'active',
        pendingExpiresAt: new Date(Date.now() + 60_000),
        expiresAt: new Date(Date.now() + 60_000),
        activatedAt: new Date()
      }
    })
    await prisma.presetAgent.create({
      data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: hostAgentId, status: 'created' }
    })
    // `registerSession: false` models the `session/new` window: the descriptor is
    // already installed and the adapter is connecting, but the daemon has not yet
    // reported the session, so no current-session pointer exists.
    if (opts.registerSession !== false) {
      await prisma.sessionMeta.create({
        data: {
          id: `webchat-${conversationId}`,
          agentId: hostAgentId,
          platform: 'webchat',
          channel: conversationId,
          phase: 'end',
          orgId: DEFAULT_ORG_ID,
          ownerIdentity: `user:${DEFAULT_OWNER_ID}`,
          visibility: 'private',
          visibilitySource: 'default',
          lastActivityAt: new Date(),
          startedAt: new Date(),
          // The daemon stamps `endedAt` after EVERY turn; authorization must key
          // off the conversation's current-session pointer, not this timestamp.
          endedAt: new Date()
        }
      })
      await prisma.webchatConversation.update({
        where: { id: conversationId },
        data: { currentSessionId: `webchat-${conversationId}`, currentSessionRev: 1 }
      })
    }

    // Mutable so a test can retire the holding member and connect its replacement.
    const liveDaemons = new Set<string>([daemonId])
    const app = buildHttpApp(prisma, undefined, {
      get: (id) =>
        liveDaemons.has(id)
          ? {
              reachable: true,
              state: 'READY',
              sessionEpoch: 1,
              capabilities: { features: [WEBCHAT_REMOTE_MCP_FEATURE] }
            }
          : undefined
    })
    opened.push(app)
    const remoteMethod = (payload: Record<string, unknown>) =>
      app.app.inject({
        method: 'POST',
        url: MCP_URL,
        headers: {
          authorization: `Bearer ${credential.plaintext}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json'
        },
        payload: { jsonrpc: '2.0', ...payload }
      })
    const remoteRpc = (id: number, name: string, args: Record<string, unknown>) =>
      remoteMethod({ id, method: 'tools/call', params: { name, arguments: args } })
    const decisionPath = `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${hostAgentId}/webchat/${conversationId}/mcp-operations`
    return {
      app,
      daemonId,
      hostAgentId,
      conversationId,
      liveDaemons,
      seedPoolMember,
      remoteRpc,
      remoteMethod,
      decisionPath,
      credential
    }
  }

  /** Submit a delegated write and return its pending operationId. */
  async function pendingWrite(
    fixture: Awaited<ReturnType<typeof delegatedFixture>>,
    id: number,
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    const write = await fixture.remoteRpc(id, name, args)
    expect(write.statusCode).toBe(200)
    const pending = JSON.parse(toolText(mcpMessage(write).result as unknown as ToolCallResult)) as {
      status: string
      operationId: string
    }
    expect(pending.status).toBe('awaiting_confirmation')
    return pending.operationId
  }

  it('completes the mandatory MCP handshake before any tool is reachable', async () => {
    const { remoteMethod } = await delegatedFixture()

    // An MCP client CANNOT reach tools/* without initializing first. Denying the
    // handshake denies the whole server: the adapter drops `agentconnect-admin` and
    // the session shows no administration tools at all.
    const init = await remoteMethod({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adapter', version: '0.0.0' } }
    })
    expect(init.statusCode).toBe(200)
    const initialized = mcpMessage(init).result as {
      serverInfo?: { name?: string }
      capabilities?: { tools?: unknown }
    }
    expect(initialized.serverInfo?.name).toBe('agentconnect')
    expect(initialized.capabilities?.tools).toBeDefined()

    // The notification and keepalive complete the transport contract…
    expect((await remoteMethod({ method: 'notifications/initialized' })).statusCode).toBeLessThan(300)
    expect((await remoteMethod({ id: 2, method: 'ping' })).statusCode).toBe(200)

    // …and the handshake grants nothing beyond it: the catalog still comes from the
    // authorized invocation path, and an off-catalog method is still refused.
    const listed = await remoteMethod({ id: 3, method: 'tools/list' })
    expect(listed.statusCode).toBe(200)
    expect((mcpMessage(listed).result as { tools: Array<{ name: string }> }).tools.length).toBeGreaterThan(0)

    const off = await remoteMethod({ id: 4, method: 'resources/list' })
    expect(off.statusCode).toBe(401)
    expect(off.headers['www-authenticate']).toBeUndefined()
  })

  it('admits handshake and catalog before the daemon registers the session, but holds tools/call', async () => {
    // The adapter connects DURING session/new; the daemon can register the session
    // (currentSessionId → session_meta) only after that call returns. initialize and
    // the immediate tools/list must not lose that race — adapters do not retry a
    // failed connect, so a denial here kills `agentconnect-admin` for the whole
    // session lifetime.
    const { remoteMethod, remoteRpc } = await delegatedFixture({ registerSession: false })

    const init = await remoteMethod({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adapter', version: '0.0.0' } }
    })
    expect(init.statusCode).toBe(200)
    expect((await remoteMethod({ method: 'notifications/initialized' })).statusCode).toBeLessThan(300)

    const listed = await remoteMethod({ id: 2, method: 'tools/list' })
    expect(listed.statusCode).toBe(200)
    expect((mcpMessage(listed).result as { tools: Array<{ name: string }> }).tools.length).toBeGreaterThan(0)

    // The authority-wielding step still fails closed until a private current
    // session exists.
    const call = await remoteRpc(3, 'listAgents', {})
    expect(call.statusCode).toBe(401)
    expect(call.headers['www-authenticate']).toBeUndefined()
  })

  // A pool agent names no machine of its own: `agent.daemonId` is null and the member serving it
  // is whoever holds its duty. Reading the column here refused every entitlement (#1028).
  it('entitles a pool agent through its duty holder rather than a placement column', async () => {
    const { hostAgentId, remoteRpc } = await delegatedFixture({ pool: true })

    const read = await remoteRpc(1, 'listAgents', {})
    expect(read.statusCode).toBe(200)
    expect(toolText(mcpMessage(read).result as unknown as ToolCallResult)).toContain(hostAgentId)
  })

  it('keeps a pool agent delegation across a rollout that retires and replaces the holder', async () => {
    const fixture = await delegatedFixture({ pool: true })
    const { daemonId, hostAgentId, liveDaemons, remoteRpc } = fixture
    expect((await remoteRpc(1, 'listAgents', {})).statusCode).toBe(200)

    // The reaper deletes the retired member's row. The delegation used to cascade away with it.
    await prisma.dutyGroup.deleteMany({ where: { holder: daemonId } })
    await prisma.daemon.delete({ where: { id: daemonId } })
    liveDaemons.delete(daemonId)
    expect(await prisma.webchatMcpDelegation.count({ where: { agentId: hostAgentId, revokedAt: null } })).toBe(1)
    // Nothing serves the agent for the handoff window, so the grant is refused rather than honored.
    expect((await remoteRpc(2, 'listAgents', {})).statusCode).toBe(401)

    const replacement = randomUUID()
    await fixture.seedPoolMember(replacement, hostAgentId)
    liveDaemons.add(replacement)

    // Same authority, same grant token: the new holder redeems it without a fresh browser dial.
    expect((await remoteRpc(3, 'listAgents', {})).statusCode).toBe(200)
  })

  it('keeps denying tools/call while the current session is not private', async () => {
    const { conversationId, remoteMethod, remoteRpc } = await delegatedFixture()
    await prisma.sessionMeta.update({
      where: { id: `webchat-${conversationId}` },
      data: { visibility: 'org' }
    })

    // The static catalog stays listable — it carries no org-scoped data…
    const listed = await remoteMethod({ id: 1, method: 'tools/list' })
    expect(listed.statusCode).toBe(200)

    // …but no tool executes against a widened session.
    const call = await remoteRpc(2, 'listAgents', {})
    expect(call.statusCode).toBe(401)
  })

  it('refuses the handshake once the grant is revoked — no anonymous transport', async () => {
    const { remoteMethod, credential } = await delegatedFixture()
    await prisma.webchatMcpAccessGrant.updateMany({
      where: { tokenHash: credential.tokenHash },
      data: { revokedAt: new Date(), status: 'revoked' }
    })
    const init = await remoteMethod({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'adapter', version: '0.0.0' } }
    })
    expect(init.statusCode).toBe(401)
  })

  it('executes reads directly but holds writes until the conversation owner approves', async () => {
    const fixture = await delegatedFixture()
    const { app, hostAgentId, remoteRpc, decisionPath: path } = fixture

    const read = await remoteRpc(1, 'listAgents', {})
    expect(read.statusCode).toBe(200)
    expect(toolText(mcpMessage(read).result as unknown as ToolCallResult)).toContain(hostAgentId)

    const write = await remoteRpc(2, 'createAgent', { name: 'approved-agent', runtime: 'codex' })
    expect(write.statusCode).toBe(200)
    const pending = JSON.parse(toolText(mcpMessage(write).result as unknown as ToolCallResult)) as {
      status: string
      operationId: string
    }
    expect(pending.status).toBe('awaiting_confirmation')
    expect(await prisma.agent.findFirst({ where: { orgId: DEFAULT_ORG_ID, name: 'approved-agent' } })).toBeNull()

    const listed = await app.app.inject({ method: 'GET', url: path })
    expect(listed.statusCode).toBe(200)
    expect(listed.json()).toMatchObject([{ operationId: pending.operationId, toolName: 'createAgent' }])
    const approved = await app.app.inject({
      method: 'POST',
      url: `${path}/${pending.operationId}/decision`,
      payload: { decision: 'approve' }
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ operationId: pending.operationId, status: 'completed' })
    expect(await prisma.agent.findFirst({ where: { orgId: DEFAULT_ORG_ID, name: 'approved-agent' } })).not.toBeNull()
  })

  it('commits a cp_db tool mutation atomically with its terminal transition', async () => {
    const fixture = await delegatedFixture()
    const operationId = await pendingWrite(fixture, 3, 'renameDaemon', {
      daemonId: fixture.daemonId,
      name: 'renamed-in-one-tx'
    })

    const approved = await fixture.app.app.inject({
      method: 'POST',
      url: `${fixture.decisionPath}/${operationId}/decision`,
      payload: { decision: 'approve' }
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ operationId, status: 'completed' })
    expect((await prisma.daemon.findUnique({ where: { id: fixture.daemonId } }))?.name).toBe('renamed-in-one-tx')
    const row = await prisma.webchatMcpOperation.findUnique({ where: { id: operationId } })
    expect(row?.status).toBe('completed')
  })

  it('rolls a cp_db mutation back when the attempt-fenced completion is lost', async () => {
    const fixture = await delegatedFixture()
    const before = (await prisma.daemon.findUnique({ where: { id: fixture.daemonId } }))?.name
    const operationId = await pendingWrite(fixture, 4, 'renameDaemon', {
      daemonId: fixture.daemonId,
      name: 'must-not-commit'
    })

    // Simulate a concurrent terminal transition (e.g. the reaper marking the
    // claim ambiguous) landing between the claim and the completion: the
    // attempt-fenced complete() reports a lost fence, and the §8 shared
    // transaction must roll the already-executed rename back with it.
    const operations = fixture.app.deps.repos.webchatMcpOperation
    const realComplete = operations.complete.bind(operations)
    let intercepted = false
    operations.complete = async (input) => {
      if (!intercepted) {
        intercepted = true
        return false
      }
      return realComplete(input)
    }
    try {
      const approved = await fixture.app.app.inject({
        method: 'POST',
        url: `${fixture.decisionPath}/${operationId}/decision`,
        payload: { decision: 'approve' }
      })
      expect(approved.statusCode).toBe(409)
      expect(approved.json()).toMatchObject({ message: 'operation is no longer executing' })
    } finally {
      operations.complete = realComplete
    }
    expect(intercepted).toBe(true)
    // The nested REST mutation ran inside the shared transaction and must have
    // been rolled back — this is the §8 atomicity guarantee under test.
    expect((await prisma.daemon.findUnique({ where: { id: fixture.daemonId } }))?.name).toBe(before)
  })
})

describe('POST /api/v1/mcp — protocol', () => {
  it('keeps the public /v1/mcp alias on the ordinary personal-key path', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    const res = await app.app.inject({
      method: 'POST',
      url: '/v1/mcp',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json'
      },
      payload: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: INIT_PARAMS }))
    })
    expect(res.statusCode).toBe(200)
    expect((mcpMessage(res).result as { serverInfo?: { name?: string } }).serverInfo?.name).toBe('agentconnect')
  })

  it('initialize returns the agentconnect server info and tool capability', async () => {
    const app = build({ PUBLIC_WEB_URL: 'https://console.example.test' })
    const { key } = await makeUserWithKey('collaborator')
    const res = await rpc(app, key, 'initialize', INIT_PARAMS)
    expect(res.statusCode).toBe(200)
    const body = mcpMessage(res)
    const result = body.result as {
      serverInfo?: {
        name: string
        icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>
      }
      capabilities?: { tools?: object }
    }
    expect(result.serverInfo).toMatchObject({
      name: 'agentconnect',
      icons: [
        {
          src: 'https://console.example.test/apple-icon.png',
          mimeType: 'image/png',
          sizes: ['512x512']
        }
      ]
    })
    expect(result.capabilities?.tools).toBeDefined()
  })

  it('tools/list publishes the read-only registry with JSON-Schema contracts', async () => {
    const app = build()
    const { key } = await makeUserWithKey('viewer')
    const res = await rpc(app, key, 'tools/list')
    expect(res.statusCode).toBe(200)
    const tools = mcpMessage(res).result!.tools as Array<{
      name: string
      inputSchema: { type: string }
    }>
    const names = tools.map((t) => t.name)
    for (const expected of ['whoami', 'listAgents', 'getAgent', 'listDaemons', 'listSessions', 'getUsage']) {
      expect(names).toContain(expected)
    }
    for (const t of tools) expect(t.inputSchema.type).toBe('object')
  })

  it('an unknown tool is a JSON-RPC error, not a tool result', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    const res = await rpc(app, key, 'tools/call', { name: 'dropDatabase', arguments: {} })
    expect(res.statusCode).toBe(200)
    expect(mcpMessage(res).error?.message).toContain('unknown tool')
  })
})

describe('POST /api/v1/mcp — tools act with the caller’s own authority', () => {
  it('whoami reports the key’s user and their role in the bound org', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    const out = await callTool(app, key, 'whoami')
    expect(out.isError).toBeUndefined()
    const parsed = JSON.parse(toolText(out)) as { user: { userId: string }; organization: { role: string } }
    expect(parsed.user.userId).toBe(userId)
    expect(parsed.organization.role).toBe('collaborator')
  })

  it('listAgents/getAgent respect per-resource visibility (restricted agent hidden from a non-granted collaborator)', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    const ownerKey = await mintKeyAs(DEFAULT_OWNER_ID)

    const visible = randomUUID()
    const restricted = randomUUID()
    await seedAgent(prisma, visible)
    await seedAgent(prisma, restricted, {
      visibility: 'restricted',
      sharedWith: [DEFAULT_OWNER_ID],
      createdByUserId: DEFAULT_OWNER_ID
    })

    // Non-granted collaborator: the restricted agent is invisible in list and reads 404 on get.
    const listed = JSON.parse(toolText(await callTool(app, key, 'listAgents'))) as Array<{ id: string }>
    const ids = listed.map((a) => a.id)
    expect(ids).toContain(visible)
    expect(ids).not.toContain(restricted)

    const denied = await callTool(app, key, 'getAgent', { agentId: restricted })
    expect(denied.isError).toBe(true)
    expect(toolText(denied)).toContain('404')

    // The resource's creator sees it through the same tool; organization role
    // alone would not widen visibility.
    const ownerIds = (JSON.parse(toolText(await callTool(app, ownerKey, 'listAgents'))) as Array<{ id: string }>).map(
      (a) => a.id
    )
    expect(ownerIds).toContain(restricted)
  })

  it('invalid arguments are a tool error, not a crash', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    const out = await callTool(app, key, 'getAgent', {})
    expect(out.isError).toBe(true)
    expect(toolText(out)).toContain('Invalid arguments')
  })

  it('getUsage returns the aggregate shape', async () => {
    const app = build()
    const { key } = await makeUserWithKey('viewer')
    const out = await callTool(app, key, 'getUsage', { range: 'd1' })
    expect(out.isError).toBeUndefined()
    // The tool asked in days; the route answered about the window it resolved to.
    const parsed = JSON.parse(toolText(out)) as {
      from: string
      to: string
      totals: unknown
      agents: unknown[]
      sources: unknown[]
    }
    expect(Date.parse(parsed.to) - Date.parse(parsed.from)).toBe(24 * 60 * 60 * 1000)
    expect(parsed.agents).toEqual([])
    expect(parsed.sources).toEqual([])
  })

  it('a key of a user removed from the org stops granting MCP access (tenant boundary)', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    // The key is still live (not revoked/expired) — only the membership is gone.
    // The org-scope guard's live roleOf lookup is what must deny it.
    await prisma.membership.deleteMany({ where: { orgId: DEFAULT_ORG_ID, userId } })

    const who = await callTool(app, key, 'whoami')
    expect(who.isError).toBe(true)
    expect(toolText(who)).toContain('404')

    const agents = await callTool(app, key, 'listAgents')
    expect(agents.isError).toBe(true)
    expect(toolText(agents)).toContain('404')
  })

  it('every registered tool reaches a real route — a REST path/param rename cannot ship green', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    // Fixture args per tool: unknown ids yield a RESOURCE-level 404/400 ("agent
    // not found", "unknown agentId", …) from the handler — never a Fastify
    // route-level "Route GET:… not found", which is what a path/param rename
    // would produce. Write fixtures use unknown ids so nothing real mutates
    // (createAgent creates a throwaway agent — the DB resets per test).
    const idArgs: Record<string, Record<string, unknown>> = {
      getAgent: { agentId: randomUUID() },
      getCron: { cronId: randomUUID() },
      listCronRuns: { cronId: randomUUID() },
      getSession: { sessionId: randomUUID() },
      listAgentHooks: { agentId: randomUUID() },
      listHookRuns: { hookId: randomUUID() },
      createAgent: { name: `reach-${randomUUID()}`, runtime: 'claude' },
      updateAgent: { agentId: randomUUID(), model: 'm' },
      deleteAgent: { agentId: randomUUID(), confirm: 'x' },
      renameDaemon: { daemonId: randomUUID(), name: 'edge' },
      upsertCron: { agentId: randomUUID(), schedule: '0 9 * * *', timezone: 'UTC', trigger: 't' },
      runCron: { cronId: randomUUID() },
      deleteCron: { cronId: randomUUID(), confirm: 'x' },
      setChannelTrigger: { integrationId: randomUUID(), channelId: 'C1', trigger: 'any' },
      removeIntegration: { integrationId: randomUUID(), confirm: 'x' }
    }
    for (const tool of MCP_TOOLS) {
      const out = await callTool(app, key, tool.name, idArgs[tool.name])
      if (out.isError) {
        expect(toolText(out), `${tool.name} hit a route-level 404 (route drift)`).not.toContain('Route ')
      }
    }
  })
})

describe('POST /api/v1/mcp — audit', () => {
  it('every tools/call lands one mcp_tool_call audit row (actor, org, tool, status)', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    await callTool(app, key, 'listAgents')
    await callTool(app, key, 'getAgent', { agentId: randomUUID() }) // 404 → still audited

    const rows = await prisma.auditEvent.findMany({ where: { kind: 'mcp_tool_call' }, orderBy: { id: 'asc' } })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.orgId).toBe(DEFAULT_ORG_ID)
      expect(row.actorUserId).toBe(userId)
    }
    expect((rows[0]!.details as { tool: string }).tool).toBe('listAgents')
    expect((rows[0]!.details as { status: number }).status).toBe(200)
    expect((rows[1]!.details as { tool: string }).tool).toBe('getAgent')
    expect((rows[1]!.details as { status: number }).status).toBe(404)
  })

  it('a rejected call (invalid arguments) is still audited with status invalid_arguments', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    await callTool(app, key, 'getAgent', {}) // missing required agentId → schema-rejected

    const rows = await prisma.auditEvent.findMany({ where: { kind: 'mcp_tool_call' } })
    expect(rows).toHaveLength(1)
    expect((rows[0]!.details as { tool: string }).tool).toBe('getAgent')
    expect((rows[0]!.details as { status: string }).status).toBe('invalid_arguments')
  })
})

describe('POST /api/v1/mcp — write tools (P1, §6.2 ✎)', () => {
  it('createAgent → updateAgent → deleteAgent round-trip, with the §6.4 confirm gate holding the door', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')

    const created = await callTool(app, key, 'createAgent', {
      name: 'mcp-made',
      runtime: 'claude',
      displayName: 'MCP Made'
    })
    expect(created.isError).toBeUndefined()
    const agent = JSON.parse(toolText(created)) as { id: string; name: string; displayName: string | null }
    expect(agent.name).toBe('mcp-made')
    expect(agent.displayName).toBe('MCP Made')

    const updated = await callTool(app, key, 'updateAgent', { agentId: agent.id, model: 'test-model', pause: true })
    expect(updated.isError).toBeUndefined()
    const patched = JSON.parse(toolText(updated)) as { model: string | null }
    expect(patched.model).toBe('test-model')

    // The write landed one mcp_tool_call audit row per call, statuses from the REST surface.
    const audits = await prisma.auditEvent.findMany({ where: { kind: 'mcp_tool_call' }, orderBy: { id: 'asc' } })
    expect(audits.map((r) => (r.details as { tool: string; status: number }).status)).toEqual([201, 200])

    // Wrong confirm (the displayName, not the slug): blocked at 412, agent untouched.
    const blocked = await callTool(app, key, 'deleteAgent', { agentId: agent.id, confirm: 'MCP Made' })
    expect(blocked.isError).toBe(true)
    expect(toolText(blocked)).toContain('confirmation mismatch')
    expect((await callTool(app, key, 'getAgent', { agentId: agent.id })).isError).toBeUndefined()

    // Exact slug: the delete goes through and the agent is gone.
    const gone = await callTool(app, key, 'deleteAgent', { agentId: agent.id, confirm: 'mcp-made' })
    expect(gone.isError).toBeUndefined()
    expect(toolText(gone)).toBe('OK (HTTP 204)')
    expect((await callTool(app, key, 'getAgent', { agentId: agent.id })).isError).toBe(true)
  })

  it('upsertCron creates against an agent, edits in place, and deleteCron confirms by name', async () => {
    const app = build()
    const { key } = await makeUserWithKey('collaborator')
    const agentId = randomUUID()
    await seedAgent(prisma, agentId)

    const created = await callTool(app, key, 'upsertCron', {
      agentId,
      name: 'daily-digest',
      schedule: '0 9 * * *',
      // Required: the tool refuses to let a schedule inherit a clock nobody chose.
      timezone: 'Asia/Shanghai',
      trigger: 'post the digest',
      enabled: false
    })
    expect(created.isError).toBeUndefined()
    const cron = JSON.parse(toolText(created)) as {
      id: string
      name: string | null
      enabled: boolean
      timezone: string
    }
    expect(cron.name).toBe('daily-digest')
    expect(cron.enabled).toBe(false)
    // The zone the caller stated is the zone that gets stored — never the CP process's own.
    expect(cron.timezone).toBe('Asia/Shanghai')

    const edited = await callTool(app, key, 'upsertCron', {
      cronId: cron.id,
      agentId,
      name: 'daily-digest',
      schedule: '0 10 * * *',
      timezone: 'Asia/Shanghai',
      trigger: 'post the digest',
      enabled: true
    })
    expect(edited.isError).toBeUndefined()
    expect((JSON.parse(toolText(edited)) as { id: string }).id).toBe(cron.id)

    const blocked = await callTool(app, key, 'deleteCron', { cronId: cron.id, confirm: 'daily' })
    expect(blocked.isError).toBe(true)
    expect(toolText(blocked)).toContain('confirmation mismatch')

    const gone = await callTool(app, key, 'deleteCron', { cronId: cron.id, confirm: 'daily-digest' })
    expect(gone.isError).toBeUndefined()
    expect((await callTool(app, key, 'getCron', { cronId: cron.id })).isError).toBe(true)
  })

  it('a viewer’s write is refused by the REST role gate (403 through the tool)', async () => {
    const app = build()
    const { key } = await makeUserWithKey('viewer')
    const out = await callTool(app, key, 'createAgent', { name: 'nope', runtime: 'claude' })
    expect(out.isError).toBe(true)
    expect(toolText(out)).toContain('403')
  })
})

describe('POST /api/v1/mcp — scope confinement (§6.3)', () => {
  /** Confine the user's personal key to the given scopes — the shape an OAuth
   *  access token carries after browser consent. */
  async function confineScopes(userId: string, scopes: string[]): Promise<void> {
    await prisma.apiKey.updateMany({ where: { userId }, data: { scopes } })
  }

  it('an mcp:read token neither sees nor reaches write tools; reads keep working', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    await confineScopes(userId, ['mcp:read'])

    const res = await rpc(app, key, 'tools/list')
    const names = (mcpMessage(res).result!.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('listAgents')
    expect(names).not.toContain('createAgent')
    expect(names).not.toContain('deleteAgent')

    const refused = await callTool(app, key, 'createAgent', { name: 'nope', runtime: 'claude' })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain('read-only')

    expect((await callTool(app, key, 'listAgents')).isError).toBeUndefined()
    // Nothing was created.
    expect(await prisma.agent.count({ where: { name: 'nope' } })).toBe(0)
  })

  it('an mcp:write token sees the full catalog and its writes go through', async () => {
    const app = build()
    const { userId, key } = await makeUserWithKey('collaborator')
    await confineScopes(userId, ['mcp:read', 'mcp:write'])

    const res = await rpc(app, key, 'tools/list')
    const names = (mcpMessage(res).result!.tools as Array<{ name: string }>).map((t) => t.name)
    expect(names).toContain('createAgent')

    const out = await callTool(app, key, 'createAgent', { name: 'scoped-write', runtime: 'claude' })
    expect(out.isError).toBeUndefined()
  })
})

describe('POST /api/v1/mcp — rate limits (§6.5)', () => {
  it('the write budget refuses the excess write; reads keep flowing; refusals are not audited', async () => {
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      mcpRateLimit: new McpRateLimiter(systemClock, { total: 10, write: 2, windowMs: 60_000 })
    })
    opened.push(app)
    const { key } = await makeUserWithKey('collaborator')

    // Two admitted writes (they 404 downstream — admission is what counts) …
    for (let i = 0; i < 2; i++) {
      const out = await callTool(app, key, 'renameDaemon', { daemonId: randomUUID(), name: 'x' })
      expect(toolText(out)).toContain('404')
    }
    // … the third write is refused by the limiter, with a retry horizon.
    const refused = await callTool(app, key, 'renameDaemon', { daemonId: randomUUID(), name: 'x' })
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toMatch(/Rate limit exceeded.*retry in \d+s/)

    // Reads still have headroom.
    expect((await callTool(app, key, 'listAgents')).isError).toBeUndefined()

    // The refused call did no downstream work: 2 writes + 1 read audited, nothing more.
    expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(3)
  })

  it('the total budget caps reads too', async () => {
    const app = buildHttpApp(prisma, undefined, undefined, undefined, {
      mcpRateLimit: new McpRateLimiter(systemClock, { total: 3, write: 2, windowMs: 60_000 })
    })
    opened.push(app)
    const { key } = await makeUserWithKey('collaborator')
    for (let i = 0; i < 3; i++) expect((await callTool(app, key, 'listAgents')).isError).toBeUndefined()
    const refused = await callTool(app, key, 'listAgents')
    expect(refused.isError).toBe(true)
    expect(toolText(refused)).toContain('Rate limit exceeded')
  })
})
