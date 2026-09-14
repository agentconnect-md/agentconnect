/**
 * Obtaining an OAuth client identity for one MCP provider
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).
 *
 * The spec lists three mechanisms and a priority order. P1 implements two of them:
 *
 *  - PRE-REGISTRATION wins whenever the operator supplied a `client_id`. Someone who
 *    registered an app themselves means it, and it is the only mechanism every
 *    authorization server supports.
 *  - DYNAMIC CLIENT REGISTRATION (RFC 7591) is the automatic fallback when the AS
 *    advertises a `registration_endpoint`. The spec now marks DCR deprecated in favour of
 *    Client ID Metadata Documents, but CIMD support in deployed authorization servers is
 *    still rare, so DCR is what actually connects a server today. The CIMD arm belongs
 *    between these two when it lands; `clientIdMetadataDocumentSupported` is already
 *    carried on the metadata for it.
 *
 * AUTHORIZATION SERVER BINDING: a client_id is only meaningful to the authorization server
 * that issued it. When a provider's protected-resource metadata later names a different
 * issuer, the stored credentials MUST NOT be reused — `clientBindingStale` is that check,
 * and its answer is "re-register", never "try it and see".
 *
 * SECURITY: a registration response may carry a `client_secret`. It is returned to the
 * caller for sealing and is never logged.
 */
import type { AuthServerMetadata, Dial } from './discovery.js'
import type { GuardedFailure } from '../net/guarded-fetch.js'

/** How a client identity was obtained. Recorded so the console can explain what to fix. */
export type ClientSource = 'preregistered' | 'dynamic'

export interface OauthClient {
  clientId: string
  /** Present only when the authorization server issued one. Sealed by the caller. */
  clientSecret?: string
  source: ClientSource
}

export type RegistrationFailure =
  /** No operator-supplied client_id and the AS offers no registration endpoint. */
  | 'no_client_registration'
  /** The registration endpoint answered, but refused or returned something unusable. */
  | 'registration_rejected'
  /** The registration endpoint could not be reached. */
  | 'registration_unreachable'

export type RegistrationResult = { ok: true; value: OauthClient } | { ok: false; failure: RegistrationFailure }

export interface RegistrationRequest {
  metadata: AuthServerMetadata
  /** The exact callback this deployment serves. Registered once and never changed after. */
  redirectUri: string
  /** Operator-supplied credentials, when they chose pre-registration. */
  preregistered?: { clientId: string; clientSecret?: string }
  /** Shown on the authorization server's consent screen. */
  clientName?: string
}

/**
 * True when credentials held for `storedIssuer` must not be used against `discoveredIssuer`.
 * A client_id is unique to its issuer (RFC 6749 §2.2), so a changed authorization server is
 * a re-registration, not a retry.
 */
export function clientBindingStale(storedIssuer: string | undefined, discoveredIssuer: string): boolean {
  return storedIssuer !== undefined && storedIssuer !== discoveredIssuer
}

const unreachable = new Set<GuardedFailure>(['unreachable', 'address_blocked', 'url_rejected'])

/**
 * Register this deployment as a public client. `application_type: 'web'` is explicit
 * because omitting it defaults to `web` under OIDC anyway while non-OIDC servers ignore
 * it — and the CP genuinely is a web application with one fixed https callback, not a
 * native client with loopback redirects. `refresh_token` is requested because a provider
 * without one dies at first expiry with nothing to repair it.
 */
async function registerDynamically(dial: Dial, req: RegistrationRequest): Promise<RegistrationResult> {
  const endpoint = req.metadata.registrationEndpoint
  if (endpoint === undefined) return { ok: false, failure: 'no_client_registration' }
  const result = await dial(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: req.clientName ?? 'AgentConnect',
      redirect_uris: [req.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none'
    })
  })
  if (!result.ok) {
    return {
      ok: false,
      failure: unreachable.has(result.failure) ? 'registration_unreachable' : 'registration_rejected'
    }
  }
  const { status, json } = result.response
  if (status !== 200 && status !== 201) return { ok: false, failure: 'registration_rejected' }
  if (typeof json !== 'object' || json === null) return { ok: false, failure: 'registration_rejected' }
  const doc = json as Record<string, unknown>
  const clientId = typeof doc.client_id === 'string' && doc.client_id.length > 0 ? doc.client_id : undefined
  if (clientId === undefined) return { ok: false, failure: 'registration_rejected' }
  const secret = typeof doc.client_secret === 'string' && doc.client_secret.length > 0 ? doc.client_secret : undefined
  return { ok: true, value: { clientId, ...(secret ? { clientSecret: secret } : {}), source: 'dynamic' } }
}

/** Resolve a client identity by the spec's priority order. */
export function obtainClient(dial: Dial, req: RegistrationRequest): Promise<RegistrationResult> {
  const manual = req.preregistered
  if (manual !== undefined && manual.clientId.length > 0) {
    return Promise.resolve({
      ok: true,
      value: {
        clientId: manual.clientId,
        ...(manual.clientSecret ? { clientSecret: manual.clientSecret } : {}),
        source: 'preregistered'
      }
    })
  }
  return registerDynamically(dial, req)
}
