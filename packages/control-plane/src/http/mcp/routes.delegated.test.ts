import Fastify, { type FastifyInstance } from 'fastify'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvocationAssertionClaimResult, InvocationContext } from './invocation-authenticator.js'
import { InternalInvocationAuth } from './internal-invocation-auth.js'
import { mcpRoutes } from './routes.js'
import type { HttpDeps } from '../deps.js'
import { FakeClock } from '../../../test/fakes/fake-clock.js'
import {
  MCP_INVOCATION_EXECUTION_TIMEOUT_MS,
  MCP_INVOCATION_MAX_RESPONSE_BYTES
} from '../../persistence/repositories/mcp-invocation.repo.js'

const ASSERTION = `ac_mcp_assert_v1_${'a'.repeat(43)}`
const ASSERTION_DENIAL_BYTES = Buffer.from(
  JSON.stringify({ error: 'Unauthorized', statusCode: 401, message: 'invocation assertion denied' })
)
const INVOCATION_ID = '11111111-1111-4111-8111-111111111111'
const CONTEXT: InvocationContext = {
  invocationId: INVOCATION_ID,
  delegationId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  agentId: '44444444-4444-4444-8444-444444444444',
  daemonId: '55555555-5555-4555-8555-555555555555',
  orgId: 'org-1',
  userId: 'user-1',
  startedAt: new Date('2026-07-30T00:00:00.000Z')
}

interface Harness {
  app: FastifyInstance
  clock: FakeClock
  claim: ReturnType<typeof vi.fn>
  complete: ReturnType<typeof vi.fn>
  markAmbiguous: ReturnType<typeof vi.fn>
  rateCheck: ReturnType<typeof vi.fn>
  audits: Array<Record<string, unknown>>
  nested: ReturnType<typeof vi.fn>
  internalInvocationAuth: InternalInvocationAuth
  issue: ReturnType<typeof vi.spyOn>
}

