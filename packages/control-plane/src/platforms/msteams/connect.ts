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

const AUTHORITY = 'https://login.microsoftonline.com/organizations/oauth2/v2.0'
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
  return { orgId: parsed.orgId, agentId: parsed.agentId, userId: parsed.userId }
}

// The PKCE verifier only the Control Plane can derive from a state it signed.
function pkceVerifier(keys: MsTeamsConnectKeys, state: string): string {
  return mac(keys.state, `pkce:${state}`).toString('base64url')
}

/** Microsoft's authorize URL for the deployment app, any work or school tenant. */
export function msTeamsAuthorizeUrl(
  keys: MsTeamsConnectKeys,
  input: { clientId: string; redirectUri: string; state: string }
): string {
  const challenge = createHash('sha256').update(pkceVerifier(keys, input.state)).digest('base64url')
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: MSTEAMS_CONNECT_SCOPES.join(' '),
    state: input.state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  })
  return `${AUTHORITY}/authorize?${params.toString()}`
}

/** Why a step failed, as the route reports it. */
export class MsTeamsConnectError extends Error {
  constructor(
    readonly code:
      | 'MSTEAMS_CONNECT_DENIED'
      | 'MSTEAMS_CONNECT_PERSONAL_ACCOUNT'
      | 'MSTEAMS_CONNECT_NOT_ADMIN'
      | 'MSTEAMS_CONNECT_UNAVAILABLE',
    message: string
  ) {
    super(message)
  }
}

const TokenResponse = z.object({ access_token: z.string().min(1), id_token: z.string().min(1) })
const IdClaims = z.object({ tid: z.string(), oid: z.string().optional() })

/** The delegated token and the customer tenant, read from the ID token Entra's token endpoint answered directly. */
export async function redeemMsTeamsCode(
  keys: MsTeamsConnectKeys,
  input: { clientId: string; clientSecret: string; redirectUri: string; code: string; state: string },
  fetchImpl: typeof fetch
): Promise<{ accessToken: string; tenantId: string }> {
  let response: Response
  try {
    response = await fetchImpl(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
        code_verifier: pkceVerifier(keys, input.state),
        scope: MSTEAMS_CONNECT_SCOPES.join(' ')
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
  return { accessToken: tokens.data.access_token, tenantId }
}

/** The opaque handle the Console holds between listing teams and installing: the delegated token, encrypted, bound to its attempt. */
export function sealMsTeamsTicket(
  keys: MsTeamsConnectKeys,
  ticket: { accessToken: string; orgId: string; integrationId: string; catalogAppId: string },
  clock: Clock
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.ticket, iv)
  const plain = Buffer.from(JSON.stringify({ ...ticket, e: clock.now() + STATE_TTL_MS }))
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
  return [iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64url')).join('.')
}

const Ticket = z.object({
  accessToken: z.string(),
  orgId: z.string(),
  integrationId: z.string(),
  catalogAppId: z.string(),
  e: z.number()
})

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
  method: 'GET' | 'POST',
  path: string,
  body?: { json: unknown } | { zip: Uint8Array }
): Promise<Response> {
  try {
    return await fetchImpl(`${GRAPH}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'json' in body ? 'application/json' : 'application/zip' } : {})
      },
      ...(body ? { body: 'json' in body ? JSON.stringify(body.json) : body.zip } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    throw new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', 'Microsoft Graph could not be reached.')
  }
}

// A 401 or 403 means the signed-in person lacks the admin role or the consent; anything else is Microsoft's side.
function refused(response: Response): MsTeamsConnectError {
  return response.status === 401 || response.status === 403
    ? new MsTeamsConnectError(
        'MSTEAMS_CONNECT_NOT_ADMIN',
        'Microsoft refused the request. Sign in as a Teams or Global administrator who can consent for the organization.'
      )
    : new MsTeamsConnectError('MSTEAMS_CONNECT_UNAVAILABLE', `Microsoft Graph answered HTTP ${response.status}.`)
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
  if (!published.ok) throw refused(published)
  if (existing) return existing.id
  return CatalogApp.parse(await published.json()).id
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

/** Installs the catalog app into a team with the package's resource-specific permissions; an app already there counts as installed. */
export async function installMsTeamsApp(
  fetchImpl: typeof fetch,
  token: string,
  input: { teamId: string; catalogAppId: string; permissions: readonly { name: string; type: string }[] }
): Promise<void> {
  const response = await graph(fetchImpl, token, 'POST', `/teams/${encodeURIComponent(input.teamId)}/installedApps`, {
    json: {
      'teamsApp@odata.bind': `${GRAPH}/appCatalogs/teamsApps/${input.catalogAppId}`,
      consentedPermissionSet: {
        resourceSpecificPermissions: input.permissions.map((p) => ({
          permissionValue: p.name,
          permissionType: p.type.toLowerCase()
        }))
      }
    }
  })
  if (response.ok || response.status === 409) return
  throw refused(response)
}
