/**
 * `HookTable` — the relay's in-memory hook routing table
 * (webhook-triggers-and-github-events.md, relay side). Driven entirely by the
 * CP's `rc/hook-assign` / `rc/hook-remove` EVTs: upsert-by-hookId semantics,
 * a `urlToken` index for the generic ingress lookup and a `repoId` index for
 * the GitHub endpoint (one repo → many hooks). The table is a memory copy —
 * the CP replays every enabled hook after this relay (re)registers, and a CP
 * outage leaves the copy serving (degradation matrix).
 *
 * Rules carry `hmacSecret` — NEVER log a rule object.
 */
import type { RcHookAssign } from '@agentconnect.md/protocol'

export class HookTable {
  private byHookId = new Map<string, RcHookAssign>()
  private byToken = new Map<string, RcHookAssign>()
  /** repoId → hookId → rule (fan-out: several hooks may watch one repo). */
  private byRepoId = new Map<string, Map<string, RcHookAssign>>()
  /** GitLab projectId → hookId → rule (same fan-out shape as byRepoId). */
  private byProjectId = new Map<string, Map<string, RcHookAssign>>()

  upsert(rule: RcHookAssign): void {
    // Re-index: if the hook's token/repo changed (or the kind did), drop the old key.
    const prior = this.byHookId.get(rule.hookId)
    if (prior?.webhook && prior.webhook.urlToken !== rule.webhook?.urlToken) {
      this.byToken.delete(prior.webhook.urlToken)
    }
    if (prior?.github && prior.github.repoId !== rule.github?.repoId) {
      this.dropFromRepoIndex(prior)
    }
    if (prior?.gitlab && prior.gitlab.projectId !== rule.gitlab?.projectId) {
      this.dropFromProjectIndex(prior)
    }
    this.byHookId.set(rule.hookId, rule)
    if (rule.kind === 'webhook' && rule.webhook) this.byToken.set(rule.webhook.urlToken, rule)
    if (rule.kind === 'github' && rule.github) {
      let bucket = this.byRepoId.get(rule.github.repoId)
      if (!bucket) {
        bucket = new Map()
        this.byRepoId.set(rule.github.repoId, bucket)
      }
      bucket.set(rule.hookId, rule)
    }
    if (rule.kind === 'gitlab' && rule.gitlab) {
      let bucket = this.byProjectId.get(rule.gitlab.projectId)
      if (!bucket) {
        bucket = new Map()
        this.byProjectId.set(rule.gitlab.projectId, bucket)
      }
      bucket.set(rule.hookId, rule)
    }
  }

  remove(hookId: string): void {
    const rule = this.byHookId.get(hookId)
    if (!rule) return
    this.byHookId.delete(hookId)
    if (rule.webhook) this.byToken.delete(rule.webhook.urlToken)
    if (rule.github) this.dropFromRepoIndex(rule)
    if (rule.gitlab) this.dropFromProjectIndex(rule)
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

  /** The GitHub-ingress lookup: numeric repo id (as string) → every watching rule. */
  getByRepoId(repoId: string): RcHookAssign[] {
    const bucket = this.byRepoId.get(repoId)
    return bucket ? [...bucket.values()] : []
  }

  /** The GitLab-ingress lookup: numeric project id (as string) → every watching rule. */
  getByGitlabProject(projectId: string): RcHookAssign[] {
    const bucket = this.byProjectId.get(projectId)
    return bucket ? [...bucket.values()] : []
  }

  size(): number {
    return this.byHookId.size
  }

  private dropFromRepoIndex(rule: RcHookAssign): void {
    if (!rule.github) return
    const bucket = this.byRepoId.get(rule.github.repoId)
    if (!bucket) return
    bucket.delete(rule.hookId)
    if (bucket.size === 0) this.byRepoId.delete(rule.github.repoId)
  }

  private dropFromProjectIndex(rule: RcHookAssign): void {
    if (!rule.gitlab) return
    const bucket = this.byProjectId.get(rule.gitlab.projectId)
    if (!bucket) return
    bucket.delete(rule.hookId)
    if (bucket.size === 0) this.byProjectId.delete(rule.gitlab.projectId)
  }
}
