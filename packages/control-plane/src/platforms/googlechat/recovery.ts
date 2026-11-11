import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createRemoteJWKSet, customFetch, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import type { Clock } from '../../domain/clock.js'
import type { BotRecord } from '../../persistence/ports.js'
import { GoogleChatClaimState } from './claim.js'
import { googleChatRowKind, googleChatRowTenantKeys } from './provider.js'
import { googleChatTenantKeys, type GoogleChatTenant } from './tenant.js'

const TTL_SECONDS = 600
const SCOPE = 'openid https://www.googleapis.com/auth/admin.directory.user.readonly'
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const Attempt = z.object({
  orgId: z.string(),
  userId: z.string(),
  accountId: z.string().regex(/^\d{1,64}$/),
  appId: z.string(),
  clientId: z.string(),
  claim: GoogleChatClaimState,
  snapshot: z.string(),
  exp: z.number()
})
export type GoogleChatRecoveryAttempt = z.infer<typeof Attempt>
const Ticket = Attempt.extend({ accessToken: z.string().min(1), customerId: ID })
export type GoogleChatRecoveryTicket = z.infer<typeof Ticket>

export class GoogleChatRecoveryError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export const recoveryExpired = () =>
  new GoogleChatRecoveryError(
    409,
    'GOOGLE_CHAT_RECOVERY_CHANGED',
    'The connection changed or verification expired. Start again from Google Chat.'
  )

// Recovery operates on the exact conflicting bindings, never a tenantless organization-owned app.
export function googleChatRecoveryRows(
  rows: readonly BotRecord[],
  appId: string,
  tenant: GoogleChatTenant
): BotRecord[] {
  const keys = googleChatTenantKeys(tenant)
  return rows.filter(
    (row) =>
      row.externalAppId === appId &&
      googleChatRowKind(row) === 'customer' &&
      googleChatRowTenantKeys(row).some((key) => keys.includes(key))
  )
}

