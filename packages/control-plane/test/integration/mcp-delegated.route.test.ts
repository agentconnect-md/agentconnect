import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DELEGATED_MCP_ASSERTION_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER, type HttpApp } from '../fakes/build-http.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import { InvocationAssertionCodec } from '../../src/registry/invocationAssertion.js'
import {
  MCP_INVOCATION_EXECUTION_TIMEOUT_MS,
  PgMcpInvocationRepo
} from '../../src/persistence/repositories/mcp-invocation.repo.js'
import { PgWebchatMcpDelegationRepo } from '../../src/persistence/repositories/webchat-mcp-delegation.repo.js'
import { PgCronRepo } from '../../src/persistence/repositories/cron.repo.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { AgentId, CronId, DaemonId, OrgId } from '../../src/domain/ids.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type { HttpDeps } from '../../src/http/deps.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { FakeClock } from '../fakes/fake-clock.js'

const MCP_URL = '/api/v1/mcp'
const HOST_AGENT = 'a1111111-1111-4111-8111-111111111111'
const OTHER_AGENT = 'a2222222-2222-4222-8222-222222222222'
const HIDDEN_AGENT = 'a3333333-3333-4333-8333-333333333333'
const DAEMON = 'd1111111-1111-4111-8111-111111111111'

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

interface DelegatedRequest {
  app: HttpApp
  assertion: string
  invocationId: string
  delegationId: string
  conversationId: string
  userId: string
  body: Buffer
}

function rpcBody(name: string, args: Record<string, unknown> = {}, id = 1): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }))
}

