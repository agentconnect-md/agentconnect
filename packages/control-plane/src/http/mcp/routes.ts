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
 * Auth: a personal API key OR an OAuth access token (`Authorization: Bearer <dot-free
 * key>`); both resolve through `humanAuth` to a user + org-bound key (`req.apiKeyOrgId`).
 * Any other caller (devAuth stub, OIDC JWT) gets a 401 whose `WWW-Authenticate` points
 * at the Protected Resource Metadata — the OAuth browser-login discovery entrance (§7).
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

export const MCP_PATH = '/mcp'

const SERVER_INFO = { name: 'agentconnect', version: '1.0.0' }

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
    // The v2 handler reads the raw request body itself — pass the stream through
    // unparsed rather than letting Fastify's JSON parser consume it. Encapsulated to
    // this plugin (only the /mcp routes); the inject'd tool GETs hit other routes and
    // parse normally.
    app.removeAllContentTypeParsers()
    app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

    // Every 401 out of this plugin MUST carry a Bearer challenge (RFC 9110 §15.5.2, and
    // the MCP auth-discovery entrance clients re-auth off of). `humanAuth` rejects an
    // invalid/revoked/expired key in a preHandler with a bare 401, so stamp it here.
    app.addHook('onSend', async (req, reply, payload) => {
      if (reply.statusCode === 401 && !reply.getHeader('www-authenticate')) {
        void reply.header('www-authenticate', mcpAuthenticateChallenge(publicBaseUrl(req, deps.config), deps.config))
      }
      return payload
    })

    // Hidden from the OpenAPI spec: this is the MCP wire, not a REST operation.
    app.post(MCP_PATH, { preHandler: app.humanAuth, schema: { hide: true } }, async (req, reply) => {
      // Credential = a personal API key or an OAuth access token. `humanAuth` resolved it
      // (req.apiKeyOrgId set) or admitted the caller some other way (devAuth / OIDC ⇒ no
      // key org) — only the key path may proceed: the key's org binding pins this MCP
      // connection to ONE org.
      if (!req.apiKeyOrgId) {
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

      const rawBody = typeof req.body === 'string' ? req.body : ''
      // Refuse JSON-RPC batch arrays — batching was removed in MCP 2025-06-18, and a
      // single request cannot cancel itself, so this closes any in-flight-cancel hang.
      if (rawBody.trimStart().startsWith('[')) {
        return reply.code(400).send({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'JSON-RPC batch requests are not supported' },
          id: null
        })
      }

      const orgId = req.apiKeyOrgId
      const userId = req.principal!.userId
      const apiKeyId = req.apiKeyId
      const authorization = req.headers.authorization!
      // Scope confinement (§6.3): an OAuth token's grant is the narrow boundary —
      // a non-empty scope set without `mcp:write` may not reach write tools.
      // Personal keys carry empty scopes (unrestricted). The org-scope guard on
      // the injected REST call enforces the same rule; this per-tool mirror keeps
      // the refusal friendly and prunes write tools from `tools/list`.
      const scopes = req.apiKeyScopes
      const scopeCanWrite = !scopes || scopes.length === 0 || scopes.includes('mcp:write')

      // Credentialed requests against this same Fastify instance — the full pipeline
      // (org-scope guard, visibility predicates, RBAC, zod (de)serialization) runs as
      // if the caller had issued the request directly.
      const ctx: McpToolCtx = {
        orgId,
        get: async (path, query) => {
          const qs = new URLSearchParams()
          for (const [k, v] of Object.entries(query ?? {})) {
            if (v !== undefined) qs.set(k, String(v))
          }
          const search = qs.size > 0 ? `?${qs.toString()}` : ''
          const res = await app.inject({
            method: 'GET',
            url: `${API_V1_PREFIX}${path}${search}`,
            headers: { authorization }
          })
          return { statusCode: res.statusCode, body: res.body }
        },
        send: async (method, path, body) => {
          const res = await app.inject({
            method,
            url: `${API_V1_PREFIX}${path}`,
            headers: { authorization, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            ...(body !== undefined ? { payload: JSON.stringify(body) } : {})
          })
          return { statusCode: res.statusCode, body: res.body }
        }
      }

      const server = new Server(serverInfo(deps.config.PUBLIC_WEB_URL), { capabilities: { tools: {} } })

      server.setRequestHandler('tools/list', async () => ({
        // A read-only credential doesn't see tools it may never call.
        tools: MCP_TOOLS.filter((t) => scopeCanWrite || !t.write).map(toolDescriptor)
      }))

      server.setRequestHandler('tools/call', async (rq) => {
        const params = rq.params as { name: string; arguments?: Record<string, unknown> }
        const tool = findTool(params.name)
        if (!tool) throw new Error(`unknown tool: ${params.name}`)

        // Rate limits (§6.5) run FIRST: a refused call does no downstream work at
        // all — including the audit append, so a hammering client cannot flood the
        // org's audit trail past the admitted budget.
        const retryAfterSec = deps.mcpRateLimit.check(apiKeyId ?? userId, tool.write === true)
        if (retryAfterSec !== null) {
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
            details: {
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
          const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
          return { isError: true, content: [{ type: 'text' as const, text: `Invalid arguments — ${issues}` }] }
        }
        if (failure || !result) {
          req.log.error({ err: failure, tool: params.name }, 'mcp: tool execution failed')
          return { isError: true, content: [{ type: 'text' as const, text: 'Tool execution failed unexpectedly.' }] }
        }
        if (result.statusCode < 200 || result.statusCode >= 300) {
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
        if (typeof v === 'string') headers.set(k, v)
        else if (Array.isArray(v)) headers.set(k, v.join(', '))
      }
      const host = typeof req.headers.host === 'string' ? req.headers.host : 'localhost'
      const request = new Request(`http://${host}${req.url}`, {
        method: 'POST',
        headers,
        body: rawBody || undefined
      })
      try {
        const res = await handler.fetch(request, {})
        reply.code(res.status)
        res.headers.forEach((value, key) => {
          void reply.header(key, value)
        })
        return reply.send(res.body ? Buffer.from(await res.arrayBuffer()) : null)
      } catch (err) {
        req.log.error({ err }, 'mcp: transport error')
        return reply
          .code(500)
          .send({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null })
      }
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
