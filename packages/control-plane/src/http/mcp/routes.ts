/**
 * `http/mcp/routes.ts` — the AgentConnect MCP endpoint (docs/designs/
 * agent-assistant.md §6).
 *
 * Serves the Model Context Protocol over the MCP SDK **v2** web-standard
 * streamable-HTTP handler (`createMcpHandler().fetch(request)`), driven from Fastify
 * through a small Node↔Fetch adapter (no Express, no global middleware —
 * `app.inject` works). Mounted TWICE by `server.ts`: at the internal version root
 * (`/api/v1/mcp`, where an edge's `/v1` rewrite can land) and at the public
 * `/v1` alias (direct-hit deploys) — the URL users hand to MCP clients is the PUBLIC
 * form `<PUBLIC_CP_URL>/v1/mcp` (`MCP_PUBLIC_PATH`; RFC 9728 clients validate the PRM
 * `resource` against it byte-for-byte). A fresh stateless `Server` is built per POST.
 * Tool calls are executed by **injecting a real HTTP request into this same Fastify
 * instance** with the caller's own credential — RBAC, per-resource visibility, org
 * scoping, and DTO serialization are enforced by the existing routes, never
 * re-implemented here (§6.2).
 *
 * Auth: a personal API key or OAuth access token resolves through `humanAuth`. This
 * route alone also recognizes one-time webchat invocation assertions; after a durable
 * claim, nested REST requests receive fresh method/path-bound in-process nonces. Any
 * other caller gets a 401 whose `WWW-Authenticate` points at Protected Resource
 * Metadata — the OAuth browser-login discovery entrance (§7).
 *
 * P1 (§6.2 ✎/§6.3/§6.5): write tools ride the same inject path (POST/PATCH/PUT/DELETE
 * with a JSON body). Scope-confined credentials without `mcp:write` neither see nor
 * reach them; every tools/call is admitted through the shared per-credential rate
 * limiter (`deps.mcpRateLimit`) BEFORE any downstream work.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Server, createMcpHandler } from '@modelcontextprotocol/server'
import type { HttpDeps } from '../deps.js'
import { API_V1_PREFIX } from '../version.js'
import { OrgId } from '../../domain/ids.js'
import { MCP_TOOLS, findTool, toolDescriptor, type McpToolCtx, type RestResult } from './tools.js'
import { publicBaseUrl, mcpAuthenticateChallenge } from '../oauth/base.js'
import { INTERNAL_INVOCATION_AUTH_HEADER } from './internal-invocation-auth.js'
import type { InvocationContext, ParsedInvocationMetadata } from './invocation-authenticator.js'
import { MCP_INVOCATION_MAX_RESPONSE_BYTES } from '../../persistence/repositories/mcp-invocation.repo.js'
import { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../../domain/mcp-invocation.js'
import { INVOCATION_ASSERTION_PREFIX } from '../../registry/invocationAssertion.js'
import { defaultWebchatMcpMetrics, type WebchatMcpMetrics } from '../../observability/webchat-mcp.js'

export { MCP_INVOCATION_EXECUTION_TIMEOUT_MS } from '../../domain/mcp-invocation.js'

export const MCP_PATH = '/mcp'

const SERVER_INFO = { name: 'agentconnect', version: '1.0.0' }
const INVOCATION_ID_HEADER = 'x-agentconnect-invocation-id'

const ASSERTION_DENIED_BODY = Buffer.from(
  JSON.stringify({ error: 'Unauthorized', statusCode: 401, message: 'invocation assertion denied' })
)
const IN_PROGRESS_BODY = Buffer.from(
  JSON.stringify({ error: 'Conflict', statusCode: 409, message: 'invocation is already in progress' })
)
const AMBIGUOUS_BODY = Buffer.from(
  JSON.stringify({
    error: 'Conflict',
    statusCode: 409,
    message: 'the operation may have taken effect; inspect current state before retrying'
  })
)

interface McpWireResponse {
  statusCode: number
  headers: Headers
  bytes: Buffer
}

function rawHeaderValues(req: FastifyRequest, name: string): string[] {
  const values: string[] = []
  const target = name.toLowerCase()
  for (let i = 0; i < req.raw.rawHeaders.length; i += 2) {
    if (req.raw.rawHeaders[i]?.toLowerCase() === target) values.push(req.raw.rawHeaders[i + 1] ?? '')
  }
  return values
}

function bearerToken(authorization: string | undefined): string | null {
  const matched = authorization?.match(/^Bearer ([^\s]+)$/i)
  return matched?.[1] ?? null
}

function isInvocationAssertion(authorization: string | undefined): boolean {
  return bearerToken(authorization)?.startsWith(INVOCATION_ASSERTION_PREFIX) === true
}

function sendAssertionDenied(reply: FastifyReply) {
  return reply
    .header('cache-control', 'no-store')
    .header('content-type', 'application/json; charset=utf-8')
    .code(401)
    .send(ASSERTION_DENIED_BODY)
}

function sendInProgress(reply: FastifyReply, retryAfterMs: number) {
  return reply
    .header('cache-control', 'no-store')
    .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1_000))))
    .header('content-type', 'application/json; charset=utf-8')
    .code(409)
    .send(IN_PROGRESS_BODY)
}

function sendAmbiguous(reply: FastifyReply) {
  return reply
    .header('cache-control', 'no-store')
    .header('content-type', 'application/json; charset=utf-8')
    .code(409)
    .send(AMBIGUOUS_BODY)
}

function observeMetric(observe: () => void): void {
  try {
    observe()
  } catch {
    // Custom metric observers never participate in MCP execution.
  }
}

function invocationMetadata(bytes: Uint8Array): ParsedInvocationMetadata {
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
    method?: unknown
    params?: { name?: unknown }
  }
  if (parsed.method === 'tools/list') return { method: 'tools/list' }
  if (parsed.method === 'tools/call') {
    return {
      method: 'tools/call',
      ...(typeof parsed.params?.name === 'string' ? { toolName: parsed.params.name } : {})
    }
  }
  return { method: parsed.method as 'tools/list' | 'tools/call' }
}

function serverInfo(publicWebUrl?: string) {
  return {
    ...SERVER_INFO,
    ...(publicWebUrl
      ? {
          icons: [
            {
              src: new URL('/apple-icon.png', publicWebUrl).href,
              mimeType: 'image/png',
              sizes: ['512x512']
            }
          ]
        }
      : {})
  }
}

/** Serialized-args cap for the audit trail. The tool schemas take only ids / enums /
 *  small filters, so validated args are tiny; the cap bounds the UNvalidated args of a
 *  rejected call (arbitrary client JSON up to the body limit) so a crafted call can't
 *  bloat `audit_event.details` or dump a large pasted secret into the org audit trail. */