async function userFor(role: OrgMemberRole): Promise<string> {
  if (role === 'owner') return DEFAULT_OWNER_ID
  const sub = `delegated-${role}-${randomUUID()}`
  const email = `${sub}@acme.dev`
  const users = new PgUserRepo(prisma)
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function delegated(
  role: OrgMemberRole,
  body: Buffer,
  options: { control?: ControlSender; depsOverrides?: Partial<HttpDeps> } = {}
): Promise<DelegatedRequest> {
  const userId = await userFor(role)
  await seedDaemon(prisma, DAEMON)
  await seedAgent(prisma, HOST_AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, OTHER_AGENT, { daemonId: DAEMON })
  await seedAgent(prisma, HIDDEN_AGENT, {
    daemonId: DAEMON,
    visibility: 'restricted',
    createdByUserId: DEFAULT_OWNER_ID
  })
  await prisma.presetAgent.create({
    data: { orgId: DEFAULT_ORG_ID, preset: 'general', agentId: HOST_AGENT, status: 'created' }
  })
  const conversationId = randomUUID()
  await prisma.webchatConversation.create({
    data: { id: conversationId, orgId: DEFAULT_ORG_ID, agentId: HOST_AGENT, userId }
  })
  const now = new Date()
  const delegation = await new PgWebchatMcpDelegationRepo(prisma).establish({
    conversationId,
    userId,
    orgId: OrgId(DEFAULT_ORG_ID),
    agentId: AgentId(HOST_AGENT),
    daemonId: DaemonId(DAEMON),
    now,
    expiresAt: new Date(now.getTime() + 60_000)
  })
  if (!delegation) throw new Error('delegation fixture was not established')
  const invocationId = randomUUID()
  const codec = new InvocationAssertionCodec(TEST_API_KEY_PEPPER)
  const assertion = codec.mint()
  const method = JSON.parse(body.toString('utf8')) as { params: { name: string } }
  const minted = await new PgMcpInvocationRepo(prisma).mint({
    invocationId,
    delegationId: delegation.id,
    assertionHash: assertion.persistence.assertionHash,
    requestHash: createHash('sha256').update(body).digest('hex'),
    method: 'tools/call',
    toolName: method.params.name,
    assertionExpires: new Date(now.getTime() + 30_000),
    mintedAt: now
  })
  expect(minted.kind).toBe('issued')

  const liveness: DaemonLiveness = {
    get: (daemonId) =>
      daemonId === DAEMON
        ? {
            reachable: true,
            state: 'READY',
            sessionEpoch: 1,
            capabilities: { features: [DELEGATED_MCP_ASSERTION_FEATURE] }
          }
        : undefined
  }
  const app = buildHttpApp(prisma, undefined, liveness, options.control, options.depsOverrides)
  opened.push(app)
  return {
    app,
    assertion: assertion.plaintext,
    invocationId,
    delegationId: delegation.id,
    conversationId,
    userId,
    body
  }
}

async function socketGet(app: HttpApp, path: string, headers: Record<string, string>) {
  const address = app.app.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a listening TCP test server')
  const origin = `http://127.0.0.1:${address.port}`
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const req = httpRequest(origin + path, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function post(request: DelegatedRequest) {
  return request.app.app.inject({
    method: 'POST',
    url: MCP_URL,
    headers: {
      authorization: `Bearer ${request.assertion}`,
      'x-agentconnect-invocation-id': request.invocationId,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    payload: request.body
  })
}

function toolResult(body: string): { isError?: boolean; content: Array<{ text: string }> } {
  const line = body.split(/\r?\n/).find((part) => part.startsWith('data:'))
  const rpc = JSON.parse(line ? line.slice(line.indexOf(':') + 1).trim() : body) as {
    result: { isError?: boolean; content: Array<{ text: string }> }
  }
  return rpc.result
}

describe('delegated MCP route with durable assertions', () => {
  it.each([
    ['owner', false],
    ['collaborator', false],
    ['viewer', true]
  ] as const)('acts as the conversation %s through ordinary live RBAC', async (role, writeDenied) => {
    const request = await delegated(role, rpcBody('updateAgent', { agentId: OTHER_AGENT, model: `from-${role}` }))
    const res = await post(request)

    expect(res.statusCode).toBe(200)
    const result = toolResult(res.body)
    expect(result.isError === true).toBe(writeDenied)
    const other = await prisma.agent.findUniqueOrThrow({ where: { id: OTHER_AGENT } })
    const overrides = other.runtimeOverrides as { model?: string } | null
    expect(overrides?.model).toBe(writeDenied ? undefined : `from-${role}`)
  })

  it('preserves hidden-resource 404s without an existence oracle', async () => {
    const hidden = await delegated('collaborator', rpcBody('getAgent', { agentId: HIDDEN_AGENT }))
    const hiddenResult = toolResult((await post(hidden)).body)
    expect(hiddenResult.isError).toBe(true)
    expect(hiddenResult.content[0]!.text).toContain('404')
  })

  it('blocks host-agent mutation before nested dispatch', async () => {
    const host = await delegated('collaborator', rpcBody('updateAgent', { agentId: HOST_AGENT, model: 'forbidden' }))
    const hostResult = toolResult((await post(host)).body)
    expect(hostResult.isError).toBe(true)
    expect(hostResult.content[0]!.text).toContain('403')
    expect((await prisma.agent.findUniqueOrThrow({ where: { id: HOST_AGENT } })).runtimeOverrides).toBeNull()
  })

  it('blocks delegated deletion of the host agent on the durable route', async () => {
    const host = await delegated('collaborator', rpcBody('deleteAgent', { agentId: HOST_AGENT, confirm: 'irrelevant' }))
    const hostResult = toolResult((await post(host)).body)

    expect(hostResult.isError).toBe(true)
    expect(hostResult.content[0]!.text).toContain('403')
    expect(await prisma.agent.findUnique({ where: { id: HOST_AGENT } })).not.toBeNull()
  })

  it.each([
    ['updateAgent', { agentId: HOST_AGENT.toUpperCase(), model: 'uppercase-bypass' }],
    ['deleteAgent', { agentId: HOST_AGENT.toUpperCase(), confirm: 'agent-a111' }]
  ] as const)('treats an uppercase PostgreSQL UUID as the same host for %s', async (tool, args) => {
    const request = await delegated('collaborator', rpcBody(tool, args))
    const issue = vi.spyOn(request.app.deps.internalInvocationAuth, 'issue')
    const result = toolResult((await post(request)).body)

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('403')
    expect(issue).not.toHaveBeenCalled()
    const host = await prisma.agent.findUniqueOrThrow({ where: { id: HOST_AGENT } })
    expect(host.runtimeOverrides).toBeNull()
  })

  it('uses the delegated user and delegation as the admitted rate-limit key', async () => {
    const check = vi.fn(() => null)
    const request = await delegated('collaborator', rpcBody('listAgents'), {
      depsOverrides: { mcpRateLimit: { check } as unknown as HttpDeps['mcpRateLimit'] }
    })

    expect((await post(request)).statusCode).toBe(200)
    expect(check).toHaveBeenCalledWith(`${request.userId}:${request.delegationId}`, false)
  })

  it('returns an in-progress replay from the durable running row without executing again', async () => {
    const request = await delegated('collaborator', rpcBody('createAgent', { name: 'must-not-run', runtime: 'claude' }))
    await prisma.mcpInvocation.update({
      where: { id: request.invocationId },
      data: { status: 'running', startedAt: new Date() }
    })

    const res = await post(request)

    expect(res.statusCode).toBe(409)
    expect(res.headers['retry-after']).toBeDefined()
    expect(await prisma.agent.count({ where: { name: 'must-not-run' } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(0)
  })

  it('does not authorize a copied internal nonce over a real network socket', async () => {
    const request = await delegated('collaborator', rpcBody('listAgents'))
    await request.app.app.listen({ host: '127.0.0.1', port: 0 })
    const context = {
      invocationId: request.invocationId,
      delegationId: request.delegationId,
      conversationId: request.conversationId,
      agentId: HOST_AGENT,
      daemonId: DAEMON,
      orgId: DEFAULT_ORG_ID,
      userId: request.userId,
      startedAt: new Date()
    }

    const response = await request.app.deps.internalInvocationAuth.run(context, async () => {
      const nonce = request.app.deps.internalInvocationAuth.issue('GET', '/api/v1/me')
      expect(nonce).not.toBeNull()
      return socketGet(request.app, '/api/v1/me', {
        'x-agentconnect-internal-invocation': nonce!
      })
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({ userId: DEFAULT_OWNER_ID })
    expect(JSON.parse(response.body)).not.toMatchObject({ userId: request.userId })
  })

  it('marks the durable invocation ambiguous at the persisted 120-second deadline and returns before a hung call', async () => {
    const clock = new FakeClock(Date.now())
    let release!: () => void
    const cronRun = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true })
        })
    )
    const cronId = randomUUID()
    const request = await delegated('collaborator', rpcBody('runCron', { cronId }), {
      control: { cronRun } as unknown as ControlSender,
      depsOverrides: { clock }
    })
    await new PgCronRepo(prisma).upsert({
      cronId: CronId(cronId),
      orgId: OrgId(DEFAULT_ORG_ID),
      agentId: AgentId(HOST_AGENT),
      schedule: '0 9 * * *',
      timezone: 'UTC',
      trigger: 'deadline integration fixture'
    })

    const pending = post(request)
    await vi.waitFor(() => expect(cronRun).toHaveBeenCalledOnce())
    const running = await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })
    expect(running.status).toBe('running')
    const deadline = running.startedAt!.getTime() + MCP_INVOCATION_EXECUTION_TIMEOUT_MS
    clock.advance(deadline - clock.now() - 1)
    expect((await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })).status).toBe(
      'running'
    )
    clock.advance(1)

    const res = await pending
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('may have taken effect')
    expect((await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })).status).toBe(
      'ambiguous'
    )

    release()
    await vi.waitFor(async () => {
      expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(1)
      expect((await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })).status).toBe(
        'ambiguous'
      )
    })
  })

  it('keeps destructive confirmation and delegated audit metadata on the existing tool path', async () => {
    const request = await delegated(
      'collaborator',
      rpcBody('deleteAgent', { agentId: OTHER_AGENT, confirm: 'wrong-name' })
    )
    const result = toolResult((await post(request)).body)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('confirmation mismatch')
    expect(await prisma.agent.findUnique({ where: { id: OTHER_AGENT } })).not.toBeNull()

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'mcp_tool_call' } })
    expect(audit.actorUserId).toBe(request.userId)
    expect(audit.orgId).toBe(DEFAULT_ORG_ID)
    expect(audit.details).toEqual({
      principalType: 'webchat_assertion',
      invocationId: request.invocationId,
      delegationId: request.delegationId,
      agentId: HOST_AGENT,
      conversationId: request.conversationId,
      tool: 'deleteAgent',
      args: { agentId: OTHER_AGENT, confirm: 'wrong-name' },
      status: 412
    })
    expect(await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })).toMatchObject({
      status: 'failed',
      responseStatus: 200
    })
  })

  it('replays a duplicate write byte-for-byte and executes it once', async () => {
    const request = await delegated(
      'collaborator',
      rpcBody('createAgent', { name: `delegated-${randomUUID()}`, runtime: 'claude' })
    )
    const first = await post(request)
    const second = await post(request)

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.rawPayload).toEqual(first.rawPayload)
    expect(second.headers['content-type']).toBe(first.headers['content-type'])
    expect(await prisma.agent.count({ where: { name: { startsWith: 'delegated-' } } })).toBe(1)
    expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(1)
  })

  it('linearizes two concurrent POSTs so the delegated write executes at most once', async () => {
    const name = `delegated-concurrent-${randomUUID()}`
    const request = await delegated('collaborator', rpcBody('createAgent', { name, runtime: 'claude' }))

    const responses = await Promise.all([post(request), post(request)])

    expect(responses.some((response) => response.statusCode === 200)).toBe(true)
    expect(responses.every((response) => response.statusCode === 200 || response.statusCode === 409)).toBe(true)
    if (responses.every((response) => response.statusCode === 200)) {
      expect(responses[1]!.rawPayload).toEqual(responses[0]!.rawPayload)
    }
    expect(await prisma.agent.count({ where: { name } })).toBe(1)
    expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(1)
  })

  it('denies a byte-changed request before durable claim, tool dispatch, or audit', async () => {
    const request = await delegated('collaborator', rpcBody('createAgent', { name: 'must-not-run', runtime: 'claude' }))
    request.body = Buffer.concat([request.body, Buffer.from('\n')])

    const res = await post(request)

    expect(res.statusCode).toBe(401)
    expect(res.headers['www-authenticate']).toBeUndefined()
    expect(res.json()).toEqual({
      error: 'Unauthorized',
      statusCode: 401,
      message: 'invocation assertion denied'
    })
    expect(await prisma.agent.count({ where: { name: 'must-not-run' } })).toBe(0)
    expect(await prisma.auditEvent.count({ where: { kind: 'mcp_tool_call' } })).toBe(0)
    expect(await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: request.invocationId } })).toMatchObject({
      status: 'issued',
      startedAt: null
    })
  })

  it('does not teach ordinary REST humanAuth to accept invocation assertions', async () => {
    const request = await delegated('collaborator', rpcBody('listAgents'))
    const res = await request.app.app.inject({
      method: 'GET',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents`,
      headers: { authorization: `Bearer ${request.assertion}` }
    })
    expect(res.statusCode).toBe(401)
  })
})
