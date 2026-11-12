// Connecting a tenant to the deployment's Teams app (teams-integration.md §8.3): the signed state, the code redemption, and the Graph catalog and install calls.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../../domain/clock.js'

/** The delegated scopes an administrator consents to: publish to the catalog, list their teams, install with RSC, and read the organization's name (§8.1). */
export const MSTEAMS_CONNECT_SCOPES = [
  'https://graph.microsoft.com/AppCatalog.ReadWrite.All',
  'https://graph.microsoft.com/Team.ReadBasic.All',
  'https://graph.microsoft.com/TeamsAppInstallation.ReadWriteAndConsentSelfForTeam',
  'https://graph.microsoft.com/User.Read',
  'openid'
] as const

/** A Store install only proves its tenant (§8.4): the sign-in and the organization's name, no catalog or install scope. */
export const MSTEAMS_STORE_CONNECT_SCOPES = ['https://graph.microsoft.com/User.Read', 'openid'] as const

/** What a deployment with agent bots asks besides (§8.6.5): submitting a package for review, which is what a person who cannot publish ends up doing, creating the blueprint's principal, adding an agent's app for the person who connects it, and a refresh token for the wait a submission may need. */
export const MSTEAMS_AGENT_BOT_SCOPES = [
  'https://graph.microsoft.com/AppCatalog.Submit',
  'https://graph.microsoft.com/AgentIdentityBlueprintPrincipal.Create',
  'https://graph.microsoft.com/TeamsAppInstallation.ReadWriteAndConsentSelfForUser',
  'offline_access'
] as const

const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0'
// A pinned tenant signs in at its own authority, so Entra offers only that tenant's accounts.
const authorityOf = (tenant?: string) =>
  tenant ? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0` : AUTHORITY
/** What a waiting request's stored sign-in is renewed for (§8.6.6): reading its own submission, adding the app for its person, and the next refresh token. */
export const MSTEAMS_MEMBER_SCOPES = [
  'https://graph.microsoft.com/AppCatalog.Submit',
  'https://graph.microsoft.com/TeamsAppInstallation.ReadWriteAndConsentSelfForUser',
  'https://graph.microsoft.com/User.Read',
  'openid',
  'offline_access'
] as const

/** Which sign-in a state or a redemption is for; both must name the same scope set. */
interface ScopeChoice {
  tenant?: string
  agentBots?: boolean
}
// A Store install asks only for its proof; a deployment with agent bots asks everyone its further scopes too, since the sign-in does not know yet whether the person can publish.
const scopesOf = (choice: ScopeChoice) =>
  (choice.tenant
    ? MSTEAMS_STORE_CONNECT_SCOPES
    : choice.agentBots
      ? [...MSTEAMS_CONNECT_SCOPES, ...MSTEAMS_AGENT_BOT_SCOPES]
      : MSTEAMS_CONNECT_SCOPES
  ).join(' ')
const GRAPH = 'https://graph.microsoft.com/v1.0'
const STATE_TTL_MS = 10 * 60_000
const TIMEOUT_MS = 15_000
// The tenant Entra gives every personal Microsoft account.
const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What a connect attempt is for, signed into its state. */
export interface MsTeamsConnectState {
  orgId: string
  agentId: string
  userId: string
  /** The tenant a Store install's Connect card named (§8.4): the sign-in must be of it, and nothing is published. */
  tenant?: string
  /** The sign-in asks the agent bots' scopes too; the redemption must name the same set. */
  agentBots?: boolean
  /** The state of the tenant-wide consent that precedes the sign-in (§8.6.5); it redeems no code. */
  consent?: boolean
  /** The sign-in follows a tenant-wide consent an administrator just accepted, which the tenant's row then records. */
  consented?: boolean
  /** The organization's one connected tenant, at whose authority a person who signed in elsewhere is signed in once more, silently: a guest of that tenant has an account there (§8.6.6). */
  pin?: string
}

/** Domain-separated keys from the pepper, one per purpose; the pepper itself never signs or encrypts. */
export function msTeamsConnectKeys(pepper: string) {
  const derive = (label: string) => createHmac('sha256', pepper).update(label).digest()
  return { state: derive('msteams-connect-state-v1'), ticket: derive('msteams-connect-ticket-v1') }
}
export type MsTeamsConnectKeys = ReturnType<typeof msTeamsConnectKeys>

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest()

/** `<base64url payload>.<base64url mac>`, expiring in ten minutes. */
export function mintMsTeamsConnectState(keys: MsTeamsConnectKeys, state: MsTeamsConnectState, clock: Clock): string {
  const payload = { ...state, e: clock.now() + STATE_TTL_MS, n: randomBytes(12).toString('base64url') }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${mac(keys.state, encoded).toString('base64url')}`
}

