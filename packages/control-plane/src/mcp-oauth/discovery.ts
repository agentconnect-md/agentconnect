/**
 * MCP authorization discovery — the client half of
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.
 *
 * Three steps, each a normative MUST the spec spells out, and each one a place where
 * getting it slightly wrong fails silently much later:
 *
 *  1. PROBE the MCP endpoint unauthenticated. An OAuth-protected server answers 401 with
 *     `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728 §5.1), often with a
 *     `scope` naming exactly what this resource needs. Many servers only challenge a POST,
 *     so the probe is a POST of an `initialize` JSON-RPC, never a GET.
 *  2. FETCH the protected-resource metadata — from the challenge when it named one, else
 *     by the well-known fallback in the spec's order (path-inserted, then root).
 *  3. FETCH the authorization-server metadata by trying the spec's exact URL priority
 *     order, and REJECT any document whose `issuer` is not byte-identical to the issuer
 *     the URL was built from. That check is what stops a hostile metadata host from
 *     claiming to speak for someone else.
 *
 * `resource` canonicalization cuts BOTH ways, and the direction is easy to get backwards.
 * OUTBOUND (the RFC 8707 `resource` parameter) we send the PRM document's own string
 * byte-for-byte, because the authorization server matches the string it published.
 * INBOUND (deciding whether a PRM document describes the url the operator registered) we
 * compare leniently, ignoring a single trailing slash — otherwise a server publishing
 * `https://mcp.example.test/mcp/` against an operator who typed it without the slash
 * fails to connect at all. `http/oauth/base.ts` records the same trap from the server side.
 *
 * Pure of persistence and of Fastify: every network call goes through an injected dial,
 * which in production is the SSRF-guarded `net/guarded-fetch.ts`.
 */
import type { GuardedFailure, GuardedRequestInit, GuardedResult } from '../net/guarded-fetch.js'

/** The injected network edge. Matches `guardedRequest`, so prod passes it directly. */
export type Dial = (url: string, init?: GuardedRequestInit) => Promise<GuardedResult>

/** One parsed `WWW-Authenticate` challenge. Param names are lowercased; values are unescaped. */
export interface AuthChallenge {
  scheme: string
  params: Record<string, string>
}

const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/

function readToken(s: string, from: number): [string, number] {
  let i = from
  while (i < s.length && TOKEN_CHAR.test(s[i]!)) i++
  return [s.slice(from, i), i]
}

function readValue(s: string, from: number): [string, number] {
  if (s[from] !== '"') return readToken(s, from)
  let i = from + 1
  let out = ''
  while (i < s.length && s[i] !== '"') {
    if (s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1]
      i += 2
      continue
    }
    out += s[i]
    i++
  }
  return [out, i + 1]
}

/**
 * Parse a `WWW-Authenticate` header into its challenges. Commas separate both challenges
 * and auth-params, so the only way to tell them apart is to look ahead: a token followed
 * by `=` is a param of the current challenge, anything else starts a new one. Quoted
 * values may themselves contain commas, which is why a naive split is wrong.
 */
export function parseWwwAuthenticate(header: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = []
  let i = 0
  const skip = (): void => {
    while (i < header.length && (header[i] === ' ' || header[i] === '\t' || header[i] === ',')) i++
  }
  skip()
  while (i < header.length) {
    const [tok, afterTok] = readToken(header, i)
    if (tok === '') {
      i++
      continue
    }
    i = afterTok
    let j = i
    while (j < header.length && (header[j] === ' ' || header[j] === '\t')) j++
    if (header[j] === '=') {
      j++
      while (j < header.length && (header[j] === ' ' || header[j] === '\t')) j++
      const [value, afterValue] = readValue(header, j)
      i = afterValue
      const current = challenges.at(-1)
      if (current) current.params[tok.toLowerCase()] = value
    } else {
      challenges.push({ scheme: tok.toLowerCase(), params: {} })
    }
    skip()
  }
  return challenges
}

/** The Bearer challenge's params, or null when the header carries none. */
export function bearerChallenge(header: string | string[] | undefined): Record<string, string> | null {
  if (header === undefined) return null
  const raw = Array.isArray(header) ? header.join(', ') : header
  return parseWwwAuthenticate(raw).find((c) => c.scheme === 'bearer')?.params ?? null
}

/** Same resource, ignoring a single trailing slash and scheme/host case (see the header note). */
export function sameResource(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const u = new URL(raw)
      const path = u.pathname.length > 1 && u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : u.pathname
      return `${u.protocol}//${u.host}${path === '/' ? '' : path}${u.search}`
    } catch {
      return null
    }
  }
  const left = norm(a)
  return left !== null && left === norm(b)
}

