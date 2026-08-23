/**
 * GitLab.com OAuth connection lifecycle (gitlab-com-integration.md §9).
 *
 * Three-hop flow: authenticated `start` mints the one-shot state row (sealed
 * PKCE verifier, exact return path) and hands back the CP's own `begin` URL;
 * the unauthenticated `begin` top-level navigation stamps a browser-binding
 * cookie hash onto the row exactly once and 302s to GitLab; the callback
 * consumes the row exactly once, requires the same browser, exchanges the code
 * with the stored verifier, and upserts only the starting user's org connection.
 *
 * Refresh is a distributed single-writer (§9.3): a short lease elects one
 * refresher, the committed pair advances a tokenVersion CAS, and any failed or
 * ambiguous refresh marks the connection `reauth_required` — never a blind
 * retry, because GitLab invalidates BOTH old tokens on refresh.
 *
 * NEVER log codes, state values, verifiers, tokens, or token responses.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import type {
  GitlabConnectionRecord,
  GitlabConnectionRepo,
  GitlabConnectionSecretStore,
  GitlabOauthStateStore
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import { GitlabMembershipGone } from '../persistence/errors.js'
import {
  GitlabApiError,
  gitlabAuthorizeUrl,
  gitlabCurrentUser,
  gitlabExchangeCode,
  gitlabRefreshToken,
  gitlabRevokeToken,
  type GitlabApiClient
} from './api.js'
import { GITLAB_OAUTH_BEGIN_PATH, GITLAB_OAUTH_CALLBACK_PATH, type GitlabAppConfig } from './config.js'

export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000
const REFRESH_LEASE_MS = 30 * 1000
/** Serve-from-cache guard: refresh this long before the provider expiry. */
const ACCESS_EXPIRY_SKEW_MS = 60 * 1000
export const OAUTH_BROWSER_COOKIE = 'ac_gitlab_oauth'

export type GitlabOauthResultCode =
  'connected' | 'state_invalid' | 'browser_mismatch' | 'exchange_failed' | 'config_missing'

export class GitlabOauthDenied extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message)
    this.name = 'GitlabOauthDenied'
  }
}

/** Local console paths only: absolute-path, no scheme, no protocol-relative. */
export function normalizeReturnPath(input: string | undefined): string {
  if (input === undefined || input === '') return '/'
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\') || input.length > 512) {
    throw new GitlabOauthDenied('returnPath must be a local console path')
  }
  return input
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url')

export interface GitlabOauthServiceDeps {
  cfg: GitlabAppConfig
  connections: GitlabConnectionRepo
  secrets: GitlabConnectionSecretStore
  states: GitlabOauthStateStore
  cipher: SecretCipher
  clock: Clock
  /** Public CP origin — the begin/callback URLs derive from it (gateway `/v1` form). */
  publicCpUrl: string
  /** Console origin for the final redirect; absent ⇒ redirect stays on the CP origin. */
  webAppUrl?: string
  api: GitlabApiClient
  log?: { warn(obj: object, msg: string): void }
}

export class GitlabOauthService {
  constructor(private readonly deps: GitlabOauthServiceDeps) {}

  private get callbackUrl(): string {
    return `${this.deps.publicCpUrl.replace(/\/$/, '')}${GITLAB_OAUTH_CALLBACK_PATH}`
  }

  /** Authenticated hop: mint the one-shot state and hand back the begin URL. */
  async start(orgId: string, userId: string, returnPathInput?: string): Promise<{ url: string }> {
    const returnPath = normalizeReturnPath(returnPathInput)
    const nonce = randomBytes(16).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    await this.deps.states.put({
      nonce,
      orgId,
      userId,
      returnPath,
      verifier: await this.deps.cipher.seal(verifier, orgScope(OrgId(orgId))),
      expiresAt: new Date(this.deps.clock.now() + OAUTH_STATE_TTL_MS)
    })
    const base = this.deps.publicCpUrl.replace(/\/$/, '')
    return { url: `${base}${GITLAB_OAUTH_BEGIN_PATH}?state=${nonce}` }
  }