const StatePayload = z.object({
  orgId: z.string(),
  agentId: z.string(),
  userId: z.string(),
  tenant: z.string().regex(GUID).optional(),
  agentBots: z.boolean().optional(),
  consent: z.boolean().optional(),
  consented: z.boolean().optional(),
  pin: z.string().regex(GUID).optional(),
  e: z.number(),
  n: z.string()
})

/** Null on any defect: malformed, a bad signature, or expired. */
export function verifyMsTeamsConnectState(
  keys: MsTeamsConnectKeys,
  state: string,
  clock: Clock
): MsTeamsConnectState | null {
  const [encoded, sig, extra] = state.split('.')
  if (!encoded || !sig || extra !== undefined) return null
  const given = Buffer.from(sig, 'base64url')
  const expected = mac(keys.state, encoded)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let parsed: z.infer<typeof StatePayload>
  try {
    parsed = StatePayload.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
  } catch {
    return null
  }
  if (parsed.e <= clock.now()) return null
  return {
    orgId: parsed.orgId,
    agentId: parsed.agentId,
    userId: parsed.userId,
    ...(parsed.tenant ? { tenant: parsed.tenant } : {}),
    ...(parsed.agentBots ? { agentBots: true } : {}),
    ...(parsed.consent ? { consent: true } : {}),
    ...(parsed.consented ? { consented: true } : {}),
    ...(parsed.pin ? { pin: parsed.pin } : {})
  }
}

// The PKCE verifier only the Control Plane can derive from a state it signed.
function pkceVerifier(keys: MsTeamsConnectKeys, state: string): string {
  return mac(keys.state, `pkce:${state}`).toString('base64url')
}

/** Microsoft's tenant-wide consent page for the connect scopes (§8.6.5): once an administrator accepts, nobody of the tenant is asked again, so a member can add an agent later. It returns to the connect page with the state and no code. */
export function msTeamsAdminConsentUrl(input: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    // The delegated Graph scopes by name, `offline_access` among them, so nobody of the tenant is prompted at a later sign-in (§8.6.6); `openid` is consented with the sign-in that follows.
    scope: [...MSTEAMS_CONNECT_SCOPES.filter((scope) => scope !== 'openid'), ...MSTEAMS_AGENT_BOT_SCOPES].join(' '),
    state: input.state
  })
  return `https://login.microsoftonline.com/organizations/v2.0/adminconsent?${params.toString()}`
}

/** Microsoft's authorize URL for the deployment app, any work or school tenant. */
export function msTeamsAuthorizeUrl(
  keys: MsTeamsConnectKeys,
  input: {
    clientId: string
    redirectUri: string
    state: string
    tenant?: string
    agentBots?: boolean
    pin?: string
    /** The administrator just chose an account on the consent page, so the picker is not forced again. */
    afterConsent?: boolean
    /** The account a silent sign-in is for: Entra answers with a code or an error and shows no page. */
    silentFor?: string
  }
): string {
  const challenge = createHash('sha256').update(pkceVerifier(keys, input.state)).digest('base64url')
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: scopesOf(input),
    state: input.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(input.silentFor
      ? { prompt: 'none', login_hint: input.silentFor }
      : input.afterConsent
        ? {}
        : { prompt: 'select_account' })
  })
  return `${authorityOf(input.tenant ?? input.pin)}/authorize?${params.toString()}`
}

/** Why a step failed, as the route reports it. */
export class MsTeamsConnectError extends Error {
  constructor(
    readonly code:
      | 'MSTEAMS_CONNECT_DENIED'
      | 'MSTEAMS_CONNECT_PERSONAL_ACCOUNT'
      | 'MSTEAMS_CONNECT_NOT_ADMIN'
      | 'MSTEAMS_CONNECT_UNAVAILABLE'
      | 'MSTEAMS_TENANT_MISMATCH',
    message: string,
    /** The Microsoft call that failed and its status, for the log; never shown to the caller. */
    readonly detail?: string
  ) {
    super(message)
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional()
})
const IdClaims = z.object({ tid: z.string(), oid: z.string().optional() })

