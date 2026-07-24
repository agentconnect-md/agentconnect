/**
 * Shared helpers for the embedded OAuth AS routes (agent-assistant.md §7).
 */
import type { FastifyRequest } from 'fastify'
import type { HttpServerConfig } from '../deps.js'
import { OAUTH_SCOPES } from '../../registry/oauthService.js'

/** The externally-reachable CP origin. Prefer the configured PUBLIC_CP_URL;
 *  otherwise derive it from the request, honoring a proxy's
 *  x-forwarded-proto so the issuer matches what the client actually dialed. */
export function publicBaseUrl(req: FastifyRequest, config: HttpServerConfig): string {
  if (config.PUBLIC_CP_URL) return config.PUBLIC_CP_URL.replace(/\/+$/, '')
  const fwd = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.protocol
  return `${proto}://${req.host}`
}

/** The MCP endpoint's path AS SEEN FROM OUTSIDE when it shares the CP's public origin,
 *  joined to the public base to form the canonical resource URL. `/v1` is the public
 *  prefix of the versioned API (same convention as SLACK_OAUTH_CALLBACK_PATH). A
 *  deployment may rewrite it to the internal `/api/v1`, while a direct-hit CP serves it
 *  through the `/v1` alias in `server.ts`. RFC 9728 clients also derive the
 *  path-inserted PRM location and validate the PRM `resource` byte-for-byte from this
 *  exact form. When PUBLIC_MCP_URL selects a dedicated origin instead, the resource
 *  becomes that origin's root. */
export const MCP_PUBLIC_PATH = '/v1/mcp'

type McpUrlConfig = Pick<HttpServerConfig, 'PUBLIC_MCP_URL'>

/** The dedicated MCP origin (PUBLIC_MCP_URL) as a bare origin (no trailing slash) —
 *  the form used for the AS issuer and for composing well-known paths — or undefined
 *  when the endpoint rides the CP's own public origin. */
function mcpDedicatedOrigin(config: McpUrlConfig): string | undefined {
  if (!config.PUBLIC_MCP_URL) return undefined
  return new URL(config.PUBLIC_MCP_URL).origin
}

/** The canonical MCP resource URL (RFC 8707 audience + RFC 9728 `resource`) — the URL
 *  users hand to MCP clients: the dedicated origin when one is configured, else
 *  `<base>/v1/mcp`. The dedicated (root-resource) form is the BARE ORIGIN, WITHOUT a
 *  trailing slash — `https://mcp.example.test` — per the MCP authorization spec's
 *  canonical-URI rule: "implementations SHOULD consistently use the form without the
 *  trailing slash for better interoperability unless the trailing slash is semantically
 *  significant" (2025-06-18 §Canonical Server URI; its example is `&resource=https%3A%2F
 *  %2Fmcp.example.com`, no slash). That bare form is also what claude.ai stores as the
 *  connector URL and treats as the token audience. A SLASHED `resource` — what we
 *  advertised before — mismatches the client's canonical (slash-less) URI, so the
 *  client completes the OAuth flow, is issued a token, then silently aborts at audience
 *  binding and NEVER presents the token to the endpoint (the connection just fails with
 *  "Authorization with the MCP server failed"). */
export function mcpResourceUrl(base: string, config: McpUrlConfig): string {
  const dedicated = mcpDedicatedOrigin(config)
  return dedicated ? dedicated : `${base}${MCP_PUBLIC_PATH}`
}

/** The origin the embedded AS lives on. The AS exists solely for MCP browser login
 *  (§7), so it rides the dedicated MCP origin when one is configured — the CP's own
 *  public origin (the api host) then serves NO OAuth at all. Falls back to the CP
 *  origin for direct-hit deploys. */
export function oauthAsBase(base: string, config: McpUrlConfig): string {
  return mcpDedicatedOrigin(config) ?? base
}

/** RFC 9728 Protected Resource Metadata for the MCP endpoint. Resource and AS share
 *  the dedicated MCP origin when one is configured (else both fall back to `base`). */
export function protectedResourceMetadata(base: string, config: McpUrlConfig): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(base, config),
    authorization_servers: [oauthAsBase(base, config)],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header']
  }
}

/** RFC 8414 Authorization Server Metadata for our embedded AS — issuer + endpoints on
 *  the AS origin (`oauthAsBase`: the dedicated MCP origin when configured, whose edge
 *  forwards /.well-known/* and /oauth/* to the CP verbatim). `code_challenge_methods_supported`
 *  is load-bearing: MCP clients (2025-11-25) refuse to proceed if it's absent. */
export function authorizationServerMetadata(base: string, config: McpUrlConfig): Record<string, unknown> {
  const as = oauthAsBase(base, config)
  return {
    issuer: as,
    authorization_endpoint: `${as}/oauth/authorize`,
    token_endpoint: `${as}/oauth/token`,
    registration_endpoint: `${as}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES]
  }
}

/** The `WWW-Authenticate` challenge the MCP endpoint returns on a 401 — the client's
 *  entrance to auth discovery (RFC 9728 §5.1 + the MCP authorization spec). The PRM
 *  location mirrors what a client derives on its own from the URL it was given: the
 *  origin-root document for a dedicated-origin (root) resource, else path-inserted at
 *  the public `/v1/mcp` form. */
export function mcpAuthenticateChallenge(base: string, config: McpUrlConfig): string {
  const dedicated = mcpDedicatedOrigin(config)
  const prm = dedicated
    ? `${dedicated}/.well-known/oauth-protected-resource`
    : `${base}/.well-known/oauth-protected-resource${MCP_PUBLIC_PATH}`
  return `Bearer resource_metadata="${prm}", scope="${OAUTH_SCOPES.join(' ')}"`
}
