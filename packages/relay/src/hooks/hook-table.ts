/**
 * `HookTable` — the relay's in-memory hook routing table
 * (webhook-triggers-and-github-events.md, relay side). Driven entirely by the
 * CP's `rc/hook-assign` / `rc/hook-remove` EVTs: upsert-by-hookId semantics,
 * a `urlToken` index for the generic ingress lookup and one
 * `(provider, externalId)` index for every code-host endpoint (one repository →
 * many hooks). The table is a memory copy — the CP replays every enabled hook
 * after this relay (re)registers, and a CP outage leaves the copy serving
 * (degradation matrix).
 *
 * Rules carry `hmacSecret` — NEVER log a rule object.
 */
import { codeHostHookRuleOf, type CodeHostProvider, type RcHookAssign } from '@agentconnect.md/protocol'

/** The code-host routing key: the provider-qualified external repository id; a display path is never a match key. */
function repoIndexKey(provider: CodeHostProvider, externalId: string): string {
  return `${provider}:${externalId}`
}

/** The repository key a compiled rule routes under; undefined for the generic kind. */
function ruleRepoIndexKey(rule: RcHookAssign): string | undefined {
  const host = codeHostHookRuleOf(rule)
  return host && repoIndexKey(host.provider, host.repo.externalId)
}

export class HookTable {
  private byHookId = new Map<string, RcHookAssign>()
  private byToken = new Map<string, RcHookAssign>()
  /** (provider, externalId) → hookId → rule (fan-out: several hooks may watch one repository). */
  private byCodeHostRepo = new Map<string, Map<string, RcHookAssign>>()

  upsert(rule: RcHookAssign): void {
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

  size(): number {
    return this.byHookId.size
  }

  private dropFromRepoIndex(repoKey: string, hookId: string): void {
    const bucket = this.byCodeHostRepo.get(repoKey)
    if (!bucket) return
    bucket.delete(hookId)
    if (bucket.size === 0) this.byCodeHostRepo.delete(repoKey)
  }
}