/** The delegated token and the customer tenant, read from the ID token Entra's token endpoint answered directly. */
export async function redeemMsTeamsCode(
  keys: MsTeamsConnectKeys,
  input: {
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    state: string
    tenant?: string
    agentBots?: boolean
    pin?: string
  },
  fetchImpl: typeof fetch
): Promise<{ accessToken: string; tenantId: string; userId?: string; refreshToken?: string }> {
  let response: Response
  try {
    response = await fetchImpl(`${authorityOf(input.tenant ?? input.pin)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
        code_verifier: pkceVerifier(keys, input.state),
        scope: scopesOf(input)
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra could not be reached.')
  }
  if (response.status >= 500 || response.status === 429)
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra could not be reached.')
  if (!response.ok)
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_DENIED', 'Microsoft Entra did not accept the sign-in. Try again.')
  const tokens = TokenResponse.safeParse(await response.json().catch(() => null))
  if (!tokens.success)
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra answered without the tokens.')
  const [, body] = tokens.data.id_token.split('.')
  const claims = IdClaims.safeParse(body ? JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) : null)
  const tenantId = claims.success ? claims.data.tid.toLowerCase() : ''
  if (!GUID.test(tenantId))
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra answered without a tenant.')
  if (tenantId === CONSUMER_TENANT)
    throw new MsTeamsConnectError(
      'MSTEAMS_CONNECT_PERSONAL_ACCOUNT',
      'Sign in with a work or school account that administers your Microsoft 365 organization.'
    )
  if (input.tenant && tenantId !== input.tenant)
    throw new MsTeamsConnectError(
      'MSTEAMS_TENANT_MISMATCH',
      'Sign in with an account of the Microsoft 365 organization that added the app in Teams.'
    )
  // The signed-in person's object ID in their tenant, whom an agent identity names as its sponsor (§8.6.5).
  const claimed = claims.success && claims.data.oid && GUID.test(claims.data.oid.toLowerCase()) ? claims.data.oid : ''
  // Entra puts the object ID in an ID token only where the sign-in asked the profile scope, so Graph is asked where a sponsor is needed.
  const userId = claimed || (input.agentBots ? await readMsTeamsUserId(fetchImpl, tokens.data.access_token) : '')
  return {
    accessToken: tokens.data.access_token,
    tenantId,
    ...(userId ? { userId: userId.toLowerCase() } : {}),
    ...(tokens.data.refresh_token ? { refreshToken: tokens.data.refresh_token } : {})
  }
}

const Me = z.object({ id: z.string().regex(/^[0-9a-fA-F-]{36}$/) })

// The signed-in person's object ID from Graph; empty when Graph does not answer one.
async function readMsTeamsUserId(fetchImpl: typeof fetch, token: string): Promise<string> {
  try {
    const response = await graph(fetchImpl, token, 'GET', '/me?$select=id')
    const me = response.ok ? Me.safeParse(await response.json().catch(() => null)) : undefined
    return me?.success ? me.data.id : ''
  } catch {
    return ''
  }
}

const MeName = z.object({ userPrincipalName: z.string().min(1) })

/** The signed-in person's sign-in name from Graph, the hint of a silent sign-in; empty when Graph does not answer one. An ID token carries none without the profile scope, which the tenant-wide consent does not cover. */
export async function readMsTeamsUsername(fetchImpl: typeof fetch, token: string): Promise<string> {
  try {
    const response = await graph(fetchImpl, token, 'GET', '/me?$select=userPrincipalName')
    const me = response.ok ? MeName.safeParse(await response.json().catch(() => null)) : undefined
    return me?.success ? me.data.userPrincipalName : ''
  } catch {
    return ''
  }
}

const RefreshResponse = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional() })

/** A member's new access token from their stored refresh token, in their own tenant; Entra issues a new refresh token each time, which replaces the stored one (§8.6.6). A refusal means the stored token no longer works. */
export async function redeemMsTeamsRefreshToken(
  input: { clientId: string; clientSecret: string; tenantId: string; refreshToken: string },
  fetchImpl: typeof fetch
): Promise<{ accessToken: string; refreshToken: string }> {
  let response: Response
  try {
    response = await fetchImpl(`${authorityOf(input.tenantId)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        refresh_token: input.refreshToken,
        scope: MSTEAMS_MEMBER_SCOPES.filter((scope) => scope !== 'openid').join(' ')
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra could not be reached.')
  }
  if (response.status >= 500 || response.status === 429)
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Entra could not be reached.')
  const tokens = response.ok ? RefreshResponse.safeParse(await response.json().catch(() => null)) : undefined
  if (!tokens?.success)
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_DENIED', 'Microsoft Entra no longer accepts the stored sign-in.')
  return { accessToken: tokens.data.access_token, refreshToken: tokens.data.refresh_token ?? input.refreshToken }
}

/** The opaque handle the Console holds between listing teams and installing: the delegated token, encrypted, bound to its attempt. */
export function sealMsTeamsTicket(keys: MsTeamsConnectKeys, ticket: MsTeamsTicket, clock: Clock): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.ticket, iv)
  const plain = Buffer.from(JSON.stringify({ ...ticket, e: clock.now() + STATE_TTL_MS }))
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
  return [iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64url')).join('.')
}

// An install ticket names the published app; a provisioning ticket names the further agent whose bot is still to be made (§8.6.5).
const InstallTicket = z.object({
  accessToken: z.string(),
  orgId: z.string(),
  integrationId: z.string(),
  catalogAppId: z.string()
})
// It carries the refresh token too, which a pending request keeps while a submitted package waits for approval (§8.6.6).
const ProvisionTicket = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  orgId: z.string(),
  agentBot: z.object({
    agentId: z.string(),
    tenantId: z.string().regex(GUID),
    sponsorId: z.string().regex(GUID),
    userId: z.string()
  })
})
export type MsTeamsTicket = z.infer<typeof InstallTicket> | z.infer<typeof ProvisionTicket>
const Ticket = z.union([ProvisionTicket, InstallTicket]).and(z.object({ e: z.number() }))

