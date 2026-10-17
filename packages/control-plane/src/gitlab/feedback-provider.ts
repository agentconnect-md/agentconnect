import type { FeedbackProvider, FeedbackRepository } from '../codehost/feedback.service.js'
import type { GitlabProjectBindingRepo, GitlabWebhookSecretStore } from '../persistence/ports.js'
import { gitlabFeedbackPulls, GitlabApiError } from './api.js'
import type { GitlabMembershipAuthzDeps, GitlabMembershipAuthzService } from './membership-authz.service.js'

export class GitlabFeedbackProvider implements FeedbackProvider {
  readonly provider = 'gitlab'

  pullNumber(metadata: CodeHostHookMetadata): number | undefined {
    return metadata.provider === this.provider && metadata.metadata.target.kind === 'merge_request'
      ? metadata.metadata.target.iid
      : undefined
  }

  constructor(
    private readonly deps: Pick<
      GitlabMembershipAuthzDeps,
      'api' | 'accounts' | 'credentials' | 'credentialSecrets' | 'clock'
    > & {
      bindings: GitlabProjectBindingRepo
      secrets: GitlabWebhookSecretStore
      membership: GitlabMembershipAuthzService
    }
  ) {}

  /** The binding's read credential, from its first active account that has a live one. */
  async readToken(orgId: string, bindingId: string): Promise<string> {
    for (const account of await this.deps.accounts.listForBinding(bindingId)) {
      if (account.lifecycle !== 'active' || account.state === 'runtime_degraded' || account.state === 'cleanup_pending')
        continue
      const credential = await this.deps.credentials.get(account.id, 'read')
      if (!credential || credential.providerExpiresAt.getTime() <= this.deps.clock.now()) continue
      const token = await this.deps.credentialSecrets.get(orgId, credential.id)
      if (token) return token
    }
    throw new Error('PR feedback: repository read credential is unavailable')
  }

  async repositories(): Promise<Array<{ orgId: string; repoId: bigint }>> {
    return (await this.deps.bindings.listAll()).map((binding) => ({ orgId: binding.orgId, repoId: binding.projectId }))
  }

  async repository(orgId: string, repoId: bigint): Promise<FeedbackRepository | null> {
    const binding = await this.deps.bindings.byProject(orgId, repoId)
    if (!binding || binding.state === 'cleanup_pending' || binding.state === 'runtime_degraded') return null
    return {
      bindingId: binding.id,
      orgId,
      repoId,
      repoFullName: binding.projectPath,
      host: this.deps.api.baseUrl,
      signingKey: await this.deps.secrets.get(orgId, binding.id),
      admits: (signal) =>
        signal.actorId
          ? this.deps.membership.actorsAllowed(orgId, repoId, [BigInt(signal.actorId)])
          : Promise.resolve(false),
      pulls: async (query) => {
        const token = await this.readToken(orgId, binding.id)
        try {
          return (await gitlabFeedbackPulls(token, repoId, query, this.deps.api)).map((pull) => ({
            number: pull.iid,
            branch: pull.source_branch,
            headSha: pull.sha,
            sourceRepoId: BigInt(pull.source_project_id)
          }))
        } catch (err) {
          if (err instanceof GitlabApiError && err.status === 404) return []
          throw err
        }
      }
    }
  }
}
import type { CodeHostHookMetadata } from '@agentconnect.md/protocol'