export function googleChatRecoverySnapshot(rows: readonly BotRecord[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => ({
            id: row.id,
            orgId: row.orgId,
            platform: row.platform,
            appId: row.externalAppId,
            kind: googleChatRowKind(row),
            keys: googleChatRowTenantKeys(row).sort(),
            revision: row.credentialRevision,
            agents: [...row.agentIds].sort()
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      )
    )
    .digest('base64url')
}

export function checkRecoveryCustomer(rows: readonly BotRecord[], customerId: string): void {
  if (
    rows.some((row) =>
      googleChatRowTenantKeys(row).some((key) => key.startsWith('customers/') && key !== `customers/${customerId}`)
    )
  )
    throw recoveryExpired()
}

export interface GoogleChatRecoveryApplication {
  clientId: string
  clientSecret: string
  webAppUrl: string
}

// Short-lived delegated access stays in an authenticated encrypted ticket; no refresh token is requested or retained.
export class GoogleChatRecoveryOAuth {
  private readonly stateKey: Buffer
  private readonly ticketKey: Buffer
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>
  constructor(
    readonly application: GoogleChatRecoveryApplication,
    pepper: string,
    private readonly clock: Clock,
    private readonly fetch: typeof globalThis.fetch
  ) {
    this.stateKey = createHmac('sha256', pepper).update('googlechat-recovery-state-v1').digest()
    this.ticketKey = createHmac('sha256', pepper).update('googlechat-recovery-ticket-v1').digest()
    this.jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
      [customFetch]: (url, init) => this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    })
  }

  async start(
    attempt: Omit<GoogleChatRecoveryAttempt, 'clientId' | 'exp'>
  ): Promise<{ authorizeUrl: string; state: string }> {
    const state = await new SignJWT({ ...attempt, clientId: this.application.clientId })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('googlechat-recovery-state')
      .setJti(randomUUID())
      .setExpirationTime(Math.floor(this.clock.now() / 1000) + TTL_SECONDS)
      .sign(this.stateKey)
    const query = new URLSearchParams({
      client_id: this.application.clientId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: SCOPE,
      state,
      nonce: this.proof(state, 'nonce'),
      prompt: 'select_account',
      access_type: 'online',
      code_challenge: createHash('sha256').update(this.proof(state, 'pkce')).digest('base64url'),
      code_challenge_method: 'S256'
    })
    return { authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${query}`, state }
  }

  async attempt(state: string): Promise<GoogleChatRecoveryAttempt> {
    try {
      const { payload } = await jwtVerify(state, this.stateKey, {
        algorithms: ['HS256'],
        audience: 'googlechat-recovery-state',
        currentDate: new Date(this.clock.now())
      })
      const attempt = Attempt.parse(payload)
      if (attempt.clientId !== this.application.clientId) throw recoveryExpired()
      return attempt
    } catch {
      throw recoveryExpired()
    }
  }

  async verify(state: string, code: string): Promise<GoogleChatRecoveryTicket> {
    const attempt = await this.attempt(state)
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: this.proof(state, 'pkce'),
        client_id: this.application.clientId,
        client_secret: this.application.clientSecret,
        redirect_uri: this.redirectUri()
      }).toString()
    })
    if (!response.ok) throw recoveryExpired()
    const tokens = z
      .object({ access_token: z.string().min(1), id_token: z.string().min(1) })
      .safeParse(await response.json().catch(() => null))
    if (!tokens.success) throw this.unavailable()
    try {
      const { payload } = await jwtVerify(tokens.data.id_token, this.jwks, {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: this.application.clientId,
        currentDate: new Date(this.clock.now()),
        requiredClaims: ['exp', 'iat', 'sub', 'nonce']
      })
      if (payload.sub !== attempt.accountId || payload.nonce !== this.proof(state, 'nonce')) throw recoveryExpired()
    } catch {
      throw new GoogleChatRecoveryError(
        403,
        'GOOGLE_CHAT_RECOVERY_IDENTITY',
        'Use the same Google account linked to AgentConnect.'
      )
    }
    const customerId = await this.admin(tokens.data.access_token, attempt.accountId)
    return { ...attempt, accessToken: tokens.data.access_token, customerId }
  }

  async admin(token: string, accountId: string): Promise<string> {
    const response = await this.request(
      `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(accountId)}?viewType=admin_view&fields=id,isAdmin,suspended,customerId`,
      {
        headers: { authorization: `Bearer ${token}` }
      }
    )
    if (response.status === 401 || response.status === 403 || response.status === 404) throw this.notAdmin()
    if (!response.ok) throw this.unavailable()
    const profile = z
      .object({ id: z.string(), isAdmin: z.literal(true), suspended: z.literal(false), customerId: ID })
      .safeParse(await response.json().catch(() => null))
    if (!profile.success || profile.data.id !== accountId) throw this.notAdmin()
    return profile.data.customerId
  }

  seal(ticket: GoogleChatRecoveryTicket): Promise<string> {
    return new EncryptJWT(ticket)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setAudience('googlechat-recovery-confirm')
      .encrypt(this.ticketKey)
  }

  async open(ticket: string): Promise<GoogleChatRecoveryTicket> {
    try {
      const { payload } = await jwtDecrypt(ticket, this.ticketKey, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
        audience: 'googlechat-recovery-confirm',
        currentDate: new Date(this.clock.now())
      })
      const parsed = Ticket.parse(payload)
      if (parsed.clientId !== this.application.clientId) throw recoveryExpired()
      return parsed
    } catch {
      throw recoveryExpired()
    }
  }

  private proof(state: string, purpose: 'pkce' | 'nonce') {
    return createHmac('sha256', this.stateKey).update(`${purpose}:${state}`).digest('base64url')
  }
  private redirectUri() {
    return new URL('/googlechat/recover', this.application.webAppUrl).toString()
  }
  private notAdmin() {
    return new GoogleChatRecoveryError(
      403,
      'GOOGLE_CHAT_RECOVERY_NOT_ADMIN',
      'Recovery requires a Google Workspace super administrator. Otherwise, contact support.'
    )
  }
  private unavailable() {
    return new GoogleChatRecoveryError(
      503,
      'GOOGLE_CHAT_RECOVERY_UNAVAILABLE',
      'Google administrator verification is unavailable. Try again later or contact support.'
    )
  }
  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    } catch {
      throw this.unavailable()
    }
  }
}