export function openMsTeamsTicket(keys: MsTeamsConnectKeys, ticket: string, clock: Clock) {
  const parts = ticket.split('.').map((part) => Buffer.from(part, 'base64url'))
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.ticket, parts[0]!)
    decipher.setAuthTag(parts[1]!)
    const plain = Buffer.concat([decipher.update(parts[2]!), decipher.final()])
    const parsed = Ticket.parse(JSON.parse(plain.toString('utf8')))
    return parsed.e > clock.now() ? parsed : null
  } catch {
    return null
  }
}

async function graph(
  fetchImpl: typeof fetch,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: { json: unknown; ifMatch?: string } | { zip: Uint8Array }
): Promise<Response> {
  // The call a log line names: the method and the path without its query, which carries no token.
  const call = `${method} ${path.split('?')[0]}`
  try {
    const response = await fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'json' in body ? 'application/json' : 'application/zip' } : {}),
        ...(body && 'json' in body && body.ifMatch ? { 'if-match': body.ifMatch } : {})
      },
      ...(body ? { body: 'json' in body ? JSON.stringify(body.json) : body.zip } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    calls.set(response, call)
    return response
  } catch {
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Graph could not be reached.', call)
  }
}

// Which call each Graph answer belongs to, so a refusal can say what was refused.
const calls = new WeakMap<Response, string>()

// A 401 or 403 means the signed-in person lacks the admin role or the consent; anything else is Microsoft's side.
function refused(response: Response): MsTeamsConnectError {
  const detail = `${calls.get(response) ?? 'Graph'} answered ${response.status}`
  return response.status === 401 || response.status === 403
    ? new MsTeamsConnectError(
        'MSTEAMS_CONNECT_NOT_ADMIN',
        'Microsoft refused the request. Sign in as a Teams or Global administrator who can consent for the organization.',
        detail
      )
    : new MsTeamsConnectError(
        'MSTEAMS_CONNECT_UNAVAILABLE',
        `Microsoft Graph answered HTTP ${response.status}.`,
        detail
      )
}

const CatalogList = z.object({ value: z.array(z.object({ id: z.string(), externalId: z.string().nullish() })) })
const CatalogApp = z.object({ id: z.string() })

