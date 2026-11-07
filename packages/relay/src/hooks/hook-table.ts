/** The relay's in-memory hook table, a replayed copy of `rc/hook-assign`/`rc/hook-remove` indexed by token, repository and Azure DevOps subscription; rules carry secrets, so NEVER log one. */
import {
  codeHostHookRuleOf,
  type CodeHostProvider,
  type RcHookAssign,
  type RcCodeHostFeedbackWatch
} from '@agentconnect.md/protocol'
import { ProjectionSnapshot } from '../projection-snapshot.js'

/** The code-host routing key: the provider-qualified external repository id; a display path is never a match key. */
function repoIndexKey(provider: CodeHostProvider, externalId: string): string {
  return `${provider}:${externalId}`
}

/** The repository key a compiled rule routes under; undefined for the generic kind. */
function ruleRepoIndexKey(rule: RcHookAssign): string | undefined {
  const host = codeHostHookRuleOf(rule)
  return host && repoIndexKey(host.provider, host.repo.externalId)
}

/** The subscription ids an Azure DevOps rule is looked up by, lowercased as a GUID compares. */
function azureDevOpsSubscriptionIds(rule: RcHookAssign | undefined): string[] {
  if (rule?.kind !== 'azure-devops' || !rule.azureDevOps) return []
  return rule.azureDevOps.subscriptions.map((subscription) => subscription.subscriptionId.toLowerCase())
}

export class HookTable {
  private feedbackWatches = new Map<
    string,
    RcCodeHostFeedbackWatch & { watch: NonNullable<RcCodeHostFeedbackWatch['watch']> }
  >()

  feedbackWatch(update: RcCodeHostFeedbackWatch): void {
    const key = repoIndexKey(update.provider, update.repoId)
    if (update.watch) this.feedbackWatches.set(key, { ...update, watch: update.watch })
    else this.feedbackWatches.delete(key)
  }

  getFeedbackWatch(provider: CodeHostProvider, repoId: string) {
    return this.feedbackWatches.get(repoIndexKey(provider, repoId))
  }
  private byHookId = new Map<string, RcHookAssign>()
  private byToken = new Map<string, RcHookAssign>()
  /** (provider, externalId) → hookId → rule (fan-out: several hooks may watch one repository). */
  private byCodeHostRepo = new Map<string, Map<string, RcHookAssign>>()
  /** GitHub installation id → hookId → installation-wide rule. */
  private byGithubInstallation = new Map<string, Map<string, RcHookAssign>>()
  /** Azure DevOps subscription id → hookId → every rule whose binding records it (azure-devops-integration.md §11.3). */
  private byAzureDevOpsSubscription = new Map<string, Map<string, RcHookAssign>>()
  private readonly snapshot = new ProjectionSnapshot()

  upsert(rule: RcHookAssign): void {
    this.snapshot.see(rule.hookId)
    // Re-index: if the hook's token/repository changed (or the kind did), drop the old key.
    const prior = this.byHookId.get(rule.hookId)
    if (prior?.webhook && prior.webhook.urlToken !== rule.webhook?.urlToken) {
      this.byToken.delete(prior.webhook.urlToken)
    }
    const priorRepoKey = prior && ruleRepoIndexKey(prior)
    const repoKey = ruleRepoIndexKey(rule)
    if (priorRepoKey !== undefined && priorRepoKey !== repoKey) {
      this.dropFromRepoIndex(priorRepoKey, rule.hookId)
    }
    const priorInstallation = prior?.githubInstallation?.installationId
    const installation = rule.githubInstallation?.installationId
    if (priorInstallation !== undefined && priorInstallation !== installation) {
      this.dropFromInstallationIndex(priorInstallation, rule.hookId)
    }
    if (installation !== undefined) {
      let bucket = this.byGithubInstallation.get(installation)
      if (!bucket) {
        bucket = new Map()
        this.byGithubInstallation.set(installation, bucket)
      }
      bucket.set(rule.hookId, rule)
    }
    for (const subscriptionId of azureDevOpsSubscriptionIds(prior)) {
      this.dropFromIndex(this.byAzureDevOpsSubscription, subscriptionId, rule.hookId)
    }
    for (const subscriptionId of azureDevOpsSubscriptionIds(rule)) {
      let bucket = this.byAzureDevOpsSubscription.get(subscriptionId)
      if (!bucket) {
        bucket = new Map()
        this.byAzureDevOpsSubscription.set(subscriptionId, bucket)
      }
      bucket.set(rule.hookId, rule)
    }
    this.byHookId.set(rule.hookId, rule)
    if (rule.kind === 'webhook' && rule.webhook) this.byToken.set(rule.webhook.urlToken, rule)
    if (repoKey !== undefined) {
      let bucket = this.byCodeHostRepo.get(repoKey)
      if (!bucket) {
        bucket = new Map()
        this.byCodeHostRepo.set(repoKey, bucket)
      }
      bucket.set(rule.hookId, rule)
    }
  }

