import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import { z } from 'zod'
import type { Clock } from '../domain/clock.js'
import type { MicrosoftIdentity } from '../github/logto-identity.js'
import type {
  AzureDevOpsConnectionRepo,
  AzureDevOpsUserIdentityStore,
  SocialIdentityMutationGate
} from '../persistence/ports.js'
import { DEPLOYMENT_SCOPE, type SecretCipher } from '../secrets/cipher.js'
import { AzureDevOpsApiError, type AzureDevOpsApiClient } from './api.js'
import { azureDevOpsConnectRedirectUri } from './connect.js'
import { AzureDevOpsConnectDenied } from './connection.service.js'

const SCOPES = 'openid profile offline_access https://graph.microsoft.com/User.Read'
const STATE_TTL_MS = 10 * 60_000
const TokenResponse = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional()
})
const Profile = z.object({ id: z.uuid(), mail: z.string().nullish(), userPrincipalName: z.string().nullish() })

export const azureIdentityVerificationRequired = () =>
  new AzureDevOpsConnectDenied(
    'verify your Microsoft account in this Azure DevOps tenant to continue',
    403,
    'AZURE_DEVOPS_IDENTITY_VERIFICATION_REQUIRED'
  )

interface Deps {
  api: AzureDevOpsApiClient
  clock: Clock
  cipher: SecretCipher
  store: AzureDevOpsUserIdentityStore
  mutations: SocialIdentityMutationGate
  connections: Pick<AzureDevOpsConnectionRepo, 'get'>
  subjectFor(userId: string): Promise<string | null>
  microsoftIdentityFor(userId: string): Promise<MicrosoftIdentity | null>
  application?: { clientId: string; clientSecret: string; webAppUrl: string }
}

