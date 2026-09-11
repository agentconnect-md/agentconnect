/**
 * The organization's Gitea bot connection (gitea-integration.md §4): connect runs the four checks
 * of §4.1 before anything is stored, replacement keeps the numeric bot user and advances the
 * credential epoch atomically (§4.3), and a definite token rejection from ANY consumer flips the
 * connection and every servable binding it administers. The token is sealed at rest and leaves
 * this service only as the value a caller presents to Gitea — never in a log or an error.
 */
import type { Clock } from '../domain/clock.js'
import { OrgId } from '../domain/ids.js'
import { GiteaBotAlreadyBound, GiteaConnectionExists } from '../persistence/errors.js'
import type {
  GiteaConnectionRecord,
  GiteaConnectionRepo,
  GiteaConnectionSecretStore,
  GiteaRepositoryBindingRecord,
  GiteaRepositoryBindingRepo,
  GiteaVerifiedBot
} from '../persistence/ports.js'
import type { SecretCipher } from '../secrets/cipher.js'
import { orgScope } from '../secrets/scope.js'
import {
  GiteaApiError,
  giteaCurrentUser,
  giteaProbeListing,
  giteaVersion,
  isGiteaAuthRejection,
  type GiteaApiClient
} from './api.js'
import { TOKEN_REJECTED_REASON } from './binding-state.js'
import { GITEA_MINIMUM_VERSION_LABEL, GITEA_VERSION_UNSUPPORTED_REASON, parseGiteaVersion } from './version.js'

/** The scopes a bot token must carry (§4.1); the Console shows the list beside the input. */
export const GITEA_REQUIRED_TOKEN_SCOPES = [
  'read:user',
  'write:repository',
  'write:issue',
  'read:organization'
] as const

/** A refusal the routes answer with its status; `code` is the machine-readable reason. */
export class GiteaConnectDenied extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
    readonly code: string
  ) {
    super(message)
    this.name = 'GiteaConnectDenied'
  }
}

export interface GiteaConnectionServiceDeps {
  connections: GiteaConnectionRepo
  secrets: GiteaConnectionSecretStore
  bindings: Pick<GiteaRepositoryBindingRepo, 'degradeForConnection' | 'listForConnection'>
  cipher: SecretCipher
  clock: Clock
  api: GiteaApiClient
  /** After a replacement advanced the epoch (§4.3): re-project every Gitea consumer so daemon caches purge. */
  onCredentialEpochChanged?: (orgId: string, connection: GiteaConnectionRecord) => Promise<void> | void
  /** After a rejection degraded the bindings: recompile their rules and re-project their agents. */
  onBindingsDegraded?: (orgId: string, bindings: readonly GiteaRepositoryBindingRecord[]) => Promise<void> | void
  log?: { warn(obj: object, msg: string): void }
}

/** Upstream trouble is upstream trouble, not policy: the status the routes answer for it. */
function upstream(e: GiteaApiError): GiteaConnectDenied {
  return new GiteaConnectDenied(`gitea: ${e.message}`, 502, 'gitea_unavailable')
}

export class GiteaConnectionService {
  constructor(private readonly deps: GiteaConnectionServiceDeps) {}

  /** The instance this service addresses (§3) — the base every route reports. */
  get baseUrl(): string {
    return this.deps.api.baseUrl
  }

  /** Checks 1–3 of §4.1 (identity, floor, scopes) plus the probe reads; stores nothing. */
  async verifyToken(token: string): Promise<GiteaVerifiedBot> {
    const { api } = this.deps
    let user
    try {
      user = await giteaCurrentUser(token, api)
    } catch (e) {
      if (isGiteaAuthRejection(e)) {
        throw new GiteaConnectDenied(
          `Gitea rejected the token — check that it is a personal access token of the bot user carrying ${GITEA_REQUIRED_TOKEN_SCOPES.join(', ')}`,
          400,
          TOKEN_REJECTED_REASON
        )
      }
      if (e instanceof GiteaApiError) throw upstream(e)
      throw e
    }
    let reported: string
    try {
      reported = await giteaVersion(api)
    } catch (e) {
      if (e instanceof GiteaApiError) throw upstream(e)
      throw e
    }
    const version = parseGiteaVersion(reported)
    if (!version.supported) {
      throw new GiteaConnectDenied(
        `${api.baseUrl} reports version ${version.raw || '(unreadable)'}; AgentConnect requires Gitea ${GITEA_MINIMUM_VERSION_LABEL} or later`,
        409,
        GITEA_VERSION_UNSUPPORTED_REASON
      )
    }
    // The scope probes are the reads the picker needs anyway (§4.1): a repository listing for
    // `repository`, an organization listing for `organization` (and `user`, which both require).
    await this.probe(token, '/user/repos', 'write:repository')
    await this.probe(token, '/user/orgs', 'read:organization')
    return {
      botUserId: BigInt(user.id),
      botUsername: user.login,
      botDisplayName: user.full_name?.trim() ? user.full_name.trim() : null,
      instanceVersion: version.raw,
      verifiedAt: new Date(this.deps.clock.now())
    }
  }