  remove(hookId: string): void {
    const rule = this.byHookId.get(hookId)
    if (!rule) return
    this.byHookId.delete(hookId)
    if (rule.webhook) this.byToken.delete(rule.webhook.urlToken)
    const repoKey = ruleRepoIndexKey(rule)
    if (repoKey !== undefined) this.dropFromRepoIndex(repoKey, hookId)
    if (rule.githubInstallation) this.dropFromInstallationIndex(rule.githubInstallation.installationId, hookId)
    for (const subscriptionId of azureDevOpsSubscriptionIds(rule)) {
      this.dropFromIndex(this.byAzureDevOpsSubscription, subscriptionId, hookId)
    }
  }

  /** `rc/snapshot-begin`: the current rules keep routing while the replay lands. */
  beginSnapshot(snapshotId: string): void {
    this.snapshot.begin(snapshotId)
  }

  /** `rc/snapshot-end`: remove each hook the replay neither sent nor withheld, such as one deleted while the link was down. */
  endSnapshot(snapshotId: string, withheld: readonly string[]): void {
    for (const hookId of this.snapshot.end(snapshotId, this.byHookId.keys(), withheld)) this.remove(hookId)
  }

  abandonSnapshot(): void {
    this.snapshot.abandon()
  }

  /** The generic-ingress lookup: URL token → rule (undefined = uniform 404). */
  getByToken(urlToken: string): RcHookAssign | undefined {
    return this.byToken.get(urlToken)
  }

  /** Re-read one hook after an asynchronous authorization boundary. Callers
   *  must dispatch this current object, never a rule captured before the wait. */
  getByHookId(hookId: string): RcHookAssign | undefined {
    return this.byHookId.get(hookId)
  }

  /** The code-host-ingress lookup: provider + numeric external id (as string) → every watching rule. */
  getByCodeHostRepo(provider: CodeHostProvider, externalId: string): RcHookAssign[] {
    const bucket = this.byCodeHostRepo.get(repoIndexKey(provider, externalId))
    return bucket ? [...bucket.values()] : []
  }

  /** Every installation-wide GitHub rule of one installation, before it is filled in for an event's repository. */
  getByGithubInstallation(installationId: string): RcHookAssign[] {
    const bucket = this.byGithubInstallation.get(installationId)
    return bucket ? [...bucket.values()] : []
  }

  /** The Azure DevOps lookup: a delivery's subscription id → every rule recording it (undefined id = none). */
  getByAzureDevOpsSubscription(subscriptionId: string): RcHookAssign[] {
    const bucket = this.byAzureDevOpsSubscription.get(subscriptionId.toLowerCase())
    return bucket ? [...bucket.values()] : []
  }

  size(): number {
    return this.byHookId.size
  }

  private dropFromInstallationIndex(installationId: string, hookId: string): void {
    const bucket = this.byGithubInstallation.get(installationId)
    if (!bucket) return
    bucket.delete(hookId)
    if (bucket.size === 0) this.byGithubInstallation.delete(installationId)
  }

  private dropFromIndex(index: Map<string, Map<string, RcHookAssign>>, key: string, hookId: string): void {
    const bucket = index.get(key)
    if (!bucket) return
    bucket.delete(hookId)
    if (bucket.size === 0) index.delete(key)
  }

  private dropFromRepoIndex(repoKey: string, hookId: string): void {
    const bucket = this.byCodeHostRepo.get(repoKey)
    if (!bucket) return
    bucket.delete(hookId)
    if (bucket.size === 0) this.byCodeHostRepo.delete(repoKey)
  }
}