// Supplemental tenant identities leave the Logto sign-in identity unchanged and never authorize by email.
export class AzureDevOpsUserIdentityService {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly deps: Deps) {
    this.jwks = createRemoteJWKSet(new URL(`${deps.api.loginBaseUrl}/common/discovery/v2.0/keys`), {
      [customFetch]: (url, init) => deps.api.fetch(String(url), init)
    })
  }

  async authorize(orgId: string, userId: string, connectionId: string): Promise<{ authorizeUrl: string }> {
    const app = this.application()
    return this.exclusive(userId, async () => {
      const linked = await this.linked(userId)
      const connection = await this.connection(orgId, connectionId)
      const nonce = `azure-verify.${orgId}.${randomBytes(32).toString('base64url')}`
      const verifier = randomBytes(32).toString('base64url')
      const now = new Date(this.deps.clock.now())
      await this.deps.store.createState(
        {
          nonce,
          userId,
          orgId,
          connectionId,
          tenantId: connection.tenantId,
          linkedObjectId: linked.objectId.toLowerCase(),
          clientId: app.clientId,
          verifier: await this.deps.cipher.seal(verifier, DEPLOYMENT_SCOPE),
          expiresAt: new Date(now.getTime() + STATE_TTL_MS)
        },
        now
      )
      const query = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: azureDevOpsConnectRedirectUri(app.webAppUrl),
        response_type: 'code',
        response_mode: 'query',
        scope: SCOPES,
        state: nonce,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
        login_hint: linked.email
      })
      return { authorizeUrl: `${this.authority(connection.tenantId)}/authorize?${query}` }
    })
  }

  async complete(orgId: string, userId: string, nonce: string, code: string): Promise<void> {
    const app = this.application()
    await this.exclusive(userId, async () => {
      const state = await this.deps.store.findState(userId, nonce, new Date(this.deps.clock.now()))
      if (!state || state.orgId !== orgId || state.clientId !== app.clientId) throw this.invalidState()
      const connection = await this.connection(orgId, state.connectionId)
      if (connection.tenantId !== state.tenantId) throw this.invalidState()
      await this.linked(userId, state.linkedObjectId)
      const tokens = await this.tokens(state.tenantId, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: azureDevOpsConnectRedirectUri(app.webAppUrl),
        code_verifier: await this.deps.cipher.open(state.verifier, DEPLOYMENT_SCOPE)
      })
      const identity = await this.identity(state.tenantId, tokens, { nonce })
      if (!tokens.refresh_token) throw azureIdentityVerificationRequired()
      await this.linked(userId, state.linkedObjectId)
      if (
        !(await this.deps.store.completeState(
          nonce,
          {
            userId,
            tenantId: state.tenantId,
            linkedObjectId: state.linkedObjectId,
            objectId: identity.objectId,
            clientId: app.clientId,
            refreshToken: await this.deps.cipher.seal(tokens.refresh_token, DEPLOYMENT_SCOPE)
          },
          new Date(this.deps.clock.now())
        ))
      )
        throw this.invalidState()
    })
  }

  async identityFor(userId: string, linked: MicrosoftIdentity, tenantId: string): Promise<MicrosoftIdentity> {
    const app = this.application()
    return this.exclusive(userId, async () => {
      await this.linked(userId, linked.objectId)
      const stored = await this.deps.store.find(userId, tenantId)
      if (!stored || stored.linkedObjectId !== linked.objectId.toLowerCase() || stored.clientId !== app.clientId) {
        throw azureIdentityVerificationRequired()
      }
      const refreshToken = await this.deps.cipher.open(stored.refreshToken, DEPLOYMENT_SCOPE)
      const tokens = await this.tokens(tenantId, { grant_type: 'refresh_token', refresh_token: refreshToken })
      const identity = await this.identity(tenantId, tokens, { objectId: stored.objectId })
      await this.linked(userId, stored.linkedObjectId)
      // A concurrent unlink or replacement must never be undone by a late token refresh.
      if (
        !(await this.deps.store.refresh(
          stored,
          await this.deps.cipher.seal(tokens.refresh_token ?? refreshToken, DEPLOYMENT_SCOPE)
        ))
      ) {
        throw azureIdentityVerificationRequired()
      }
      return identity
    })
  }

  private async identity(
    tenantId: string,
    tokens: z.infer<typeof TokenResponse>,
    expected: { nonce?: string; objectId?: string }
  ): Promise<MicrosoftIdentity> {
    let objectId: string
    try {
      const { payload } = await jwtVerify(tokens.id_token, this.jwks, {
        algorithms: ['RS256'],
        issuer: `${this.deps.api.loginBaseUrl}/${tenantId}/v2.0`,
        audience: this.application().clientId,
        currentDate: new Date(this.deps.clock.now()),
        requiredClaims: ['exp', 'iat', 'sub', 'tid', 'oid']
      })
      if (
        payload.tid !== tenantId ||
        !z.uuid().safeParse(payload.oid).success ||
        (expected.nonce !== undefined && payload.nonce !== expected.nonce) ||
        (expected.objectId !== undefined && payload.oid !== expected.objectId)
      )
        throw new Error('identity mismatch')
      objectId = payload.oid as string
    } catch {
      throw new AzureDevOpsApiError('Microsoft identity could not be verified — try again', 502, 'UNAVAILABLE', true)
    }
    const response = await this.request('https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw azureIdentityVerificationRequired()
      throw this.unavailable()
    }
    const profile = Profile.safeParse(await response.json().catch(() => null))
    if (!profile.success || profile.data.id !== objectId) throw this.unavailable()
    const email = profile.data.mail?.trim() || profile.data.userPrincipalName?.trim()
    if (!email) throw this.unavailable()
    return { objectId, email }
  }

  private async tokens(tenantId: string, grant: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
    const app = this.application()
    const response = await this.request(`${this.authority(tenantId)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        scope: SCOPES,
        ...grant
      }).toString()
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = z.object({ error: z.string() }).safeParse(data)
      if (
        response.status === 400 &&
        error.success &&
        ['invalid_grant', 'interaction_required', 'consent_required', 'access_denied'].includes(error.data.error)
      ) {
        throw azureIdentityVerificationRequired()
      }
      throw this.unavailable()
    }
    const tokens = TokenResponse.safeParse(data)
    if (!tokens.success) throw this.unavailable()
    return tokens.data
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.deps.api.fetch(url, { ...init, redirect: 'error' })
    } catch {
      throw this.unavailable()
    }
  }

  private async linked(userId: string, expected?: string): Promise<MicrosoftIdentity> {
    const linked = await this.deps.microsoftIdentityFor(userId)
    if (!linked)
      throw new AzureDevOpsConnectDenied(
        'link your Microsoft account in Profile first',
        403,
        'MICROSOFT_IDENTITY_REQUIRED'
      )
    if (expected && linked.objectId.toLowerCase() !== expected.toLowerCase()) throw azureIdentityVerificationRequired()
    return linked
  }

  private async exclusive<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const sub = await this.deps.subjectFor(userId)
    if (!sub)
      throw new AzureDevOpsConnectDenied('sign in to verify Microsoft access', 403, 'MICROSOFT_IDENTITY_REQUIRED')
    return this.deps.mutations.runExclusive(sub, run)
  }

  private async connection(orgId: string, connectionId: string) {
    const connection = await this.deps.connections.get(orgId, connectionId)
    if (!connection)
      throw new AzureDevOpsConnectDenied('Azure DevOps connection not found', 404, 'connection_not_found')
    return connection
  }

  private authority(tenantId: string): string {
    return `${this.deps.api.loginBaseUrl}/${tenantId}/oauth2/v2.0`
  }

  private application(): NonNullable<Deps['application']> {
    if (!this.deps.application)
      throw new AzureDevOpsConnectDenied(
        'Microsoft tenant verification is not configured; ask an administrator to configure the Microsoft application',
        409,
        'AZURE_DEVOPS_IDENTITY_VERIFICATION_UNAVAILABLE'
      )
    return { ...this.deps.application, clientId: this.deps.application.clientId.toLowerCase() }
  }

  private invalidState() {
    return new AzureDevOpsConnectDenied(
      'Microsoft verification expired or was cancelled; start again',
      400,
      'AZURE_DEVOPS_IDENTITY_STATE_INVALID'
    )
  }

  private unavailable() {
    return new AzureDevOpsApiError(
      'Microsoft verification is temporarily unavailable — try again',
      502,
      'UNAVAILABLE',
      true
    )
  }
}