/** Publishes the package to the tenant's organization catalog, or adds a definition to the app already there; answers the catalog app ID. */
export async function publishMsTeamsPackage(
  fetchImpl: typeof fetch,
  token: string,
  externalId: string,
  zip: Uint8Array
): Promise<string> {
  const filter = encodeURIComponent(`externalId eq '${externalId}'`)
  const listed = await graph(fetchImpl, token, 'GET', `/appCatalogs/teamsApps?$filter=${filter}`)
  if (!listed.ok) throw refused(listed)
  const existing = CatalogList.parse(await listed.json()).value.find((app) => app.externalId === externalId)
  const path = existing
    ? `/appCatalogs/teamsApps/${encodeURIComponent(existing.id)}/appDefinitions`
    : '/appCatalogs/teamsApps?requiresReview=false'
  const published = await graph(fetchImpl, token, 'POST', path, { zip })
  if (published.ok) return existing ? existing.id : CatalogApp.parse(await published.json()).id
  if (existing || published.status !== 409) throw await refusedWithReason(published)
  // Measured: the lookup by manifest ID can miss an app the catalog holds, and the create then conflicts; the organization's own list is read instead.
  const conflict = await refusedWithReason(published)
  const own = encodeURIComponent(`distributionMethod eq 'organization'`)
  const all = await graph(fetchImpl, token, 'GET', `/appCatalogs/teamsApps?$filter=${own}`)
  if (!all.ok) throw refused(all)
  const apps = CatalogList.parse(await all.json()).value
  const held = apps.find((app) => app.externalId === externalId)
  if (!held) {
    const detail = `${conflict.detail}; not among the organization’s ${apps.length} apps either`
    throw new MsTeamsConnectError(conflict.code, conflict.message, detail)
  }
  const added = await graph(
    fetchImpl,
    token,
    'POST',
    `/appCatalogs/teamsApps/${encodeURIComponent(held.id)}/appDefinitions`,
    { zip }
  )
  if (!added.ok) throw await refusedWithReason(added)
  return held.id
}

const GraphError = z.object({ error: z.object({ code: z.string().nullish(), message: z.string().nullish() }) })

// A refused publish adds Graph's own error code and message to the log detail: the status alone does not say what the catalog objected to.
async function refusedWithReason(response: Response): Promise<MsTeamsConnectError> {
  const error = refused(response)
  const body = GraphError.safeParse(await response.json().catch(() => null))
  if (!body.success) return error
  const reason = `${body.data.error.code ?? ''}: ${(body.data.error.message ?? '').slice(0, 300)}`
  return new MsTeamsConnectError(error.code, error.message, `${error.detail} (${reason})`)
}

/** Submits the package for the administrator's review, which a member may do (§8.6.6): it is never published by this call; answers the catalog app ID. */
export async function submitMsTeamsPackage(
  fetchImpl: typeof fetch,
  token: string,
  externalId: string,
  zip: Uint8Array
): Promise<string> {
  // The submitter reads their own pending app, so a resubmission adds a definition to it.
  const filter = encodeURIComponent(`externalId eq '${externalId}'`)
  const listed = await graph(fetchImpl, token, 'GET', `/appCatalogs/teamsApps?$filter=${filter}`)
  if (!listed.ok) throw refused(listed)
  const existing = CatalogList.parse(await listed.json()).value.find((app) => app.externalId === externalId)
  const path = existing
    ? `/appCatalogs/teamsApps/${encodeURIComponent(existing.id)}/appDefinitions?requiresReview=true`
    : '/appCatalogs/teamsApps?requiresReview=true'
  const submitted = await graph(fetchImpl, token, 'POST', path, { zip })
  if (!submitted.ok) throw refused(submitted)
  if (existing) return existing.id
  return CatalogApp.parse(await submitted.json()).id
}

const Definitions = z.object({
  appDefinitions: z
    .array(z.object({ id: z.string(), publishingState: z.string().nullish(), '@odata.etag': z.string().nullish() }))
    .nullish()
})

/** Where a submitted package stands, read with the submitter's token: published, still waiting, turned down, or gone from the catalog. */
export type MsTeamsPackageState = 'published' | 'submitted' | 'rejected' | 'gone'

async function readDefinitions(fetchImpl: typeof fetch, token: string, catalogAppId: string) {
  const path = `/appCatalogs/teamsApps/${encodeURIComponent(catalogAppId)}?$expand=appDefinitions`
  const response = await graph(fetchImpl, token, 'GET', path)
  if (response.status === 404) return null
  if (!response.ok) throw refused(response)
  return Definitions.parse(await response.json()).appDefinitions ?? []
}

export async function readMsTeamsPackageState(
  fetchImpl: typeof fetch,
  token: string,
  catalogAppId: string
): Promise<MsTeamsPackageState> {
  const definitions = await readDefinitions(fetchImpl, token, catalogAppId)
  if (!definitions) return 'gone'
  const states = definitions.map((definition) => definition.publishingState)
  if (states.includes('published')) return 'published'
  return states.includes('submitted') ? 'submitted' : 'rejected'
}

