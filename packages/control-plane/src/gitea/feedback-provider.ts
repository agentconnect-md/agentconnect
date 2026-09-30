import type { FeedbackProvider, FeedbackRepository } from '../codehost/feedback.service.js'
import type { GiteaConnectionRepo, GiteaRepositoryBindingRepo, GiteaWebhookSecretStore } from '../persistence/ports.js'
import { GiteaApiError, giteaFeedbackPulls, isGiteaAuthRejection, type GiteaApiClient } from './api.js'
import type { GiteaMembershipAuthzService } from './membership-authz.service.js'
import type { GiteaTokenSource } from './provisioner.js'

export class GiteaFeedbackProvider implements FeedbackProvider {
  readonly provider = 'gitea'

  pullNumber(metadata: CodeHostHookMetadata): number | undefined {
    return metadata.provider === this.provider && metadata.metadata.target.kind === 'pull'
      ? metadata.metadata.target.index
      : undefined
  }

  constructor(
    private readonly deps: {
      bindings: GiteaRepositoryBindingRepo
      connections: Pick<GiteaConnectionRepo, 'get'>
      tokens: GiteaTokenSource
      secrets: GiteaWebhookSecretStore
      membership: GiteaMembershipAuthzService
      api: GiteaApiClient
    }
  ) {}

  async repositories(): Promise<Array<{ orgId: string; repoId: bigint }>> {
    return (await this.deps.bindings.listAll()).map((binding) => ({ orgId: binding.orgId, repoId: binding.repoId }))
  }

  async repository(orgId: string, repoId: bigint): Promise<FeedbackRepository | null> {
    const binding = await this.deps.bindings.byRepo(orgId, repoId)
    if (!binding || binding.state === 'cleanup_pending' || binding.state === 'runtime_degraded') return null
    const connection = await this.deps.connections.get(orgId, binding.connectionId)
    if (!connection || connection.state !== 'connected') return null
    const keys = await this.deps.secrets.get(orgId, binding.id)
    return {
      bindingId: binding.id,
      orgId,
      repoId,
      repoFullName: binding.repoPath,
      host: this.deps.api.baseUrl,
      signingKey: keys?.current ?? null,
      ...(keys?.next ? { nextSigningKey: keys.next } : {}),
      admits: (signal) =>
        signal.actorId && signal.actorUsername
          ? this.deps.membership.actorsAllowed(orgId, repoId, [
              { id: BigInt(signal.actorId), username: signal.actorUsername }
            ])
          : Promise.resolve(false),
      pulls: async (query) => {
        const token = await this.deps.tokens.withToken(orgId, binding.connectionId)
        try {
          return (await giteaFeedbackPulls(token, binding.repoPath, query.number, this.deps.api))
            .filter((pull) => !query.branch || pull.head.ref === query.branch)
            .map((pull) => ({
              number: pull.number,
              branch: pull.head.ref,
              headSha: pull.head.sha,
              sourceRepoId: BigInt(pull.head.repo!.id)
            }))
        } catch (err) {
          if (isGiteaAuthRejection(err)) await this.deps.tokens.onAuthRejected(orgId, binding.connectionId)
          if (err instanceof GiteaApiError && err.status === 404) return []
          throw err
        }
      }
    }
  }
}
import type { CodeHostHookMetadata } from '@agentconnect.md/protocol'