const AUDIT_ARGS_MAX = 512

function auditArgs(validated: Record<string, unknown> | undefined, raw: unknown): unknown {
  const value = validated ?? raw ?? {}
  const json = JSON.stringify(value) ?? 'null'
  if (json.length <= AUDIT_ARGS_MAX) return value
  return { _truncated: true, preview: json.slice(0, AUDIT_ARGS_MAX) }
}

function replayContentType(bytes: Uint8Array): string {
  const prefix = Buffer.from(bytes).subarray(0, 32).toString('utf8').trimStart()
  if (prefix.startsWith('event:')) return 'text/event-stream'
  if (prefix.startsWith('{') || prefix.startsWith('[')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

/** Pull the human-readable `message` out of a REST error body (falls back to raw). */
function restErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown }
    if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message
  } catch {
    /* not JSON — fall through */
  }
  return body.slice(0, 500)
}

export function mcpRoutes(deps: HttpDeps) {
  return async function mcpRoutesPlugin(app: FastifyInstance): Promise<void> {
    const webchatMetrics: Pick<WebchatMcpMetrics, 'invocation' | 'requestDuration'> =
      deps.webchatMcpMetrics ?? defaultWebchatMcpMetrics
    // The v2 handler reads the raw request body itself — pass the stream through
    // unparsed rather than letting Fastify's JSON parser consume it. Encapsulated to
    // this plugin (only the /mcp routes); the inject'd tool GETs hit other routes and
    // parse normally.
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    // Human/API-key failures carry the OAuth discovery challenge. Invocation assertions
    // are a narrow daemon credential, not OAuth, and deliberately get only the generic
    // denial body so clients cannot confuse an assertion rejection with re-auth.
    app.addHook('onSend', async (req, reply, payload) => {
      const assertionRequest = isInvocationAssertion(rawHeaderValues(req, 'authorization')[0])
      if (reply.statusCode === 401 && !assertionRequest && !reply.getHeader('www-authenticate')) {
        void reply.header('www-authenticate', mcpAuthenticateChallenge(publicBaseUrl(req, deps.config), deps.config))
      }
      return payload
    })

    // Assertion credentials are deliberately recognized only at this route. Every
    // other bearer still traverses the ordinary human/API-key authentication plane.
    const authenticateMcp = async (req: FastifyRequest, reply: FastifyReply) => {
      const authorizations = rawHeaderValues(req, 'authorization')
      const invocationIds = rawHeaderValues(req, INVOCATION_ID_HEADER)
      if (authorizations.length > 1 || invocationIds.length > 1) {
        return isInvocationAssertion(authorizations[0])
          ? sendAssertionDenied(reply)
          : reply.code(400).send({
              error: 'Bad Request',
              statusCode: 400,
              message: 'duplicate authentication headers'
            })
      }
      if (isInvocationAssertion(authorizations[0])) return
      const humanAuthenticate = app.humanAuth as unknown as (
        request: FastifyRequest,
        response: FastifyReply
      ) => Promise<unknown>
      return humanAuthenticate(req, reply)
    }

    // Hidden from the OpenAPI spec: this is the MCP wire, not a REST operation.
    app.post(MCP_PATH, { preHandler: authenticateMcp, schema: { hide: true } }, async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const authorizationValues = rawHeaderValues(req, 'authorization')
      const authorization = authorizationValues[0]
      const assertion = isInvocationAssertion(authorization) ? bearerToken(authorization) : null
      let invocationContext: InvocationContext | undefined

      if (assertion) {
        const invocationIds = rawHeaderValues(req, INVOCATION_ID_HEADER)
        if (invocationIds.length !== 1) return sendAssertionDenied(reply)
        const claim = await deps.invocationAssertions.claim({
          bearer: assertion,
          invocationId: invocationIds[0]!,
          requestBytes: rawBody,
          parseMetadata: () => invocationMetadata(rawBody)
        })
        if (claim.kind === 'denied') return sendAssertionDenied(reply)
        if (claim.kind === 'completed') {
          return reply
            .header('content-type', replayContentType(claim.responseBytes))
            .code(claim.responseStatus)
            .send(Buffer.from(claim.responseBytes))
        }
        if (claim.kind === 'in_progress') return sendInProgress(reply, claim.retryAfterMs)
        if (claim.kind === 'ambiguous') return sendAmbiguous(reply)
        invocationContext = claim.context
      }

      // Credential = a personal API key or an OAuth access token. `humanAuth` resolved it
      // (req.apiKeyOrgId set) or admitted the caller some other way (devAuth / OIDC ⇒ no
      // key org) — only the key path may proceed: the key's org binding pins this MCP
      // connection to ONE org.
      if (!invocationContext && !req.apiKeyOrgId) {
        return reply
          .header('www-authenticate', mcpAuthenticateChallenge(publicBaseUrl(req, deps.config), deps.config))
          .code(401)
          .send({
            error: 'Unauthorized',
            statusCode: 401,
            message:
              'AgentConnect MCP requires authentication — sign in via OAuth (browser) or present a personal API key (POST /v1/me/keys)'
          })
      }

      // Refuse JSON-RPC batch arrays — batching was removed in MCP 2025-06-18, and a
      // single request cannot cancel itself, so this closes any in-flight-cancel hang.
      if (rawBody.toString('utf8').trimStart().startsWith('[')) {
        return reply.code(400).send({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'JSON-RPC batch requests are not supported' },
          id: null
        })
      }

      const orgId = invocationContext?.orgId ?? req.apiKeyOrgId!
      const userId = invocationContext?.userId ?? req.principal!.userId
      const apiKeyId = invocationContext ? undefined : req.apiKeyId
      // Scope confinement (§6.3): an OAuth token's grant is the narrow boundary —
      // a non-empty scope set without `mcp:write` may not reach write tools.
      // Personal keys carry empty scopes (unrestricted). The org-scope guard on
      // the injected REST call enforces the same rule; this per-tool mirror keeps
      // the refusal friendly and prunes write tools from `tools/list`.
      const scopes = invocationContext ? ['mcp:read', 'mcp:write'] : req.apiKeyScopes
      const scopeCanWrite = !scopes || scopes.length === 0 || scopes.includes('mcp:write')
      const recordNestedDuration = (startedAt: number, outcome: 'succeeded' | 'failed') => {
        if (!invocationContext) return
        observeMetric(() => webchatMetrics.requestDuration('nested_rest', performance.now() - startedAt, outcome))
      }

      // Credentialed requests against this same Fastify instance — the full pipeline
      // (org-scope guard, visibility predicates, RBAC, zod (de)serialization) runs as
      // if the caller had issued the request directly.
      const ctx: McpToolCtx = {
        orgId,
        ...(invocationContext ? { delegatedAgentId: invocationContext.agentId } : {}),
        get: async (path, query) => {
          const qs = new URLSearchParams()
          for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined) qs.set(k, String(v))
          }
          const search = qs.size > 0 ? `?${qs.toString()}` : ''
          const url = `${API_V1_PREFIX}${path}${search}`
          const headers = invocationContext
            ? { [INTERNAL_INVOCATION_AUTH_HEADER]: deps.internalInvocationAuth.issue('GET', url)! }
            : { authorization: authorization! }
          const startedAt = performance.now()
          try {
            const res = await app.inject({
              method: 'GET',
              url,
              headers
            })
            recordNestedDuration(startedAt, res.statusCode >= 200 && res.statusCode < 400 ? 'succeeded' : 'failed')
            return { statusCode: res.statusCode, body: res.body }
          } catch (error) {
            recordNestedDuration(startedAt, 'failed')
            throw error
          }
        },
        send: async (method, path, body) => {
          const url = `${API_V1_PREFIX}${path}`
          const headers = invocationContext
            ? { [INTERNAL_INVOCATION_AUTH_HEADER]: deps.internalInvocationAuth.issue(method, url)! }
            : { authorization: authorization! }
          const startedAt = performance.now()
          try {
            const res = await app.inject({
              method,
              url,
              headers,
              ...(body !== undefined ? { payload: body } : {})
            })
            recordNestedDuration(startedAt, res.statusCode >= 200 && res.statusCode < 400 ? 'succeeded' : 'failed')
            return { statusCode: res.statusCode, body: res.body }
          } catch (error) {
            recordNestedDuration(startedAt, 'failed')
            throw error
          }
        }
      }

      let definiteFailure = false
      const server = new Server(serverInfo(deps.config.PUBLIC_WEB_URL), { capabilities: { tools: {} } })

      server.setRequestHandler('tools/list', async () => ({
        // A read-only credential doesn't see tools it may never call.
        tools: MCP_TOOLS.filter((t) => scopeCanWrite || !t.write).map(toolDescriptor)
      }))

      server.setRequestHandler('tools/call', async (rq) => {
        const params = rq.params as { name: string; arguments?: Record<string, unknown> }
        const tool = findTool(params.name)
        if (!tool) {
          definiteFailure = true
          throw new Error(`unknown tool: ${params.name}`)
        }

        // Rate limits (§6.5) run FIRST: a refused call does no downstream work at
        // all — including the audit append, so a hammering client cannot flood the
        // org's audit trail past the admitted budget.
        const rateKey = invocationContext ? `${userId}:${invocationContext.delegationId}` : (apiKeyId ?? userId)
        const retryAfterSec = deps.mcpRateLimit.check(rateKey, tool.write === true)
        if (retryAfterSec !== null) {
          definiteFailure = true
          req.log.warn({ tool: params.name, apiKeyId }, 'mcp: rate limited')
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Rate limit exceeded — too many operations from this credential; retry in ${retryAfterSec}s.`
              }
            ]
          }
        }

        const parsed = tool.schema.safeParse(params.arguments ?? {})
        let result: RestResult | undefined
        let failure: unknown
        if (parsed.success) {
          if (tool.write && !scopeCanWrite) {
            result = {
              statusCode: 403,
              body: JSON.stringify({
                error: 'Forbidden',
                statusCode: 403,
                message:
                  'this token is limited to read-only access (missing the mcp:write scope) — reconnect and grant write access to use write tools'
              })
            }
          } else {
            try {
              result = await tool.call(ctx, parsed.data)
            } catch (err) {
              failure = err
            }
          }
        }

        // Audit every call (design §9.3) — awaited so the trail is never behind the
        // response, but never fatal to the tool result itself.
        try {
          await deps.repos.audit.append({
            kind: 'mcp_tool_call',
            orgId: OrgId(orgId),
            actorUserId: userId,
            message: params.name,
            details: invocationContext
              ? {
                  principalType: 'webchat_assertion',
                  invocationId: invocationContext.invocationId,
                  delegationId: invocationContext.delegationId,
                  agentId: invocationContext.agentId,
                  conversationId: invocationContext.conversationId,
                  tool: params.name,
                  args: auditArgs(parsed.success ? parsed.data : undefined, params.arguments),
                  status: result?.statusCode ?? (parsed.success ? 'error' : 'invalid_arguments')
                }
              : {
                  tool: params.name,
                  args: auditArgs(parsed.success ? parsed.data : undefined, params.arguments),
                  status: result?.statusCode ?? (parsed.success ? 'error' : 'invalid_arguments'),
                  ...(apiKeyId ? { apiKeyId } : {})
                }
          })
        } catch (err) {
          req.log.warn({ err }, 'mcp: audit append failed')
        }

        if (!parsed.success) {
          definiteFailure = true
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          return { isError: true, content: [{ type: 'text' as const, text: `Invalid arguments — ${issues}` }] }
        }
        if (failure || !result) {
          definiteFailure = true
          req.log.error({ err: failure, tool: params.name }, 'mcp: tool execution failed')
          return { isError: true, content: [{ type: 'text' as const, text: 'Tool execution failed unexpectedly.' }] }
        }
        if (result.statusCode < 200 || result.statusCode >= 300) {
          definiteFailure = true
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Request failed (HTTP ${result.statusCode}): ${restErrorMessage(result.body)}`
              }
            ]
          }
        }
        // 204/202-style successes have no body — still hand the model a definite answer.
        return { content: [{ type: 'text' as const, text: result.body || `OK (HTTP ${result.statusCode})` }] }
      })

      // v2 web-standard handler: build a Fetch Request from the raw body + headers,
      // let the SDK dispatch it, and write the Fetch Response back to Fastify. No
      // hijack / Express — just this local adapter, so app.inject still works.
      const handler = createMcpHandler(() => server)
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (invocationContext && (k === 'authorization' || k === INVOCATION_ID_HEADER)) continue
        if (typeof v === 'string') headers.set(k, v)
        else if (Array.isArray(v)) headers.set(k, v.join(', '))
      }
      const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
      const request = new Request(`http://${host}${req.url}`, {
        method: 'POST',
        headers,
        body: rawBody.byteLength > 0 ? rawBody : undefined
      })

      const dispatch = async (): Promise<McpWireResponse> => {
        try {
          const res = await handler.fetch(request, {})
          return {
            statusCode: res.status,
            headers: res.headers,
            bytes: res.body ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0)
          }
        } catch (err) {
          req.log.error({ err }, 'mcp: transport error')
          return {
            statusCode: 500,
            headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
            bytes: Buffer.from(
              JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null })
            )
          }
        }
      }

      const sendWireResponse = (wire: McpWireResponse) => {
        reply.code(wire.statusCode)
        wire.headers.forEach((value, key) => {
          if (key !== 'content-length') void reply.header(key, value)
        })
        return reply.send(wire.bytes)
      }

      if (!invocationContext) return sendWireResponse(await dispatch())

      const context = invocationContext
      const deadlineMs = context.startedAt.getTime() + MCP_INVOCATION_EXECUTION_TIMEOUT_MS
      const entryNowMs = deps.clock.now()
      if (!Number.isFinite(entryNowMs) || !Number.isFinite(deadlineMs) || entryNowMs >= deadlineMs) {
        try {
          const marked = await deps.repos.mcpInvocation.markAmbiguous(context.invocationId, new Date(entryNowMs))
          if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
        } catch (err) {
          req.log.error({ err, invocationId: context.invocationId }, 'mcp: expired invocation mark failed')
        }
        return sendAmbiguous(reply)
      }

      let executionFinished = false
      let deadlineTriggered = false
      const invocationExecution = deps.internalInvocationAuth.start(context, dispatch)
      const execution = invocationExecution.result
        .then(async (wire) => {
          const completedAtMs = deps.clock.now()
          const completedAt = new Date(completedAtMs)
          try {
            if (!Number.isFinite(completedAtMs) || completedAtMs >= deadlineMs) {
              invocationExecution.revoke()
              if (!deadlineTriggered) {
                const marked = await deps.repos.mcpInvocation.markAmbiguous(context.invocationId, completedAt)
                if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
              }
              return { kind: 'ambiguous' as const }
            }
            if (wire.bytes.byteLength > MCP_INVOCATION_MAX_RESPONSE_BYTES) {
              const marked = await deps.repos.mcpInvocation.markAmbiguous(context.invocationId, completedAt)
              if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
              return { kind: 'ambiguous' as const }
            }
            const completed = await deps.repos.mcpInvocation.complete({
              invocationId: context.invocationId,
              status: wire.statusCode >= 200 && wire.statusCode < 400 && !definiteFailure ? 'succeeded' : 'failed',
              responseStatus: wire.statusCode,
              responseBytes: wire.bytes,
              completedAt
            })
            if (completed) {
              observeMetric(() =>
                webchatMetrics.invocation(
                  wire.statusCode >= 200 && wire.statusCode < 400 && !definiteFailure ? 'succeeded' : 'failed'
                )
              )
              return { kind: 'response' as const, wire }
            }
            const marked = await deps.repos.mcpInvocation.markAmbiguous(context.invocationId, completedAt)
            if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
            return { kind: 'ambiguous' as const }
          } catch (err) {
            req.log.error({ err, invocationId: context.invocationId }, 'mcp: invocation completion failed')
            try {
              const marked = await deps.repos.mcpInvocation.markAmbiguous(context.invocationId, completedAt)
              if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
            } catch (markErr) {
              req.log.error(
                { err: markErr, invocationId: context.invocationId },
                'mcp: invocation ambiguity mark failed'
              )
            }
            return { kind: 'ambiguous' as const }
          }
        })
        .finally(() => {
          executionFinished = true
        })

      let timer: ReturnType<HttpDeps['clock']['setTimeout']> | undefined
      const timedOut = new Promise<{ kind: 'ambiguous' } | { kind: 'response'; wire: McpWireResponse }>((resolve) => {
        timer = deps.clock.setTimeout(
          () => {
            deadlineTriggered = true
            // Revoke synchronously, before the ambiguity CAS awaits database I/O.
            // Already-authorized subrequests may settle; no later stage can mint.
            invocationExecution.revoke()
            void (async () => {
              try {
                const marked = await deps.repos.mcpInvocation.markAmbiguous(
                  context.invocationId,
                  new Date(deps.clock.now())
                )
                if (marked) observeMetric(() => webchatMetrics.invocation('ambiguous'))
                // The reaper or a concurrent completion may have won the terminal CAS.
                // At this request's durable deadline the conservative wire answer is
                // still ambiguous; never await a potentially hung execution here.
                resolve({ kind: 'ambiguous' })
              } catch (err) {
                req.log.error({ err, invocationId: context.invocationId }, 'mcp: invocation timeout mark failed')
                resolve({ kind: 'ambiguous' })
              }
            })()
          },
          Math.max(0, deadlineMs - entryNowMs)
        )
      })
      const outcome = await Promise.race([execution, timedOut])
      if (timer !== undefined && executionFinished) deps.clock.clearTimeout(timer)
      return outcome.kind === 'response' ? sendWireResponse(outcome.wire) : sendAmbiguous(reply)
    })

    // Stateless server: no SSE stream to open (GET) and no session to end (DELETE) —
    // a spec-conformant 405 tells clients to just POST.
    const methodNotAllowed = (_req: FastifyRequest, reply: FastifyReply) =>
      reply
        .header('allow', 'POST')
        .code(405)
        .send({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null })
    app.get(MCP_PATH, { schema: { hide: true } }, methodNotAllowed)
    app.delete(MCP_PATH, { schema: { hide: true } }, methodNotAllowed)
  }
}