  private async probe(token: string, path: string, scope: string): Promise<void> {
    try {
      await giteaProbeListing(token, path, this.deps.api)
    } catch (e) {
      if (isGiteaAuthRejection(e) || (e instanceof GiteaApiError && e.code === 'FORBIDDEN')) {
        throw new GiteaConnectDenied(`the token lacks the ${scope} scope`, 400, 'missing_scope')
      }
      if (e instanceof GiteaApiError) throw upstream(e)
      throw e
    }
  }

  /** §4.1: verify, refuse a bot already bound anywhere on the deployment, refuse a second connection, seal. */
  async connect(orgId: string, token: string, actorUserId?: string): Promise<GiteaConnectionRecord> {
    const bot = await this.verifyToken(token)
    if (await this.deps.connections.byBotUserId(bot.botUserId)) throw bound()
    if (await this.deps.connections.forOrg(orgId)) throw exists()
    const sealedToken = await this.deps.cipher.seal(token, orgScope(OrgId(orgId)))
    try {
      return await this.deps.connections.create({
        orgId,
        ...(actorUserId !== undefined ? { createdByUserId: actorUserId } : {}),
        bot,
        sealedToken,
        axisBaseUrl: this.deps.api.baseUrl
      })
    } catch (e) {
      // The database is the race guard behind the two pre-checks above.
      if (e instanceof GiteaBotAlreadyBound) throw bound()
      if (e instanceof GiteaConnectionExists) throw exists()
      throw e
    }
  }

  /** §4.3: the same checks against the new value, the same numeric user, then an atomic switch and an epoch bump. */
  async replaceToken(orgId: string, connectionId: string, token: string): Promise<GiteaConnectionRecord> {
    const existing = await this.deps.connections.get(orgId, connectionId)
    if (!existing) throw missing()
    const bot = await this.verifyToken(token)
    if (bot.botUserId !== existing.botUserId) {
      throw new GiteaConnectDenied(
        `the replacement token belongs to a different Gitea user than ${existing.botUsername} — disconnect and connect the new bot instead`,
        409,
        'bot_user_mismatch'
      )
    }
    const sealedToken = await this.deps.cipher.seal(token, orgScope(OrgId(orgId)))
    const updated = await this.deps.connections.replaceToken(orgId, connectionId, bot, sealedToken)
    if (!updated) throw missing()
    await this.deps.onCredentialEpochChanged?.(orgId, updated)
    return updated
  }

  /** The token a consumer presents; refused while the connection is waiting for a replacement. */
  async withToken(orgId: string, connectionId: string): Promise<string> {
    const record = await this.deps.connections.get(orgId, connectionId)
    if (!record) throw missing()
    if (record.state === 'token_rejected') {
      throw new GiteaConnectDenied('the Gitea token was rejected — replace it', 409, TOKEN_REJECTED_REASON)
    }
    const token = await this.deps.secrets.get(orgId, connectionId)
    if (!token) throw new GiteaConnectDenied('the Gitea connection has no stored token', 409, 'token_missing')
    return token
  }

  /** §4.3: a definite rejection anywhere moves the connection and every servable binding to token_rejected. */
  async onAuthRejected(orgId: string, connectionId: string): Promise<void> {
    const record = await this.deps.connections.get(orgId, connectionId)
    if (!record) return
    if (record.state === 'connected') {
      await this.deps.connections.update(orgId, connectionId, { state: 'token_rejected' })
    }
    const degraded = await this.deps.bindings.degradeForConnection(orgId, connectionId, TOKEN_REJECTED_REASON)
    this.deps.log?.warn({ connectionId, degraded }, 'gitea token rejected — bindings degraded')
    try {
      await this.deps.onBindingsDegraded?.(orgId, await this.deps.bindings.listForConnection(orgId, connectionId))
    } catch (err) {
      this.deps.log?.warn({ err, connectionId }, 'gitea degraded-binding fan-out failed')
    }
  }

  /** Disconnect step 1: the row stays, refusing new bindings, while the removals of §6 run. */
  async beginDisconnect(orgId: string, connectionId: string): Promise<GiteaConnectionRecord | null> {
    const record = await this.deps.connections.get(orgId, connectionId)
    if (!record) return null
    if (record.state === 'disconnecting') return record
    return this.deps.connections.update(orgId, connectionId, { state: 'disconnecting' })
  }

  /** Disconnect step 2: the row and its sealed token go once no binding references them. */
  removeIfEmpty(orgId: string, connectionId: string): Promise<'removed' | 'blocked' | 'missing'> {
    return this.deps.connections.remove(orgId, connectionId)
  }
}

function bound(): GiteaConnectDenied {
  return new GiteaConnectDenied(
    'this Gitea bot user already serves another connection on this deployment',
    409,
    'bot_already_bound'
  )
}

function exists(): GiteaConnectDenied {
  return new GiteaConnectDenied(
    'this organization already has a Gitea connection — replace its token or disconnect it first',
    409,
    'connection_exists'
  )
}

function missing(): GiteaConnectDenied {
  return new GiteaConnectDenied('gitea connection not found', 404, 'connection_missing')
}