/** Withdraws a member's own pending submission by deleting its pending definitions, which their submit scope allows; one already gone counts as withdrawn. */
export async function withdrawMsTeamsSubmission(
  fetchImpl: typeof fetch,
  token: string,
  catalogAppId: string
): Promise<void> {
  const definitions = await readDefinitions(fetchImpl, token, catalogAppId)
  for (const definition of definitions ?? []) {
    if (definition.publishingState !== 'submitted') continue
    const path = `/appCatalogs/teamsApps/${encodeURIComponent(catalogAppId)}/appDefinitions/${encodeURIComponent(definition.id)}`
    const response = await graph(fetchImpl, token, 'DELETE', path)
    if (!response.ok && response.status !== 404) throw refused(response)
  }
}

const Organization = z.object({ value: z.array(z.object({ displayName: z.string().nullish() })) })

/** The signed-in tenant's display name, which names its integration; undefined when Graph does not answer one. */
export async function readMsTeamsOrganizationName(fetchImpl: typeof fetch, token: string): Promise<string | undefined> {
  try {
    const response = await graph(fetchImpl, token, 'GET', '/organization?$select=displayName')
    if (!response.ok) return undefined
    const name = Organization.parse(await response.json()).value[0]?.displayName?.trim()
    return name || undefined
  } catch {
    return undefined
  }
}

const Teams = z.object({ value: z.array(z.object({ id: z.string(), displayName: z.string().nullish() })) })

/** The teams the signed-in administrator belongs to. */
export async function listMsTeamsTeams(
  fetchImpl: typeof fetch,
  token: string
): Promise<{ id: string; name: string }[]> {
  const response = await graph(fetchImpl, token, 'GET', '/me/joinedTeams?$select=id,displayName')
  if (!response.ok) throw refused(response)
  return Teams.parse(await response.json()).value.map((team) => ({ id: team.id, name: team.displayName ?? team.id }))
}

// The consent body an install or upgrade sends: every permission the package asks for.
function consentedPermissions(permissions: readonly { name: string; type: string }[]) {
  return {
    resourceSpecificPermissions: permissions.map((p) => ({
      permissionValue: p.name,
      permissionType: p.type.toLowerCase()
    }))
  }
}

/** Installs the catalog app into a team with the package's resource-specific permissions; an app already there counts as installed. */
export async function installMsTeamsApp(
  fetchImpl: typeof fetch,
  token: string,
  input: { teamId: string; catalogAppId: string; permissions: readonly { name: string; type: string }[] }
): Promise<void> {
  const response = await graph(fetchImpl, token, 'POST', `/teams/${encodeURIComponent(input.teamId)}/installedApps`, {
    json: {
      'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${input.catalogAppId}`,
      consentedPermissionSet: consentedPermissions(input.permissions)
    }
  })
  if (response.ok || response.status === 409) return
  throw await refusedWithReason(response)
}

/** Adds the catalog app for one person, so their Teams client lists the agent at once: its mention, its card and a 1:1 chat. Best effort: answers null when added, or what Microsoft refused for the log, which leaves the team installs as they are. */
export async function installMsTeamsAppForUser(
  fetchImpl: typeof fetch,
  token: string,
  input: { userId: string; catalogAppId: string; permissions: readonly { name: string; type: string }[] }
): Promise<string | null> {
  try {
    const path = `/users/${encodeURIComponent(input.userId)}/teamwork/installedApps`
    // Microsoft refuses the install unless it consents to the package's resource-specific permissions, as a team's does.
    const response = await graph(fetchImpl, token, 'POST', path, {
      json: {
        'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${input.catalogAppId}`,
        consentedPermissionSet: consentedPermissions(input.permissions)
      }
    })
    if (response.ok || response.status === 409) return null
    return (await refusedWithReason(response)).detail ?? 'refused'
  } catch (err) {
    return err instanceof MsTeamsConnectError ? (err.detail ?? err.message) : 'failed'
  }
}

