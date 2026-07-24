/**
 * `http/oauth/metadata.ts` — the OAuth discovery documents (agent-assistant.md §7.2),
 * served at the ROOT (outside `/api/v1`, unauthenticated) as plain Fastify routes:
 *   - RFC 9728 Protected Resource Metadata at both the path-inserted location
 *     (`/.well-known/oauth-protected-resource/api/v1/mcp`, which Claude probes first)
 *     and the origin root, pointing at this AS.
 *   - RFC 8414 Authorization Server Metadata at `/.well-known/oauth-authorization-server`.
 *
 * Fastify-native (inject-testable) — the AS is our own, co-hosted with the resource
 * server but logically distinct (its own issuer + endpoints), which the spec permits.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { HttpDeps } from '../deps.js'
import { publicBaseUrl, protectedResourceMetadata, authorizationServerMetadata, MCP_PUBLIC_PATH } from './base.js'

export function oauthMetadataRoutes(deps: HttpDeps) {
  return async function oauthMetadataPlugin(app: FastifyInstance): Promise<void> {
    const prm = (req: FastifyRequest) => protectedResourceMetadata(publicBaseUrl(req, deps.config), deps.config)

    // RFC 9728 — served at the origin root (the location clients derive for a
    // dedicated-origin root resource — the edge forwards the MCP host's PRM probe here
    // verbatim — and the generic fallback) + path-inserted at the public `/v1/mcp` form
    // (what clients derive when the endpoint rides the CP origin; never the internal
    // `/api/v1` mount, see MCP_PUBLIC_PATH).
    app.get(`/.well-known/oauth-protected-resource${MCP_PUBLIC_PATH}`, { schema: { hide: true } }, async (req) =>
      prm(req)
    )
    app.get('/.well-known/oauth-protected-resource', { schema: { hide: true } }, async (req) => prm(req))

    // RFC 8414 — authorization server metadata (issuer = the AS origin: the dedicated
    // MCP host when configured, whose edge forwards this path verbatim).
    app.get('/.well-known/oauth-authorization-server', { schema: { hide: true } }, async (req) =>
      authorizationServerMetadata(publicBaseUrl(req, deps.config), deps.config)
    )
  }
}
