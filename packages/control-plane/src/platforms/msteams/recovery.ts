import { createHash, createHmac, randomUUID } from 'node:crypto'
import { createRemoteJWKSet, customFetch, EncryptJWT, jwtDecrypt, jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'
import type { Clock } from '../../domain/clock.js'
import type { BotRecord } from '../../persistence/ports.js'
import { isMsTeamsDeploymentRow, type MsTeamsPlatformApp } from './deployment-app.js'

const TTL_SECONDS = 600
const SCOPE = 'openid profile https://graph.microsoft.com/User.Read'
const GUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const ADMIN_ROLES = ['62e90394-69f5-4237-9190-012177145e10', '69091246-20e8-4a56-aa4d-066075b2a7a8']
const Attempt = z.object({
  orgId: z.string(),
  userId: z.string(),
  agentId: z.string(),
  tenantId: GUID,
  appId: z.string(),
  snapshot: z.string(),
  exp: z.number()
})
export type MsTeamsRecoveryAttempt = z.infer<typeof Attempt>
const Ticket = Attempt.extend({ accessToken: z.string().min(1), objectId: GUID })
export type MsTeamsRecoveryTicket = z.infer<typeof Ticket>

export class MsTeamsRecoveryError extends Error {
  constructor(
    readonly status: 403 | 409 | 503,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export const msTeamsRecoveryChanged = () =>
  new MsTeamsRecoveryError(
    409,
    'MSTEAMS_RECOVERY_CHANGED',
    'The connection changed or verification expired. Start connecting again.'
  )

// Tenant ownership includes every deployment-owned bot, including additional agent identities (§8.6).
export function msTeamsRecoveryRows(rows: readonly BotRecord[], appId: string, tenantId: string): BotRecord[] {
  return rows.filter(
    (row) => row.platform === 'msteams' && row.externalTenantId === tenantId && isMsTeamsDeploymentRow(row, { appId })
  )
}

export function msTeamsRecoverySnapshot(rows: readonly BotRecord[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => ({
            id: row.id,
            orgId: row.orgId,
            appId: row.externalAppId,
            tenantId: row.externalTenantId,
            revision: row.credentialRevision,
            config: row.platformConfig,
            agents: [...row.agentIds].sort()
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      )
    )
    .digest('base64url')
}

// Delegated access lives only in an encrypted ten-minute confirmation ticket; no refresh token is requested.
export class MsTeamsRecoveryOAuth {
  private readonly stateKey: Buffer
  private readonly ticketKey: Buffer
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>
  constructor(
    readonly app: MsTeamsPlatformApp,
    private readonly webAppUrl: string,
    pepper: string,
    private readonly clock: Clock,
    private readonly fetch: typeof globalThis.fetch
  ) {
    this.stateKey = createHmac('sha256', pepper).update('msteams-recovery-state-v1').digest()
    this.ticketKey = createHmac('sha256', pepper).update('msteams-recovery-ticket-v1').digest()
    this.jwks = createRemoteJWKSet(new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'), {
      [customFetch]: (url, init) => this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    })
  }

  async start(
    attempt: Omit<MsTeamsRecoveryAttempt, 'appId' | 'exp'>
  ): Promise<{ authorizeUrl: string; state: string }> {
    const state = await new SignJWT({ ...attempt, appId: this.app.appId })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('msteams-recovery-state')
      .setJti(randomUUID())
      .setExpirationTime(Math.floor(this.clock.now() / 1000) + TTL_SECONDS)
      .sign(this.stateKey)
    const query = new URLSearchParams({
      client_id: this.app.appId,
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPE,
      state,
      nonce: this.proof(state, 'nonce'),
      prompt: 'select_account',
      code_challenge: createHash('sha256').update(this.proof(state, 'pkce')).digest('base64url'),
      code_challenge_method: 'S256'
    })
    return {
      authorizeUrl: `https://login.microsoftonline.com/${attempt.tenantId}/oauth2/v2.0/authorize?${query}`,
      state
    }
  }

  async attempt(state: string): Promise<MsTeamsRecoveryAttempt> {
    try {
      const { payload } = await jwtVerify(state, this.stateKey, {
        algorithms: ['HS256'],
        audience: 'msteams-recovery-state',
        currentDate: new Date(this.clock.now())
      })
      const attempt = Attempt.parse(payload)
      if (attempt.appId !== this.app.appId) throw msTeamsRecoveryChanged()
      return attempt
    } catch {
      throw msTeamsRecoveryChanged()
    }
  }

  async verify(state: string, code: string): Promise<MsTeamsRecoveryTicket> {
    const attempt = await this.attempt(state)
    const response = await this.request(`https://login.microsoftonline.com/${attempt.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: this.proof(state, 'pkce'),
        client_id: this.app.appId,
        client_secret: this.app.clientSecret,
        redirect_uri: this.redirectUri(),
        scope: SCOPE
      }).toString()
    })
    if (response.status >= 500 || response.status === 429) throw this.unavailable()
    if (!response.ok) throw msTeamsRecoveryChanged()
    const tokens = z
      .object({ access_token: z.string().min(1), id_token: z.string().min(1) })
      .safeParse(await response.json().catch(() => null))
    if (!tokens.success) throw this.unavailable()
    let objectId: string
    try {
      const { payload } = await jwtVerify(tokens.data.id_token, this.jwks, {
        algorithms: ['RS256'],
        issuer: `https://login.microsoftonline.com/${attempt.tenantId}/v2.0`,
        audience: this.app.appId,
        currentDate: new Date(this.clock.now()),
        requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'tid', 'oid']
      })
      if (payload.tid !== attempt.tenantId || payload.nonce !== this.proof(state, 'nonce'))
        throw msTeamsRecoveryChanged()
      objectId = GUID.parse(payload.oid)
    } catch {
      throw this.notAdmin()
    }
    await this.admin(tokens.data.access_token, objectId)
    return { ...attempt, accessToken: tokens.data.access_token, objectId }
  }

  async admin(token: string, objectId: string): Promise<void> {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const me = await this.request('https://graph.microsoft.com/v1.0/me?$select=id', { headers })
    if (me.status === 401 || me.status === 403) throw this.notAdmin()
    if (!me.ok) throw this.unavailable()
    const profile = z.object({ id: GUID }).safeParse(await me.json().catch(() => null))
    if (!profile.success || profile.data.id !== objectId) throw this.notAdmin()
    // Directory role membership is distinct from scopedRoleMemberOf; team ownership and app consent are not authority.
    const response = await this.request('https://graph.microsoft.com/v1.0/me/checkMemberObjects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ADMIN_ROLES })
    })
    if (response.status === 401 || response.status === 403) throw this.notAdmin()
    if (!response.ok) throw this.unavailable()
    const roles = z.object({ value: z.array(GUID) }).safeParse(await response.json().catch(() => null))
    if (!roles.success) throw this.unavailable()
    if (!roles.data.value.some((role) => ADMIN_ROLES.includes(role))) throw this.notAdmin()
  }

  seal(ticket: MsTeamsRecoveryTicket): Promise<string> {
    return new EncryptJWT(ticket)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setAudience('msteams-recovery-confirm')
      .encrypt(this.ticketKey)
  }

  async open(ticket: string): Promise<MsTeamsRecoveryTicket> {
    try {
      const { payload } = await jwtDecrypt(ticket, this.ticketKey, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
        audience: 'msteams-recovery-confirm',
        currentDate: new Date(this.clock.now())
      })
      const parsed = Ticket.parse(payload)
      if (parsed.appId !== this.app.appId) throw msTeamsRecoveryChanged()
      return parsed
    } catch {
      throw msTeamsRecoveryChanged()
    }
  }

  private proof(state: string, purpose: 'pkce' | 'nonce') {
    return createHmac('sha256', this.stateKey).update(`${purpose}:${state}`).digest('base64url')
  }
  private redirectUri() {
    return new URL('/msteams/connect', this.webAppUrl).toString()
  }
  private notAdmin() {
    return new MsTeamsRecoveryError(
      403,
      'MSTEAMS_RECOVERY_NOT_ADMIN',
      'Recovery requires an active Teams Administrator or Global Administrator of this tenant. Otherwise, contact support.'
    )
  }
  private unavailable() {
    return new MsTeamsRecoveryError(
      503,
      'MSTEAMS_RECOVERY_UNAVAILABLE',
      'Microsoft administrator authority could not be checked. Try again later or contact support.'
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
