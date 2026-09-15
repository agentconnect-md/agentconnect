/**
 * `McpProviderOauthService` — the console-driven authorization funnel for one MCP provider
 * (docs/designs/mcp-provider-oauth.md).
 *
 * Three hops, and each one exists for a reason the two-hop shortcut would lose — the same
 * reasons `gitlab/oauth.service.ts` records:
 *
 *  - START is authenticated. It runs discovery and client registration, records what it
 *    learned, and mints a one-shot state row holding a SEALED PKCE verifier and the issuer
 *    the response will be compared against. It hands back a URL rather than a redirect,
 *    because the console opens it in a popup.
 *  - BEGIN is an unauthenticated top-level navigation. It stamps a browser-binding cookie
 *    onto the state row EXACTLY once, then redirects to the authorization server. Binding
 *    here rather than at start is what ties the authorization to the browser that asked.
 *  - CALLBACK consumes the row exactly once, requires the same browser, validates the
 *    RFC 9207 `iss`, redeems the code, and commits the grant.
 *
 * Two refusals that look pedantic and are not. A grant with NO refresh token is rejected
 * rather than stored: it would work for an hour and then fail with nothing able to repair
 * it, and the operator would have no way to tell that from the server being down. And a
 * deployment with no public CP origin is refused up front rather than guessing one from
 * request headers — the redirect_uri is registered once and an authorization server will
 * not accept a different one later.
 *
 * SECURITY: codes, verifiers, client secrets and tokens pass through here. NEVER log them,
 * and never put a failure's detail anywhere but the closed result-code set below.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { systemClock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type {
  McpProviderOauthRepo,
  McpProviderOauthSecretStore,
  McpProviderOauthStateStore,
  McpProviderRepo
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import { buildAuthorizeUrl, issuerResponseValid, pkceChallenge, pkcePair } from './authorize.js'
import { discoverMcpAuthorization, type Dial, type DiscoveryFailure } from './discovery.js'
import { clientBindingStale, obtainClient, type RegistrationFailure } from './registration.js'
import { exchangeCode, type TokenClient } from './token-endpoint.js'

/** Public (gateway-form) paths. Registered with the authorization server and never changed. */
export const MCP_OAUTH_BEGIN_PATH = '/v1/mcp-providers/oauth/begin'
export const MCP_OAUTH_CALLBACK_PATH = '/v1/mcp-providers/oauth/callback'
export const MCP_OAUTH_STATE_TTL_MS = 15 * 60 * 1000
export const MCP_OAUTH_BROWSER_COOKIE = 'ac_mcp_oauth'

/** The closed set the console renders. Everything else is a start-hop `McpOauthDenied`. */
export type McpOauthResultCode =
  | 'connected'
  /** Unknown, expired, or already-used state — one uniform failure, deliberately. */
  | 'state_invalid'
  | 'browser_mismatch'
  /** RFC 9207: the response came from, or claimed, an authorization server we did not start with. */
  | 'issuer_mismatch'
  /** The user declined, or the authorization server returned an error. */
  | 'authorization_denied'
  | 'exchange_failed'
  /** A grant with no refresh token would die at first expiry with nothing able to repair it. */
  | 'no_refresh_token'
  /** A disconnect or a newer authorization landed while this exchange was in flight. */
  | 'superseded'

/** A start-hop refusal the console shows directly. `reason` is safe to display. */
export class McpOauthDenied extends Error {
  constructor(
    readonly reason: DiscoveryFailure | RegistrationFailure | McpOauthStartRefusal,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(reason)
    this.name = 'McpOauthDenied'
  }
}

export type McpOauthStartRefusal =
  /** No PUBLIC_CP_URL, so there is no callback an authorization server could reach. */
  | 'cp_public_url_missing'
  /** The provider is not an `auth: oauth2` row — nothing to authorize. */
  | 'provider_not_oauth'
  | 'provider_not_found'
  /** The console asked to be returned somewhere that is not a local console path. */
  | 'invalid_return_path'

/** Local console paths only: absolute-path, no scheme, no protocol-relative. */
export function normalizeReturnPath(input: string | undefined): string {
  if (input === undefined || input === '') return '/'
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\') || input.length > 512) {
    throw new McpOauthDenied('invalid_return_path', 400)
  }
  return input
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

export interface McpProviderOauthServiceDeps {
  providers: McpProviderRepo
  oauth: McpProviderOauthRepo
  secrets: McpProviderOauthSecretStore
  states: McpProviderOauthStateStore
  cipher: SecretCipher
  dial: Dial
  clock?: Clock
  /** Public CP origin — the begin/callback URLs derive from it. Absent ⇒ the funnel refuses. */
  publicCpUrl?: string
  /** Console origin for the final redirect; absent ⇒ the redirect stays on the CP origin. */
  webAppUrl?: string
  /** Called after a grant lands, to put the new access token into the relay binding. */
  onConnected?: (orgId: OrgId, providerId: string) => Promise<void>
}

