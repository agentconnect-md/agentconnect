/**
 * The Control Plane's ALLOWLISTED uses of an agent account's `api` (effect) PAT
 * (gitlab-com-integration.md §7.3, §14.2). One method per permitted operation:
 * the broker resolves the sealed token, spends it on that one endpoint, and
 * never returns it, so no caller of this module ever holds effect material and
 * no arbitrary path or body can be pushed through it.
 *
 * NEVER log the token or a token-bearing response.
 */
import type { Clock } from '../domain/clock.js'
import type {
  GitlabAgentAccountRecord,
  GitlabProjectCredentialRepo,
  GitlabProjectCredentialSecretStore
} from '../persistence/ports.js'
import { GITLAB_AVATAR_MAX_BYTES, GitlabApiError, gitlabUploadCurrentUserAvatar, type FetchLike } from './api.js'

/** What an allowlisted operation did. Everything but `done` is cosmetic — the
 *  caller records nothing and the account's credentials are untouched. */
export type GitlabEffectOutcome = 'done' | 'unsupported' | 'refused' | 'unavailable'

export interface GitlabEffectBrokerDeps {
  credentials: Pick<GitlabProjectCredentialRepo, 'get'>
  credentialSecrets: Pick<GitlabProjectCredentialSecretStore, 'get'>
  clock: Clock
  fetchImpl?: FetchLike
}

export class GitlabEffectBroker {
  constructor(private readonly deps: GitlabEffectBrokerDeps) {}

  /** §7.2 avatar convergence: dress the account in the agent's rendered icon.
   *  Oversized bytes are refused here rather than at the provider, and a
   *  provider without the endpoint reports `unsupported`. */
  async uploadAccountAvatar(
    orgId: string,
    account: GitlabAgentAccountRecord,
    png: Uint8Array
  ): Promise<GitlabEffectOutcome> {
    if (png.byteLength > GITLAB_AVATAR_MAX_BYTES) return 'refused'
    const token = await this.effectToken(orgId, account)
    if (!token) return 'unavailable'
    try {
      await gitlabUploadCurrentUserAvatar(token, png, this.deps.fetchImpl)
      return 'done'
    } catch (e) {
      if (!(e instanceof GitlabApiError)) return 'unavailable'
      if (e.code === 'NOT_FOUND') return 'unsupported'
      return e.retryable || e.status === 0 ? 'unavailable' : 'refused'
    }
  }

  /** The account's own `api` PAT, or null when it is missing, expired, or
   *  sealed away. Never leaves this class. */
  private async effectToken(orgId: string, account: GitlabAgentAccountRecord): Promise<string | null> {
    const credential = await this.deps.credentials.get(account.id, 'effect')
    if (!credential || credential.providerExpiresAt.getTime() <= this.deps.clock.now()) return null
    return this.deps.credentialSecrets.get(orgId, credential.id)
  }
}
