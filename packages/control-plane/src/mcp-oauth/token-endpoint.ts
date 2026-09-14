/**
 * The two token-endpoint exchanges an MCP provider's grant needs: redeeming an
 * authorization code, and renewing with a refresh token.
 *
 * Both carry the RFC 8707 `resource` parameter, and the spec is explicit that clients send
 * it whether or not the authorization server is known to support it — an audience-bound
 * token is the only thing that stops a token minted for one MCP server being replayed
 * against another. The value is the string protected-resource metadata published, passed
 * through untouched; see `discovery.ts` for why re-canonicalizing it silently breaks binding.
 *
 * The failure taxonomy is load-bearing, not cosmetic. `rejected` means the authorization
 * server DEFINITIVELY refused — the grant is dead and only a fresh authorization repairs
 * it. `unreachable` means we learned nothing, so the caller must retry rather than flip a
 * working provider into `reauth_required` over a network blip. That distinction is the same
 * one `platforms/linear/token-service.ts` draws, for the same reason.
 *
 * SECURITY: every field here — code, verifier, client secret, both tokens — is secret.
 * NEVER log a request, a response body, or an error from this module.
 */
import type { Dial } from './discovery.js'
import type { GuardedFailure } from '../net/guarded-fetch.js'

/** A grant as the authorization server issued it. `expiresAt` is absolute, not a duration. */
export interface TokenGrant {
  accessToken: string
  refreshToken?: string
  expiresAt: Date | null
  /** The scope actually granted, when the server narrowed or echoed it. */
  scope?: string
}

export type TokenFailure =
  /** The server refused: this grant is dead and only re-authorization repairs it. */
  | 'rejected'
  /** We learned nothing — retry, and do NOT change the provider's status. */
  | 'unreachable'
  /** A 2xx that is not a usable token response. Treated as dead, like a refusal. */
  | 'malformed'

export type TokenResult = { ok: true; grant: TokenGrant } | { ok: false; failure: TokenFailure }

export interface TokenClient {
  tokenEndpoint: string
  clientId: string
  /** Present only for a confidential client; sent as HTTP Basic per OAuth 2.1 §2.4.1. */
  clientSecret?: string
  /** The RFC 8707 audience, verbatim from protected-resource metadata. */
  resource: string
}

const unreachable = new Set<GuardedFailure>(['unreachable', 'address_blocked', 'url_rejected'])

function readGrant(json: unknown, now: number): TokenGrant | null {
  if (typeof json !== 'object' || json === null) return null
  const doc = json as Record<string, unknown>
  const accessToken = typeof doc.access_token === 'string' && doc.access_token.length > 0 ? doc.access_token : undefined
  if (accessToken === undefined) return null
  const refresh = typeof doc.refresh_token === 'string' && doc.refresh_token.length > 0 ? doc.refresh_token : undefined
  const expiresIn = typeof doc.expires_in === 'number' && Number.isFinite(doc.expires_in) ? doc.expires_in : undefined
  const scope = typeof doc.scope === 'string' && doc.scope.length > 0 ? doc.scope : undefined
  return {
    accessToken,
    ...(refresh ? { refreshToken: refresh } : {}),
    expiresAt: expiresIn === undefined ? null : new Date(now + expiresIn * 1000),
    ...(scope ? { scope } : {})
  }
}

async function post(dial: Dial, client: TokenClient, form: Record<string, string>, now: number): Promise<TokenResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json'
  }
  if (client.clientSecret !== undefined) {
    const basic = Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)
    headers.authorization = `Basic ${basic.toString('base64')}`
  }
  const result = await dial(client.tokenEndpoint, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ ...form, client_id: client.clientId, resource: client.resource }).toString()
  })
  if (!result.ok) {
    return { ok: false, failure: unreachable.has(result.failure) ? 'unreachable' : 'malformed' }
  }
  const { status, json } = result.response
  // 5xx is the server failing, not the grant failing — retryable, and never a reason to
  // tell an operator to re-authorize. 4xx is the definitive refusal.
  if (status >= 500) return { ok: false, failure: 'unreachable' }
  if (status !== 200) return { ok: false, failure: 'rejected' }
  const grant = readGrant(json, now)
  return grant === null ? { ok: false, failure: 'malformed' } : { ok: true, grant }
}

/** Redeem an authorization code. The verifier and redirect_uri must match the ones used at `begin`. */
export function exchangeCode(
  dial: Dial,
  client: TokenClient,
  input: { code: string; redirectUri: string; codeVerifier: string },
  now: number
): Promise<TokenResult> {
  return post(
    dial,
    client,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier
    },
    now
  )
}

/** Renew. The server MAY rotate the refresh token, so the caller must persist what comes back. */
export function refreshGrant(dial: Dial, client: TokenClient, refreshToken: string, now: number): Promise<TokenResult> {
  return post(dial, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, now)
}