  /** Unauthenticated begin hop: bind the browser once, then redirect to GitLab. */
  async begin(nonce: string): Promise<{ redirectUrl: string; browserNonce: string } | null> {
    const browserNonce = randomBytes(16).toString('base64url')
    const now = new Date(this.deps.clock.now())
    const row = await this.deps.states.bindBrowser(nonce, sha256(browserNonce), now)
    if (!row) return null
    const verifier = await this.deps.cipher.open(row.verifier, orgScope(OrgId(row.orgId)))
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const redirectUrl = gitlabAuthorizeUrl(this.deps.api, {
      client_id: this.deps.cfg.clientId,
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'api',
      state: nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    })
    return { redirectUrl, browserNonce }
  }

  /**
   * Callback: consume exactly once, verify the browser binding, exchange, and
   * upsert the STARTING user's org connection (§9.2 — never the browser's word).
   * Always resolves to a local redirect; error detail stays in the result code.
   */
  async callback(
    nonce: string | undefined,
    code: string | undefined,
    browserNonce: string | undefined
  ): Promise<{ redirectPath: string; result: GitlabOauthResultCode }> {
    const now = new Date(this.deps.clock.now())
    const row = nonce ? await this.deps.states.consume(nonce, now) : null
    if (!row) return { redirectPath: '/', result: 'state_invalid' }
    const redirectPath = row.returnPath
    if (!code) return { redirectPath, result: 'exchange_failed' }
    if (!row.browserHash || !browserNonce || sha256(browserNonce) !== row.browserHash) {
      return { redirectPath, result: 'browser_mismatch' }
    }
    try {
      const verifier = await this.deps.cipher.open(row.verifier, orgScope(OrgId(row.orgId)))
      const grant = await gitlabExchangeCode(
        {
          clientId: this.deps.cfg.clientId,
          clientSecret: this.deps.cfg.clientSecret,
          code,
          verifier,
          redirectUri: this.callbackUrl
        },
        this.deps.api
      )
      const user = await gitlabCurrentUser(grant.access_token, this.deps.api)
      const scope = orgScope(OrgId(row.orgId))
      await this.deps.connections.upsertOnCallback({
        orgId: row.orgId,
        userId: row.userId,
        gitlabUserId: BigInt(user.id),
        gitlabUsername: user.username,
        scopes: grant.scope ? grant.scope.split(/[ ,]+/).filter(Boolean) : ['api'],
        accessExpiresAt: accessExpiry(grant.created_at, grant.expires_in, now),
        // Sealed here so metadata and pair commit in ONE repo transaction.
        sealedPair: {
          accessToken: await this.deps.cipher.seal(grant.access_token, scope),
          refreshToken: await this.deps.cipher.seal(grant.refresh_token, scope)
        }
      })
      return { redirectPath, result: 'connected' }
    } catch (e) {
      // §9.4: the starter lost their membership mid-flow — the repo's serialized
      // check refused the upsert; nothing was created.
      if (e instanceof GitlabMembershipGone) return { redirectPath, result: 'state_invalid' }
      // Status/code only — never the code, state, or upstream response body.
      this.deps.log?.warn(
        { status: e instanceof GitlabApiError ? e.status : undefined },
        'gitlab oauth code exchange failed'
      )
      return { redirectPath, result: 'exchange_failed' }
    }
  }

  /** The final redirect target on the console origin. */
  redirectTarget(path: string, result: GitlabOauthResultCode): string {
    const base = (this.deps.webAppUrl ?? this.deps.publicCpUrl).replace(/\/$/, '')
    const sep = path.includes('?') ? '&' : '?'
    return `${base}${path}${sep}gitlab=${result}`
  }

  /**
   * A currently-valid access token for administration calls. Refreshes through
   * the single-writer lease + tokenVersion CAS; any refresh failure — including
   * an ambiguous one — marks the connection `reauth_required` and throws.
   */
  async withAccessToken(orgId: string, connectionId: string): Promise<string> {
    const record = await this.requireConnected(orgId, connectionId)
    const pair = await this.deps.secrets.get(orgId, connectionId)
    if (!pair) throw new GitlabOauthDenied('gitlab connection has no stored credentials', 409)
    if (this.accessStillValid(record)) return pair.accessToken
    return this.refresh(orgId, record)
  }

  private accessStillValid(record: GitlabConnectionRecord): boolean {
    if (!record.accessExpiresAt) return false
    return record.accessExpiresAt.getTime() - ACCESS_EXPIRY_SKEW_MS > this.deps.clock.now()
  }