const opened: FastifyInstance[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

function harness(claimResult: InvocationAssertionClaimResult = { kind: 'execute', context: CONTEXT }): Harness {
  const app = Fastify()
  opened.push(app)
  const clock = new FakeClock(Date.parse('2026-07-30T00:00:00.000Z'))
  const internalInvocationAuth = new InternalInvocationAuth()
  const issue = vi.spyOn(internalInvocationAuth, 'issue')
  const claim = vi.fn(async () => claimResult)
  const complete = vi.fn(async () => true)
  const markAmbiguous = vi.fn(async () => true)
  const rateCheck = vi.fn(() => null)
  const audits: Array<Record<string, unknown>> = []
  const nested = vi.fn(async () => [{ id: 'visible-agent' }])

  app.decorate('humanAuth', async (req, reply) => {
    if (internalInvocationAuth.authorizeInjectedRequest(req)) return
    return reply.code(401).send({ error: 'Unauthorized' })
  })
  app.get('/api/v1/orgs/org-1/agents', { preHandler: app.humanAuth }, async (req) => {
    expect(req.principal?.userId).toBe(CONTEXT.userId)
    expect(req.apiKeyOrgId).toBe(CONTEXT.orgId)
    expect(req.delegatedInvocation).toMatchObject({
      invocationId: CONTEXT.invocationId,
      delegationId: CONTEXT.delegationId,
      agentId: CONTEXT.agentId,
      conversationId: CONTEXT.conversationId
    })
    return nested()
  })

  const deps = {
    clock,
    repos: {
      audit: { append: async (event: Record<string, unknown>) => void audits.push(event) },
      mcpInvocation: { complete, markAmbiguous }
    },
    invocationAssertions: { claim },
    internalInvocationAuth,
    mcpRateLimit: { check: rateCheck },
    config: {}
  } as unknown as HttpDeps
  void app.register(mcpRoutes(deps), { prefix: '/api/v1' })
  return { app, clock, claim, complete, markAmbiguous, rateCheck, audits, nested, internalInvocationAuth, issue }
}

const rawRequest = (id = 1): Buffer =>
  Buffer.from(`{"jsonrpc":"2.0","id":${id},"method":"tools/call","params":{"name":"listAgents","arguments":{}}}`)

async function post(h: Harness, body = rawRequest()) {
  await h.app.ready()
  return h.app.inject({
    method: 'POST',
    url: '/api/v1/mcp',
    headers: {
      authorization: `Bearer ${ASSERTION}`,
      'x-agentconnect-invocation-id': INVOCATION_ID,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    },
    payload: body
  })
}

function mcpPayload(body: string): Record<string, unknown> {
  const dataLine = body.split(/\r?\n/).find((line) => line.startsWith('data:'))
  return JSON.parse(dataLine ? dataLine.slice(dataLine.indexOf(':') + 1).trim() : body) as Record<string, unknown>
}

async function socketRequest(
  app: FastifyInstance,
  path: string,
  method: 'GET' | 'POST',
  headers: string[],
  body?: Buffer
): Promise<{ statusCode: number; body: Buffer }> {
  const address = app.server.listening
    ? (() => {
        const bound = app.server.address()
        if (!bound || typeof bound === 'string') throw new Error('expected TCP test address')
        return `http://127.0.0.1:${bound.port}`
      })()
    : await app.listen({ host: '127.0.0.1', port: 0 })
  return new Promise((resolve, reject) => {
    const host = new URL(address).host
    const req = httpRequest(
      address + path,
      {
        method,
        headers: [
          'Host',
          host,
          ...headers,
          ...(body ? ['Content-Length', String(body.byteLength)] : []),
          'Connection',
          'close'
        ]
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      }
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('delegated POST /api/v1/mcp', () => {
  it('claims exact raw bytes before parsing and executes through one-time internal authority', async () => {
    const h = harness()
    const body = Buffer.concat([rawRequest(), Buffer.from(' \r\n')])

    const res = await post(h, body)

    expect(res.statusCode).toBe(200)
    expect(h.claim).toHaveBeenCalledOnce()
    const input = h.claim.mock.calls[0]![0] as {
      bearer: string
      invocationId: string
      requestBytes: Uint8Array
      parseMetadata(): unknown
    }
    expect(input.bearer).toBe(ASSERTION)
    expect(input.invocationId).toBe(INVOCATION_ID)
    expect(Buffer.from(input.requestBytes)).toEqual(body)
    expect(input.parseMetadata()).toEqual({ method: 'tools/call', toolName: 'listAgents' })
    expect(h.nested).toHaveBeenCalledOnce()
    expect(h.complete).toHaveBeenCalledOnce()
    const completion = h.complete.mock.calls[0]![0] as { responseBytes: Uint8Array; status: string }
    expect(completion.status).toBe('succeeded')
    expect(Buffer.from(completion.responseBytes)).toEqual(res.rawPayload)
  })

  it('renders every assertion denial identically without parsing or touching dispatch, audit, or rate limit', async () => {
    const denials: Array<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> =
      []
    for (const reason of ['assertion_unknown', 'request_hash_mismatch'] as const) {
      const h = harness({ kind: 'denied', reason })
      const res = await post(h, Buffer.from([0xff, 0x00, 0x7b]))
      denials.push({ statusCode: res.statusCode, headers: res.headers, body: res.rawPayload })
      const input = h.claim.mock.calls[0]![0] as { parseMetadata(): unknown }
      expect(h.nested).not.toHaveBeenCalled()
      expect(h.complete).not.toHaveBeenCalled()
      expect(h.rateCheck).not.toHaveBeenCalled()
      expect(h.audits).toEqual([])
      expect(res.headers['www-authenticate']).toBeUndefined()
      expect(() => input.parseMetadata()).toThrow()
    }
    expect(denials[0]).toEqual(denials[1])
  })

  it('replays completed bytes exactly and reports running or ambiguous without executing', async () => {
    const cached = Buffer.from('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
    const completed = harness({
      kind: 'completed',
      invocationStatus: 'succeeded',
      responseStatus: 207,
      responseBytes: cached
    })
    const completedRes = await post(completed)
    expect(completedRes.statusCode).toBe(207)
    expect(completedRes.rawPayload).toEqual(cached)
    expect(completedRes.headers['content-type']).toBe('text/event-stream')
    expect(completed.nested).not.toHaveBeenCalled()

    const running = harness({ kind: 'in_progress', retryAfterMs: 250 })
    const runningRes = await post(running)
    expect(runningRes.statusCode).toBe(409)
    expect(runningRes.headers['retry-after']).toBeDefined()
    expect(runningRes.body.length).toBeLessThan(1024)
    expect(running.nested).not.toHaveBeenCalled()

    const ambiguous = harness({ kind: 'ambiguous' })
    const ambiguousRes = await post(ambiguous)
    expect(ambiguousRes.statusCode).toBe(409)
    expect(ambiguousRes.body).toContain('may have taken effect')
    expect(ambiguousRes.body.length).toBeLessThan(1024)
    expect(ambiguous.nested).not.toHaveBeenCalled()
  })

  it('uses the delegated user and delegation as the rate key and writes only bounded assertion audit metadata', async () => {
    const h = harness()
    const res = await post(h)
    expect(res.statusCode).toBe(200)
    expect(h.rateCheck).toHaveBeenCalledWith(`${CONTEXT.userId}:${CONTEXT.delegationId}`, false)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({
      orgId: CONTEXT.orgId,
      actorUserId: CONTEXT.userId,
      details: {
        principalType: 'webchat_assertion',
        invocationId: CONTEXT.invocationId,
        delegationId: CONTEXT.delegationId,
        agentId: CONTEXT.agentId,
        conversationId: CONTEXT.conversationId,
        tool: 'listAgents',
        args: {},
        status: 200
      }
    })
    expect(JSON.stringify(h.audits[0])).not.toMatch(/assert_v1|requestBytes|responseBytes|authorization/)
  })

  it('marks only this invocation ambiguous at the exact outer timeout and ignores the late result', async () => {
    const h = harness()
    let release!: () => void
    h.nested.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ id: 'late' }])
        })
    )

    const pending = post(h)
    await vi.waitFor(() => expect(h.nested).toHaveBeenCalledOnce())
    h.clock.advance(MCP_INVOCATION_EXECUTION_TIMEOUT_MS - 1)
    expect(h.markAmbiguous).not.toHaveBeenCalled()
    h.clock.advance(1)
    const res = await pending

    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('may have taken effect')
    expect(h.markAmbiguous).toHaveBeenCalledWith(CONTEXT.invocationId, new Date(h.clock.now()))
    release()
    await vi.waitFor(() => expect(h.complete).toHaveBeenCalledOnce())
    expect(await h.markAmbiguous.mock.results[0]!.value).toBe(true)
  })

  it('uses the persisted claim start for the deadline and never waits for execution when timeout CAS loses', async () => {
    const startedAt = new Date(CONTEXT.startedAt.getTime() - 1_000)
    const h = harness({ kind: 'execute', context: { ...CONTEXT, startedAt } })
    h.markAmbiguous.mockResolvedValue(false)
    h.nested.mockImplementation(() => new Promise(() => undefined))

    const pending = post(h)
    await vi.waitFor(() => expect(h.nested).toHaveBeenCalledOnce())
    h.clock.advance(MCP_INVOCATION_EXECUTION_TIMEOUT_MS - 1_001)
    expect(h.markAmbiguous).not.toHaveBeenCalled()
    h.clock.advance(1)

    const res = await pending
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('may have taken effect')
    expect(h.markAmbiguous).toHaveBeenCalledOnce()
  })

  it('marks an oversized definite response ambiguous instead of returning or caching it', async () => {
    const h = harness()
    h.nested.mockResolvedValue('x'.repeat(MCP_INVOCATION_MAX_RESPONSE_BYTES + 1))

    const res = await post(h)

    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('may have taken effect')
    expect(res.body.length).toBeLessThan(1024)
    expect(h.markAmbiguous).toHaveBeenCalledWith(CONTEXT.invocationId, expect.any(Date))
    expect(h.complete).not.toHaveBeenCalled()
  })

  it('blocks delegated self update/delete before any nested REST request', async () => {
    for (const [name, args] of [
      ['updateAgent', { agentId: CONTEXT.agentId, model: 'forbidden' }],
      ['deleteAgent', { agentId: CONTEXT.agentId, confirm: 'host-agent' }]
    ] as const) {
      const h = harness()
      const body = Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args }
        })
      )
      const res = await post(h, body)
      const payload = mcpPayload(res.body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
      expect(payload.result?.isError).toBe(true)
      expect(payload.result?.content?.[0]?.text).toContain('403')
      expect(h.nested).not.toHaveBeenCalled()
      expect(h.issue).not.toHaveBeenCalled()
      expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    }
  })

  it('rejects duplicate Authorization or invocation-id fields from a real raw HTTP socket', async () => {
    for (const duplicated of ['authorization', 'invocation'] as const) {
      const h = harness()
      const body = rawRequest()
      const headers =
        duplicated === 'authorization'
          ? [
              'Authorization',
              `Bearer ${ASSERTION}`,
              'Authorization',
              `Bearer ${ASSERTION}`,
              'X-AgentConnect-Invocation-Id',
              INVOCATION_ID
            ]
          : [
              'Authorization',
              `Bearer ${ASSERTION}`,
              'X-AgentConnect-Invocation-Id',
              INVOCATION_ID,
              'X-AgentConnect-Invocation-Id',
              INVOCATION_ID
            ]
      const res = await socketRequest(
        h.app,
        '/api/v1/mcp',
        'POST',
        [...headers, 'Accept', 'application/json, text/event-stream', 'Content-Type', 'application/json'],
        body
      )
      expect(res.statusCode).toBe(401)
      expect(res.body).toEqual(ASSERTION_DENIAL_BYTES)
      expect(h.claim).not.toHaveBeenCalled()
    }
  })

  it('gives a copied internal nonce no authority over a real listening network socket', async () => {
    const h = harness()
    await h.app.listen({ host: '127.0.0.1', port: 0 })

    const status = await h.internalInvocationAuth.run(CONTEXT, async () => {
      const nonce = h.internalInvocationAuth.issue('GET', '/api/v1/orgs/org-1/agents')
      return (
        await socketRequest(h.app, '/api/v1/orgs/org-1/agents', 'GET', ['X-AgentConnect-Internal-Invocation', nonce!])
      ).statusCode
    })

    expect(status).toBe(401)
    expect(h.nested).not.toHaveBeenCalled()
  })
})