/** RFC 9728 §3.1 well-known locations for a resource url, in the order the spec requires. */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
  const u = new URL(resourceUrl)
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
  const root = `${u.origin}/.well-known/oauth-protected-resource`
  return path === '' ? [root] : [`${root}${path}`, root]
}

/**
 * Authorization-server metadata locations, in the spec's exact priority order: with a path
 * component, RFC 8414 path-insertion then OIDC path-insertion then OIDC path-appending;
 * without one, RFC 8414 then OIDC.
 */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
  if (path === '') {
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`
  ]
}

/** The RFC 9728 fields this flow reads. Unknown members are ignored, never rejected. */
export interface ProtectedResourceMetadata {
  resource: string
  authorizationServers: string[]
  scopesSupported?: string[]
}

/** The RFC 8414 / OIDC-discovery fields this flow reads. */
export interface AuthServerMetadata {
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  scopesSupported?: string[]
  codeChallengeMethodsSupported?: string[]
  grantTypesSupported?: string[]
  /** RFC 9207: when true, an authorization response without `iss` must be rejected. */
  issParameterSupported: boolean
  /** Draft CIMD: the AS resolves an https client_id url. Recorded now, used when CIMD lands. */
  clientIdMetadataDocumentSupported: boolean
}

/** Why discovery stopped. Every arm is safe to show a console user; none names a host. */
export type DiscoveryFailure =
  /** The CP could not reach the endpoint, or an address guard refused it. */
  | 'discovery_unreachable'
  /** Reached, but it does not advertise OAuth: no challenge and no protected-resource metadata. */
  | 'discovery_not_protected'
  /** Metadata was served but is unusable — missing required members, or bad JSON. */
  | 'discovery_malformed'
  /** The metadata document claims an issuer other than the one it was fetched for. */
  | 'issuer_mismatch'
  /** The metadata describes a different resource than the registered url. */
  | 'resource_mismatch'

export type Discovered<T> = { ok: true; value: T } | { ok: false; failure: DiscoveryFailure }

const unreachable = new Set<GuardedFailure>(['unreachable', 'address_blocked', 'url_rejected'])

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

/** The unauthenticated `initialize` a probe sends. Its id is irrelevant; only the status is read. */
const PROBE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agentconnect', version: '1' } }
})

export interface ProbeResult {
  /** Present when the server answered with a Bearer challenge. */
  challenge: Record<string, string> | null
  status: number
}

/** POST an unauthenticated `initialize` and read the challenge. A GET would miss most servers. */
export async function probeMcpEndpoint(dial: Dial, mcpUrl: string): Promise<Discovered<ProbeResult>> {
  const result = await dial(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: PROBE_BODY
  })
  if (!result.ok) {
    return { ok: false, failure: unreachable.has(result.failure) ? 'discovery_unreachable' : 'discovery_malformed' }
  }
  return {
    ok: true,
    value: { challenge: bearerChallenge(result.response.headers['www-authenticate']), status: result.response.status }
  }
}

function readProtectedResource(json: unknown): ProtectedResourceMetadata | null {
  if (typeof json !== 'object' || json === null) return null
  const doc = json as Record<string, unknown>
  const resource = str(doc.resource)
  const servers = strArray(doc.authorization_servers)
  if (resource === undefined || servers === undefined || servers.length === 0) return null
  const scopes = strArray(doc.scopes_supported)
  return { resource, authorizationServers: servers, ...(scopes ? { scopesSupported: scopes } : {}) }
}

/**
 * Locate and validate the protected-resource metadata for an MCP url. Prefers the
 * challenge's `resource_metadata` pointer; falls back to the well-known probing order.
 * The document must describe the url we registered, or an operator typo would silently
 * bind this provider to somebody else's audience.
 */
export async function discoverProtectedResource(
  dial: Dial,
  mcpUrl: string,
  challenge: Record<string, string> | null
): Promise<Discovered<ProtectedResourceMetadata>> {
  const pointed = challenge?.resource_metadata
  const candidates = pointed !== undefined ? [pointed] : protectedResourceMetadataUrls(mcpUrl)
  let sawUnreachable = false
  for (const url of candidates) {
    const result = await dial(url, { headers: { accept: 'application/json' } })
    if (!result.ok) {
      sawUnreachable ||= unreachable.has(result.failure)
      continue
    }
    if (result.response.status !== 200) continue
    const doc = readProtectedResource(result.response.json)
    if (doc === null) return { ok: false, failure: 'discovery_malformed' }
    if (!sameResource(doc.resource, mcpUrl)) return { ok: false, failure: 'resource_mismatch' }
    return { ok: true, value: doc }
  }
  return { ok: false, failure: sawUnreachable ? 'discovery_unreachable' : 'discovery_not_protected' }
}

function readAuthServer(json: unknown, expectedIssuer: string): AuthServerMetadata | 'mismatch' | null {
  if (typeof json !== 'object' || json === null) return null
  const doc = json as Record<string, unknown>
  const issuer = str(doc.issuer)
  const authorizationEndpoint = str(doc.authorization_endpoint)
  const tokenEndpoint = str(doc.token_endpoint)
  if (issuer === undefined || authorizationEndpoint === undefined || tokenEndpoint === undefined) return null
  // RFC 8414 §3.3 / OIDC Discovery §4.3: byte-identical, no normalization. A document
  // fetched from one host may not claim to be another's.
  if (issuer !== expectedIssuer) return 'mismatch'
  const registration = str(doc.registration_endpoint)
  const scopes = strArray(doc.scopes_supported)
  const methods = strArray(doc.code_challenge_methods_supported)
  const grants = strArray(doc.grant_types_supported)
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(registration ? { registrationEndpoint: registration } : {}),
    ...(scopes ? { scopesSupported: scopes } : {}),
    ...(methods ? { codeChallengeMethodsSupported: methods } : {}),
    ...(grants ? { grantTypesSupported: grants } : {}),
    issParameterSupported: doc.authorization_response_iss_parameter_supported === true,
    clientIdMetadataDocumentSupported: doc.client_id_metadata_document_supported === true
  }
}

/**
 * Fetch the authorization server's metadata, trying the spec's URL order. An issuer that
 * answers with somebody else's `issuer` is a mix-up attempt and ends discovery — it is not
 * a reason to keep trying the remaining URLs.
 */
export async function discoverAuthServer(dial: Dial, issuer: string): Promise<Discovered<AuthServerMetadata>> {
  let urls: string[]
  try {
    urls = authServerMetadataUrls(issuer)
  } catch {
    return { ok: false, failure: 'discovery_malformed' }
  }
  let sawUnreachable = false
  for (const url of urls) {
    const result = await dial(url, { headers: { accept: 'application/json' } })
    if (!result.ok) {
      sawUnreachable ||= unreachable.has(result.failure)
      continue
    }
    if (result.response.status !== 200) continue
    const doc = readAuthServer(result.response.json, issuer)
    if (doc === 'mismatch') return { ok: false, failure: 'issuer_mismatch' }
    if (doc === null) return { ok: false, failure: 'discovery_malformed' }
    return { ok: true, value: doc }
  }
  return { ok: false, failure: sawUnreachable ? 'discovery_unreachable' : 'discovery_malformed' }
}

export interface McpAuthorizationTarget {
  /** The RFC 8707 audience, exactly as the resource published it. Never re-canonicalized. */
  resource: string
  /** The scope set to request, chosen by the spec's priority order. Empty ⇒ send no `scope`. */
  scopes: string[]
  metadata: AuthServerMetadata
  protectedResource: ProtectedResourceMetadata
}

/**
 * Scope selection, in the spec's priority order: the challenge's `scope` is authoritative
 * for this resource; otherwise the whole of `scopes_supported`; otherwise none at all.
 * `offline_access` is requested when the AS advertises it, since a refresh token is the
 * difference between a provider that keeps working and one that dies at first expiry.
 */
export function selectScopes(
  challenge: Record<string, string> | null,
  prm: ProtectedResourceMetadata,
  as: AuthServerMetadata
): string[] {
  const base = challenge?.scope?.split(/\s+/).filter(Boolean) ?? prm.scopesSupported ?? []
  const scopes = [...new Set(base)]
  if (as.scopesSupported?.includes('offline_access') && !scopes.includes('offline_access')) {
    scopes.push('offline_access')
  }
  return scopes
}

/**
 * The whole discovery chain for one provider url. Returns everything the authorization hop
 * needs, or the single failure a console user should see. The first authorization server is
 * taken when several are listed: picking among them is the client's call per RFC 9728 §7.6,
 * and a per-provider choice is not a question P1 asks the operator.
 */
export async function discoverMcpAuthorization(
  dial: Dial,
  mcpUrl: string
): Promise<Discovered<McpAuthorizationTarget>> {
  const probe = await probeMcpEndpoint(dial, mcpUrl)
  if (!probe.ok) return probe
  const prm = await discoverProtectedResource(dial, mcpUrl, probe.value.challenge)
  if (!prm.ok) return prm
  const as = await discoverAuthServer(dial, prm.value.authorizationServers[0]!)
  if (!as.ok) return as
  return {
    ok: true,
    value: {
      resource: prm.value.resource,
      scopes: selectScopes(probe.value.challenge, prm.value, as.value),
      metadata: as.value,
      protectedResource: prm.value
    }
  }
}