/** Whether a person can add the catalog app, which tells a published package from a removed one where the person's token cannot read the catalog: added (or already theirs), absent from the catalog, or undecided. */
export async function probeMsTeamsPackageForUser(
  fetchImpl: typeof fetch,
  token: string,
  input: { userId: string; catalogAppId: string; permissions: readonly { name: string; type: string }[] }
): Promise<{ result: 'added' | 'absent' } | { result: 'unknown'; detail: string }> {
  try {
    const path = `/users/${encodeURIComponent(input.userId)}/teamwork/installedApps`
    const response = await graph(fetchImpl, token, 'POST', path, {
      json: {
        'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${input.catalogAppId}`,
        consentedPermissionSet: consentedPermissions(input.permissions)
      }
    })
    if (response.ok || response.status === 409) return { result: 'added' }
    if (response.status === 404) return { result: 'absent' }
    return { result: 'unknown', detail: (await refusedWithReason(response)).detail ?? 'refused' }
  } catch (err) {
    return { result: 'unknown', detail: err instanceof MsTeamsConnectError ? (err.detail ?? err.message) : 'failed' }
  }
}

/** The waits between further tries of {@link installMsTeamsAppForUser}: Microsoft refuses a just-published app for its first minutes. */
export const MSTEAMS_PERSONAL_INSTALL_RETRY_MS = [30_000, 60_000, 120_000, 240_000, 480_000] as const

/** Adds the catalog app for one person, trying again while Microsoft still refuses a just-published app; answers null once added, or the last refusal. */
export async function installMsTeamsAppForUserEventually(
  fetchImpl: typeof fetch,
  token: string,
  input: { userId: string; catalogAppId: string; permissions: readonly { name: string; type: string }[] },
  wait: (ms: number) => Promise<void>,
  delaysMs: readonly number[] = MSTEAMS_PERSONAL_INSTALL_RETRY_MS
): Promise<string | null> {
  let detail = await installMsTeamsAppForUser(fetchImpl, token, input)
  for (const delay of delaysMs) {
    // Only the policy refusal passes with time; anything else is reported as it is.
    if (!detail?.includes('answered 403')) break
    await wait(delay)
    detail = await installMsTeamsAppForUser(fetchImpl, token, input)
  }
  return detail
}

const Installed = z.object({ value: z.array(z.object({ id: z.string() })) })
// Teams upgraded at once; an administrator can belong to hundreds.
const UPGRADE_CONCURRENCY = 4

/** Where a team's app stands after {@link upgradeMsTeamsInstalls}: upgraded, absent, or unknown after a refused or failed read or upgrade. */
export type MsTeamsAppUpgrade = 'updated' | 'none' | 'failed'

/** Upgrades the catalog app to its latest definition in each team that has it, re-consenting its resource-specific permissions; a refused or failed team is reported, not thrown, since the connect itself already stands. */
export async function upgradeMsTeamsInstalls(
  fetchImpl: typeof fetch,
  token: string,
  input: { teamIds: readonly string[]; catalogAppId: string; permissions: readonly { name: string; type: string }[] },
  log: { warn(bindings: Record<string, unknown>, message: string): void }
): Promise<Map<string, MsTeamsAppUpgrade>> {
  const filter = encodeURIComponent(`teamsApp/id eq '${input.catalogAppId}'`)
  const outcome = new Map<string, MsTeamsAppUpgrade>()
  const upgrade = async (teamId: string): Promise<MsTeamsAppUpgrade> => {
    const team = encodeURIComponent(teamId)
    const listed = await graph(
      fetchImpl,
      token,
      'GET',
      `/teams/${team}/installedApps?$expand=teamsApp&$filter=${filter}`
    )
    if (!listed.ok) {
      log.warn({ status: listed.status }, 'msteams: could not read a team’s installed apps')
      return 'failed'
    }
    const installation = Installed.parse(await listed.json()).value[0]
    if (!installation) return 'none'
    const response = await graph(
      fetchImpl,
      token,
      'POST',
      `/teams/${team}/installedApps/${encodeURIComponent(installation.id)}/upgrade`,
      { json: { consentedPermissionSet: consentedPermissions(input.permissions) } }
    )
    if (response.ok) return 'updated'
    log.warn({ status: response.status }, 'msteams: could not upgrade the app in a team')
    return 'failed'
  }
  const queue = [...input.teamIds]
  await Promise.all(
    Array.from({ length: Math.min(UPGRADE_CONCURRENCY, queue.length) }, async () => {
      for (let teamId = queue.shift(); teamId !== undefined; teamId = queue.shift())
        outcome.set(teamId, await upgrade(teamId))
    })
  )
  return outcome
}