export interface StartMcpOauthInput {
  orgId: OrgId
  providerId: string
  userId: string
  returnPath?: string
  /** Operator-supplied pre-registration. Supplying a client id re-registers under it. */
  clientId?: string
  clientSecret?: string
}

export class McpProviderOauthService {
  private readonly clock: Clock

  constructor(private readonly deps: McpProviderOauthServiceDeps) {
    this.clock = deps.clock ?? systemClock
  }

  private get callbackUrl(): string {
    const base = this.deps.publicCpUrl?.replace(/\/$/, '')
    if (base === undefined || base === '') throw new McpOauthDenied('cp_public_url_missing')
    return `${base}${MCP_OAUTH_CALLBACK_PATH}`
  }

  /** Where the browser lands when the funnel finishes, carrying its outcome. */
  redirectTarget(returnPath: string, result: McpOauthResultCode): string {
    const base = (this.deps.webAppUrl ?? this.deps.publicCpUrl ?? '').replace(/\/+$/, '')
    const sep = returnPath.includes('?') ? '&' : '?'
    return `${base}${returnPath}${sep}mcpOauth=${result}`
  }

  /** Authenticated hop: discover, register, record, and hand back the begin URL. */
  async start(input: StartMcpOauthInput): Promise<{ url: string }> {
    const returnPath = normalizeReturnPath(input.returnPath)
    const redirectUri = this.callbackUrl
    const provider = await this.deps.providers.get(input.orgId, input.providerId)
    if (provider === null) throw new McpOauthDenied('provider_not_found', 404)
    if (provider.auth !== 'oauth2') throw new McpOauthDenied('provider_not_oauth')

    const discovered = await discoverMcpAuthorization(this.deps.dial, provider.url)
    if (!discovered.ok) throw new McpOauthDenied(discovered.failure)
    const { metadata, resource, scopes } = discovered.value

    const existing = await this.deps.oauth.get(input.orgId, input.providerId)
    // A client identity belongs to the authorization server that issued it. If the resource
    // now names a different one, the stored credentials are not reusable — re-register.
    const reusable =
      existing !== null && input.clientId === undefined && !clientBindingStale(existing.issuer, metadata.issuer)
    const stored = reusable ? await this.deps.secrets.get(input.orgId, input.providerId) : null
    const scope = orgScope(input.orgId)
    const preregistered =
      input.clientId !== undefined
        ? { clientId: input.clientId, ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}) }
        : reusable && existing !== null
          ? {
              clientId: existing.clientId,
              ...(stored?.clientSecret ? { clientSecret: await this.deps.cipher.open(stored.clientSecret, scope) } : {})
            }
          : undefined

    const client = await obtainClient(this.deps.dial, {
      metadata,
      redirectUri,
      clientName: 'AgentConnect',
      ...(preregistered ? { preregistered } : {})
    })
    if (!client.ok) throw new McpOauthDenied(client.failure)
    // A reused identity keeps the source it was obtained under; only a fresh operator entry
    // or a fresh registration re-labels it.
    const clientSource =
      reusable && input.clientId === undefined && existing ? existing.clientSource : client.value.source

    const prepared = await this.deps.oauth.prepare(input.orgId, input.providerId, {
      resource,
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      ...(metadata.registrationEndpoint ? { registrationEndpoint: metadata.registrationEndpoint } : {}),
      scopes,
      clientId: client.value.clientId,
      clientSource,
      issParameterSupported: metadata.issParameterSupported,
      ...(client.value.clientSecret
        ? { sealedClientSecret: await this.deps.cipher.seal(client.value.clientSecret, scope) }
        : {})
    })

    const nonce = randomBytes(16).toString('base64url')
    const { verifier } = pkcePair()
    await this.deps.states.put({
      nonce,
      mcpProviderId: input.providerId,
      orgId: input.orgId,
      userId: input.userId,
      returnPath,
      verifier: await this.deps.cipher.seal(verifier, scope),
      // Recorded BEFORE the redirect: the RFC 9207 comparison is only meaningful against a
      // value that came from metadata this hop validated.
      expectedIssuer: metadata.issuer,
      // The generation this funnel owns. Disconnect and a re-prepare both advance it, so a
      // callback that arrives after either one commits nothing.
      expectedVersion: prepared.tokenVersion,
      expiresAt: new Date(this.clock.now() + MCP_OAUTH_STATE_TTL_MS)
    })
    const base = this.deps.publicCpUrl!.replace(/\/$/, '')
    return { url: `${base}${MCP_OAUTH_BEGIN_PATH}?state=${nonce}` }
  }

  /** Unauthenticated begin hop: bind the browser once, then redirect to the server. */
  async begin(nonce: string): Promise<{ redirectUrl: string; browserNonce: string } | null> {
    const browserNonce = randomBytes(16).toString('base64url')
    const row = await this.deps.states.bindBrowser(nonce, sha256(browserNonce), new Date(this.clock.now()))
    if (!row) return null
    const orgId = OrgId(row.orgId)
    const oauth = await this.deps.oauth.get(orgId, row.mcpProviderId)
    if (oauth === null) return null
    const verifier = await this.deps.cipher.open(row.verifier, orgScope(orgId))
    const redirectUrl = buildAuthorizeUrl({
      metadata: {
        issuer: oauth.issuer,
        authorizationEndpoint: oauth.authorizationEndpoint,
        tokenEndpoint: oauth.tokenEndpoint,
        issParameterSupported: oauth.issParameterSupported,
        clientIdMetadataDocumentSupported: false
      },
      clientId: oauth.clientId,
      redirectUri: this.callbackUrl,
      state: nonce,
      codeChallenge: pkceChallenge(verifier),
      scopes: oauth.scopes,
      resource: oauth.resource
    })
    return { redirectUrl, browserNonce }
  }

  /** Consume the state exactly once, validate, redeem, and commit the grant. */
  async callback(input: {
    state: string | undefined
    code: string | undefined
    iss: string | undefined
    error: string | undefined
    browserNonce: string | undefined
  }): Promise<{ redirectPath: string; result: McpOauthResultCode }> {
    const fail = (result: McpOauthResultCode, path = '/'): { redirectPath: string; result: McpOauthResultCode } => ({
      redirectPath: path,
      result
    })
    if (input.state === undefined) return fail('state_invalid')
    const row = await this.deps.states.consume(input.state, new Date(this.clock.now()))
    if (row === null) return fail('state_invalid')
    const { returnPath } = row
    if (
      row.browserHash === null ||
      input.browserNonce === undefined ||
      row.browserHash !== sha256(input.browserNonce)
    ) {
      return fail('browser_mismatch', returnPath)
    }
    const orgId = OrgId(row.orgId)
    const oauth = await this.deps.oauth.get(orgId, row.mcpProviderId)
    if (oauth === null) return fail('state_invalid', returnPath)

    // RFC 9207 first — it gates an error response too, so a mismatched `error` is never
    // acted on or shown.
    if (
      !issuerResponseValid({
        advertised: oauth.issParameterSupported,
        present: input.iss,
        expected: row.expectedIssuer
      })
    ) {
      return fail('issuer_mismatch', returnPath)
    }
    if (input.error !== undefined) return fail('authorization_denied', returnPath)
    if (input.code === undefined) return fail('authorization_denied', returnPath)

    const scope = orgScope(orgId)
    const sealed = await this.deps.secrets.get(orgId, row.mcpProviderId)
    const client: TokenClient = {
      tokenEndpoint: oauth.tokenEndpoint,
      clientId: oauth.clientId,
      ...(sealed?.clientSecret ? { clientSecret: await this.deps.cipher.open(sealed.clientSecret, scope) } : {}),
      resource: oauth.resource
    }
    const verifier = await this.deps.cipher.open(row.verifier, scope)
    const redeemed = await exchangeCode(
      this.deps.dial,
      client,
      { code: input.code, redirectUri: this.callbackUrl, codeVerifier: verifier },
      this.clock.now()
    )
    if (!redeemed.ok) return fail('exchange_failed', returnPath)
    if (redeemed.grant.refreshToken === undefined) return fail('no_refresh_token', returnPath)

    const committed = await this.deps.oauth.connect(orgId, row.mcpProviderId, {
      expectedVersion: row.expectedVersion,
      accessExpiresAt: redeemed.grant.expiresAt,
      connectedByUserId: row.userId,
      sealedPair: {
        accessToken: await this.deps.cipher.seal(redeemed.grant.accessToken, scope),
        refreshToken: await this.deps.cipher.seal(redeemed.grant.refreshToken, scope)
      }
    })
    // Superseded while the exchange was in flight — a disconnect, or a newer authorization.
    // Their intent is the current one; publishing this grant would undo it.
    if (!committed) return fail('superseded', returnPath)
    await this.deps.onConnected?.(orgId, row.mcpProviderId)
    return { redirectPath: returnPath, result: 'connected' }
  }

  /** Drop the grant and stop projecting it. The row stays so the console can explain it. */
  async disconnect(orgId: OrgId, providerId: string): Promise<boolean> {
    return this.deps.oauth.disconnect(orgId, providerId)
  }
}
