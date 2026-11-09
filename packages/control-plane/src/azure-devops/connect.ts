// Connect with Microsoft (azure-devops-integration.md §3.2 steps 1-2): the signed state, PKCE, the code redemption, and the sealed flow ticket that alone holds the administrator's delegated token.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Clock } from '../domain/clock.js'
import type { AzureDevOpsApiClient } from './api.js'

/** The delegated Azure DevOps scope the administrator consents to (§3.2 step 1). */
export const AZURE_DEVOPS_DELEGATED_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'
/** What the sign-in asks for; the redemption asks for the Azure DevOps token alone, since one token serves one resource. */
export const AZURE_DEVOPS_CONNECT_SCOPES = ['openid', 'User.Read', AZURE_DEVOPS_DELEGATED_SCOPE] as const
const REDEEM_SCOPES = ['openid', AZURE_DEVOPS_DELEGATED_SCOPE].join(' ')

const STATE_TTL_MS = 10 * 60_000
/** A flow ticket outlives the state so a manual step can finish, but never its token. */
export const FLOW_TICKET_TTL_MS = 30 * 60_000
const TOKEN_MARGIN_MS = 60_000
// The tenant Entra gives every personal Microsoft account.
export const CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Domain-separated keys from the pepper, one per purpose; the pepper itself never signs or encrypts. */
export function azureDevOpsConnectKeys(pepper: string) {
  const derive = (label: string) => createHmac('sha256', pepper).update(label).digest()
  return { state: derive('azure-devops-connect-state-v1'), ticket: derive('azure-devops-connect-ticket-v1') }
}
export type AzureDevOpsConnectKeys = ReturnType<typeof azureDevOpsConnectKeys>

/** The Console page the deployment application lists as a redirect URI (§3.1). */
export function azureDevOpsConnectRedirectUri(webAppUrl: string): string {
  return `${webAppUrl.replace(/\/+$/, '')}/azure-devops/connect`
}

/** What one sign-in is for: the organization, the caller, and for Manage project access the connection and its tenant. */
export interface AzureDevOpsConnectState {
  orgId: string
  userId: string
  connectionId?: string
  tenantId?: string
}

const StatePayload = z.object({
  o: z.string(),
  u: z.string(),
  c: z.string().optional(),
  t: z.string().regex(GUID).optional(),
  e: z.number(),
  n: z.string()
})

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest()