  private async requireConnected(orgId: string, connectionId: string): Promise<GitlabConnectionRecord> {
    const record = await this.deps.connections.get(orgId, connectionId)
    if (!record) throw new GitlabOauthDenied('gitlab connection not found', 404)
    if (record.state !== 'connected') {
      throw new GitlabOauthDenied(`gitlab connection requires reconnection (${record.state})`, 409)
    }
    return record
  }

  private async refresh(orgId: string, record: GitlabConnectionRecord): Promise<string> {
    const owner = randomBytes(8).toString('base64url')
    const now = new Date(this.deps.clock.now())
    const claimed = await this.deps.connections.claimRefreshLease(
      record.id,
      owner,
      new Date(now.getTime() + REFRESH_LEASE_MS),
      now
    )
    if (!claimed) {
      // Another writer is refreshing: reload the committed pair instead (§9.3 step 4).
      await this.waitForOtherWriter()
      const reread = await this.requireConnected(orgId, record.id)
      const pair = await this.deps.secrets.get(orgId, record.id)
      if (pair && reread.tokenVersion > record.tokenVersion) return pair.accessToken
      throw new GitlabOauthDenied('gitlab token refresh is contended — retry shortly', 409)
    }
    try {
      // Re-read under the lease: a writer may have committed between our reads.
      const current = await this.requireConnected(orgId, record.id)
      const pair = await this.deps.secrets.get(orgId, record.id)
      if (!pair) throw new GitlabOauthDenied('gitlab connection has no stored credentials', 409)
      if (current.tokenVersion > record.tokenVersion && this.accessStillValid(current)) return pair.accessToken
      let grant
      try {
        grant = await gitlabRefreshToken(
          {
            clientId: this.deps.cfg.clientId,
            clientSecret: this.deps.cfg.clientSecret,
            refreshToken: pair.refreshToken,
            redirectUri: this.callbackUrl
          },
          this.deps.api
        )
      } catch (e) {
        // Deterministic rejection or ambiguous outcome alike: the old pair may
        // already be invalid, so never blind-retry — require human reconnection.
        // Version-fenced: a reconnect committed meanwhile keeps its fresh state.
        await this.deps.connections.markReauthRequired(record.id, current.tokenVersion)
        this.deps.log?.warn(
          { connectionId: record.id, status: e instanceof GitlabApiError ? e.status : undefined },
          'gitlab token refresh failed; connection requires reconnection'
        )
        throw new GitlabOauthDenied('gitlab connection requires reconnection (reauth_required)', 409)
      }
      const scope = orgScope(OrgId(orgId))
      const committed = await this.deps.connections.commitRefresh(
        record.id,
        current.tokenVersion,
        accessExpiry(grant.created_at, grant.expires_in, now),
        {
          accessToken: await this.deps.cipher.seal(grant.access_token, scope),
          refreshToken: await this.deps.cipher.seal(grant.refresh_token, scope)
        }
      )
      if (!committed) {
        // Lost the CAS (reconnect or disconnect won) — fail closed rather than
        // resurrect a pair newer intent already replaced or removed.
        throw new GitlabOauthDenied('gitlab token refresh version conflict — retry shortly', 409)
      }
      return grant.access_token
    } finally {
      await this.deps.connections.releaseRefreshLease(record.id, owner)
    }
  }

  /** Tiny bounded wait so a raced reader sees the writer's commit. Injectable clocks skip it. */
  private async waitForOtherWriter(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  /** Disconnect: best-effort provider revoke, remove the pair, keep the row as history. */
  async disconnect(orgId: string, connectionId: string): Promise<boolean> {
    const record = await this.deps.connections.get(orgId, connectionId)
    if (!record) return false
    const pair = await this.deps.secrets.get(orgId, connectionId)
    if (pair) {
      try {
        await gitlabRevokeToken(
          {
            clientId: this.deps.cfg.clientId,
            clientSecret: this.deps.cfg.clientSecret,
            token: pair.accessToken
          },
          this.deps.api
        )
      } catch {
        // Best-effort: local removal is the authority; the provider grant ages out.
      }
    }
    // Atomic local removal: state, version fence, and pair in one transaction.
    return this.deps.connections.disconnect(orgId, connectionId)
  }
}

function accessExpiry(createdAt: number | undefined, expiresIn: number | undefined, now: Date): Date | null {
  if (expiresIn === undefined) return null
  const startMs = createdAt !== undefined ? createdAt * 1000 : now.getTime()
  return new Date(startMs + expiresIn * 1000)
}
