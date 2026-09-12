/**
 * Binding on first use (gitea-integration.md §6). Every write that names a Gitea repository — a
 * trigger, an agent workspace, an additional-repository grant, the card's own Add — makes it a
 * managed binding through this one path: the connection must accept writes, the bot must administer
 * the repository (§4.4), the deployment-global claim is taken, and the saga converges inline so the
 * caller reads a settled state. Two writers racing for one repository resolve on the claim's
 * uniqueness: the loser adopts the winner's binding and joins its convergence, never creating a second.
 */
import type {
  GiteaConnectionRecord,
  GiteaConnectionRepo,
  GiteaRepositoryBindingRecord,
  GiteaRepositoryBindingRepo
} from '../persistence/ports.js'
import { GiteaRepositoryClaimConflict } from '../persistence/errors.js'
import {
  GiteaApiError,
  giteaRepositoryById,
  giteaRepositoryByPath,
  isGiteaAuthRejection,
  type GiteaApiClient,
  type GiteaRepository
} from './api.js'
import { TOKEN_REJECTED_REASON } from './binding-state.js'
import { GiteaConnectDenied } from './connection.service.js'
import type { GiteaProvisioner, GiteaTokenSource } from './provisioner.js'

/** A first use is an HTTP request: outwait a brief contention, then let the follow-up finish the job. */
const FIRST_USE_CONVERGE_ATTEMPTS = 6

/** The repository as the bot sees it, beside the connection that sees it. */
export interface GiteaAdministeredRepository {
  connection: GiteaConnectionRecord
  repo: GiteaRepository
}

export interface GiteaEnsureBoundOutcome {
  binding: GiteaRepositoryBindingRecord
  /** False when the repository was already bound, by an earlier write or by a racing one. */
  created: boolean
}

export interface GiteaBindingServiceDeps {
  connections: Pick<GiteaConnectionRepo, 'forOrg'>
  tokens: GiteaTokenSource
  bindings: Pick<GiteaRepositoryBindingRepo, 'byRepo' | 'createWithClaim' | 'get'>
  provisioner: Pick<GiteaProvisioner, 'convergeRepository'>
  api: GiteaApiClient
}

export class GiteaBindingService {
  constructor(private readonly deps: GiteaBindingServiceDeps) {}

  /** The organization's connection when it can bind; the §4.3 verdicts otherwise. */
  private async writableConnection(orgId: string): Promise<GiteaConnectionRecord> {
    const connection = await this.deps.connections.forOrg(orgId)
    if (!connection) {
      throw new GiteaConnectDenied(
        'this organization has no Gitea connection — connect the bot on the Integrations card first',
        404,
        'connection_missing'
      )
    }
    if (connection.state === 'token_rejected') {
      throw new GiteaConnectDenied('the Gitea token was rejected — replace it first', 409, TOKEN_REJECTED_REASON)
    }
    if (connection.state === 'disconnecting') {
      throw new GiteaConnectDenied('the Gitea connection is being removed', 409, 'connection_disconnecting')
    }
    return connection
  }

  /** A definite rejection is the connection's verdict (§4.3), answered as one; anything else bubbles. */
  private async rejected(orgId: string, connection: GiteaConnectionRecord, e: unknown): Promise<never> {
    if (isGiteaAuthRejection(e)) {
      await this.deps.tokens.onAuthRejected(orgId, connection.id)
      throw new GiteaConnectDenied('the Gitea token was rejected — replace it', 409, TOKEN_REJECTED_REASON)
    }
    throw e
  }

  /** The repository by numeric id as the bot sees it; refused unless the bot administers it (§4.4). */
  async administered(orgId: string, repoId: bigint): Promise<GiteaAdministeredRepository> {
    const connection = await this.writableConnection(orgId)
    const token = await this.deps.tokens.withToken(orgId, connection.id)
    let repo: GiteaRepository | null
    try {
      // The server re-fetches; a caller-supplied id is never trusted for facts (§6).
      repo = await giteaRepositoryById(token, repoId, this.deps.api)
    } catch (e) {
      return this.rejected(orgId, connection, e)
    }
    if (!repo) {
      throw new GiteaConnectDenied(
        'repository is not accessible through this connection',
        400,
        'repository_not_accessible'
      )
    }
    if (repo.permissions?.admin !== true) {
      throw new GiteaConnectDenied(
        `the bot ${connection.botUsername} must hold admin on ${repo.full_name} — grant it as a collaborator or through a team first`,
        403,
        'admin_required'
      )
    }
    return { connection, repo }
  }

  /** The same by `owner/repo`; null when no connection accepts writes, the bot cannot see it, or does not administer it. */
  async administeredByPath(orgId: string, owner: string, repo: string): Promise<GiteaAdministeredRepository | null> {
    const connection = await this.deps.connections.forOrg(orgId)
    if (!connection || connection.state !== 'connected') return null
    const token = await this.deps.tokens.withToken(orgId, connection.id)
    let found: GiteaRepository | null
    try {
      found = await giteaRepositoryByPath(token, owner, repo, this.deps.api)
    } catch (e) {
      if (e instanceof GiteaApiError) return this.rejected(orgId, connection, e)
      throw e
    }
    return found?.permissions?.admin === true ? { connection, repo: found } : null
  }

  /** Bound, binding on first use; a caller's own gates (§8.3) run BEFORE this, never after. */
  async ensureBound(orgId: string, repoId: bigint): Promise<GiteaEnsureBoundOutcome> {
    const existing = await this.deps.bindings.byRepo(orgId, repoId)
    if (existing) {
      // A binding mid-removal must refuse, never be adopted as if it were live.
      if (existing.state === 'cleanup_pending') {
        throw new GiteaConnectDenied(
          `${existing.repoPath} is being removed from this organization — wait for cleanup to finish`,
          409,
          'binding_cleanup_pending'
        )
      }
      return { binding: existing, created: false }
    }
    const { connection, repo } = await this.administered(orgId, repoId)
    let binding: GiteaRepositoryBindingRecord
    try {
      binding = await this.deps.bindings.createWithClaim({
        orgId,
        connectionId: connection.id,
        repoId,
        repoPath: repo.full_name,
        ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
        ...(repo.clone_url ? { cloneUrl: repo.clone_url } : {}),
        axisBaseUrl: this.deps.api.baseUrl
      })
    } catch (e) {
      if (!(e instanceof GiteaRepositoryClaimConflict)) throw e
      // The claim is unique per deployment: a racing first use in THIS organization won it, so its binding is adopted; a foreign one is never disclosed.
      const peer = await this.deps.bindings.byRepo(orgId, repoId)
      if (!peer) {
        throw new GiteaConnectDenied('repository is already claimed by another organization', 409, 'repository_claimed')
      }
      await this.converge(orgId, repoId)
      return { binding: (await this.deps.bindings.byRepo(orgId, repoId)) ?? peer, created: false }
    }
    await this.converge(orgId, repoId)
    return { binding: (await this.deps.bindings.get(orgId, binding.id)) ?? binding, created: true }
  }

  /** One inline convergence: a racing writer joins the running pass instead of taking its own lease. */
  private converge(orgId: string, repoId: bigint): Promise<void> {
    return this.deps.provisioner.convergeRepository(orgId, repoId, { attempts: FIRST_USE_CONVERGE_ATTEMPTS })
  }
}