/** `<base64url payload>.<base64url mac>`, expiring in ten minutes. */
export function mintAzureDevOpsConnectState(
  keys: AzureDevOpsConnectKeys,
  state: AzureDevOpsConnectState,
  clock: Clock
): string {
  const payload: z.infer<typeof StatePayload> = {
    o: state.orgId,
    u: state.userId,
    ...(state.connectionId ? { c: state.connectionId } : {}),
    ...(state.tenantId ? { t: state.tenantId } : {}),
    e: clock.now() + STATE_TTL_MS,
    n: randomBytes(12).toString('base64url')
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${mac(keys.state, encoded).toString('base64url')}`
}

/** Null on any defect: malformed, a bad signature, or expired. */
export function verifyAzureDevOpsConnectState(
  keys: AzureDevOpsConnectKeys,
  state: string,
  clock: Clock
): AzureDevOpsConnectState | null {
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
    orgId: parsed.o,
    userId: parsed.u,
    ...(parsed.c ? { connectionId: parsed.c } : {}),
    ...(parsed.t ? { tenantId: parsed.t } : {})
  }
}

// The PKCE verifier only the Control Plane can derive from a state it signed.
function pkceVerifier(keys: AzureDevOpsConnectKeys, state: string): string {
  return mac(keys.state, `pkce:${state}`).toString('base64url')
}

// A pinned tenant (Manage project access) signs in at its own authority, which also admits that tenant's guests.
const authorityOf = (api: AzureDevOpsApiClient, tenantId?: string) =>
  `${api.loginBaseUrl}/${tenantId ?? 'organizations'}/oauth2/v2.0`

/** Microsoft's authorize URL for the deployment application (§3.2 step 1). */
export function azureDevOpsAuthorizeUrl(
  api: AzureDevOpsApiClient,
  keys: AzureDevOpsConnectKeys,
  input: { clientId: string; redirectUri: string; state: string; tenantId?: string }
): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    response_mode: 'query',
    scope: AZURE_DEVOPS_CONNECT_SCOPES.join(' '),
    state: input.state,
    code_challenge: createHash('sha256').update(pkceVerifier(keys, input.state)).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account'
  })
  return `${authorityOf(api, input.tenantId)}/authorize?${params.toString()}`
}

/** Where an Entra administrator grants tenant-wide consent to the application (§3.1). */
export function azureDevOpsAdminConsentUrl(api: AzureDevOpsApiClient, tenantId: string, clientId: string): string {
  return `${api.loginBaseUrl}/${encodeURIComponent(tenantId)}/adminconsent?client_id=${encodeURIComponent(clientId)}`
}

/** Why the sign-in itself failed, before any Azure DevOps call. */
export class AzureDevOpsSignInError extends Error {
  constructor(
    readonly code: 'consent_required' | 'personal_account' | 'sign_in_refused' | 'tenant_mismatch' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'AzureDevOpsSignInError'
  }
}

/** Entra codes that mean consent is missing: user consent off, admin approval required, or an admin-consent request pending. */
const CONSENT_CODES = new Set([65001, 90094, 90095])
const CONSENT_RE = /\bAADSTS(?:65001|90094|90095)\b|admin approval/i

/** Whether an authorize or token error says an administrator must consent (§3.1). */
export function isConsentError(
  error: string | undefined,
  description?: string,
  codes: readonly number[] = []
): boolean {
  if (error === 'consent_required' || error === 'access_denied') return true
  if (codes.some((code) => CONSENT_CODES.has(code))) return true
  return !!description && CONSENT_RE.test(description)
}

/** The payload of a JWT read without verification, for tokens Entra's token endpoint answered directly over TLS. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const [, body] = token.split('.')
  if (!body) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  expires_in: z.coerce.number().positive().optional()
})

/** §3.2 step 2: the delegated token and the customer tenant from the ID token; a personal account is refused. */
export async function redeemAzureDevOpsCode(
  api: AzureDevOpsApiClient,
  keys: AzureDevOpsConnectKeys,
  input: {
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    state: string
    tenantId?: string
  }
): Promise<{ accessToken: string; tenantId: string; expiresInSec: number }> {
  let response: Response
  try {
    response = await api.fetch(`${authorityOf(api, input.tenantId)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code: input.code,
        code_verifier: pkceVerifier(keys, input.state),
        scope: REDEEM_SCOPES
      }).toString()
    })
  } catch {
    throw new AzureDevOpsSignInError('unavailable', 'Microsoft sign-in is unreachable.')
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!response.ok) {
    const error = typeof json?.error === 'string' ? json.error : undefined
    const description = typeof json?.error_description === 'string' ? json.error_description : undefined
    const codes = Array.isArray(json?.error_codes) ? json.error_codes.map(Number) : []
    if (isConsentError(error, description, codes)) throw consentError()
    if (response.status >= 500 || response.status === 429)
      throw new AzureDevOpsSignInError('unavailable', 'Microsoft sign-in is unavailable. Try again.')
    throw new AzureDevOpsSignInError('sign_in_refused', 'Microsoft did not accept the sign-in. Start connecting again.')
  }
  const tokens = TokenResponse.safeParse(json)
  if (!tokens.success) throw new AzureDevOpsSignInError('unavailable', 'Microsoft sign-in answered without the tokens.')
  const claims = jwtClaims(tokens.data.id_token)
  const tenantId = typeof claims?.tid === 'string' ? claims.tid.toLowerCase() : ''
  if (!GUID.test(tenantId) || (typeof claims?.aud === 'string' && claims.aud.toLowerCase() !== input.clientId)) {
    throw new AzureDevOpsSignInError('unavailable', 'Microsoft sign-in answered without a tenant.')
  }
  if (tenantId === CONSUMER_TENANT) {
    throw new AzureDevOpsSignInError(
      'personal_account',
      'Sign in with the work or school account you use for Azure DevOps; a personal Microsoft account cannot connect.'
    )
  }
  if (input.tenantId && tenantId !== input.tenantId) {
    throw new AzureDevOpsSignInError(
      'tenant_mismatch',
      'Sign in with an account of the Microsoft Entra tenant this Azure DevOps connection belongs to.'
    )
  }
  return { accessToken: tokens.data.access_token, tenantId, expiresInSec: tokens.data.expires_in ?? 3600 }
}

export function consentError(): AzureDevOpsSignInError {
  return new AzureDevOpsSignInError(
    'consent_required',
    'Your Microsoft Entra tenant requires an administrator to consent to this application before it can reach Azure DevOps. Ask an Entra administrator to grant consent, then connect again.'
  )
}

/** A project the administrator picked, and the group the service principal joins there (§3.2 step 4). */
export interface AzureDevOpsProjectChoice {
  projectId: string
  projectName: string
  group: 'readers' | 'contributors'
  /** §11.1 Allow triggers: the service principal's View and Edit subscriptions on the project. */
  allowTriggers?: boolean
}

/** Everything a flow carries between steps; the delegated token exists nowhere else. */
export interface AzureDevOpsFlowTicket {
  flowId: string
  orgId: string
  userId: string
  tenantId: string
  accessToken: string
  /** Manage project access: the connection whose organization the flow is for. */
  connectionId?: string
  organization?: string
  organizationInstanceId?: string
  projects?: AzureDevOpsProjectChoice[]
  /** The access the project list showed, by project id; absent when it could not be read, so Apply removes nothing. */
  shownAccess?: Record<string, { group: 'readers' | 'contributors'; allowTriggers: boolean }>
  /** All projects, present and future, as Apply asked for it. */
  allProjects?: { group: 'readers' | 'contributors'; allowTriggers: boolean }
  /** All projects as the page showed it held; absent when it was not held or could not be read. */
  shownAllProjects?: { group: 'readers' | 'contributors'; allowTriggers: boolean }
  expiresAt: number
}

const Ticket = z.object({
  flowId: z.string(),
  orgId: z.string(),
  userId: z.string(),
  tenantId: z.string(),
  accessToken: z.string(),
  connectionId: z.string().optional(),
  organization: z.string().optional(),
  organizationInstanceId: z.string().optional(),
  projects: z
    .array(
      z.object({
        projectId: z.string(),
        projectName: z.string(),
        group: z.enum(['readers', 'contributors']),
        allowTriggers: z.boolean().optional()
      })
    )
    .optional(),
  shownAccess: z
    .record(z.string(), z.object({ group: z.enum(['readers', 'contributors']), allowTriggers: z.boolean() }))
    .optional(),
  allProjects: z.object({ group: z.enum(['readers', 'contributors']), allowTriggers: z.boolean() }).optional(),
  shownAllProjects: z.object({ group: z.enum(['readers', 'contributors']), allowTriggers: z.boolean() }).optional(),
  expiresAt: z.number()
})

/** The ticket's expiry: thirty minutes from the sign-in, and never past the delegated token's own life. */
export function flowTicketExpiry(clock: Clock, expiresInSec: number): number {
  return clock.now() + Math.min(FLOW_TICKET_TTL_MS, Math.max(0, expiresInSec * 1000 - TOKEN_MARGIN_MS))
}

/** AES-256-GCM under the ticket key; re-sealing keeps the original expiry. */
export function sealAzureDevOpsFlowTicket(keys: AzureDevOpsConnectKeys, ticket: AzureDevOpsFlowTicket): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keys.ticket, iv)
  const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(ticket))), cipher.final()])
  return [iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64url')).join('.')
}

/** Null when tampered, malformed, or expired. */
export function openAzureDevOpsFlowTicket(
  keys: AzureDevOpsConnectKeys,
  ticket: string,
  clock: Clock
): AzureDevOpsFlowTicket | null {
  const parts = ticket.split('.').map((part) => Buffer.from(part, 'base64url'))
  if (parts.length !== 3 || parts[0]!.length !== 12 || parts[1]!.length !== 16) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keys.ticket, parts[0]!)
    decipher.setAuthTag(parts[1]!)
    const plain = Buffer.concat([decipher.update(parts[2]!), decipher.final()])
    const parsed = Ticket.parse(JSON.parse(plain.toString('utf8')))
    if (parsed.expiresAt <= clock.now()) return null
    const { connectionId, organization, organizationInstanceId, projects, ...rest } = parsed
    return {
      ...rest,
      ...(connectionId !== undefined ? { connectionId } : {}),
      ...(organization !== undefined ? { organization } : {}),
      ...(organizationInstanceId !== undefined ? { organizationInstanceId } : {}),
      ...(projects !== undefined ? { projects } : {})
    }
  } catch {
    return null
  }
}
