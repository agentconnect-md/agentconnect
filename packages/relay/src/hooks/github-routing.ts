// GitHub's member of the shared code-host routing step (code-host-decisions.md §4): its families, host fence and record-only fence.
import { HOOK_DECISION_ROUTING_V1_FEATURE, type RcHookAssign, type RcHookRouting } from '@agentconnect.md/protocol'
import type { GithubMatchCtx } from './github-ingress.js'
import { codeHostRecordOnlyEligible, type CodeHostRoutingProvider } from './code-host-routing.js'

/** Numbered-thread events a routing host records; `pull_request_review` is recorded only, never matched. */
export const GITHUB_ROUTED_THREAD_EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment'
])

export type GithubThreadFamily = 'issues' | 'pull_request'

/** The thread family a numbered-thread event belongs to; comments and reviews take their subject's. */
export function githubEventFamily(ctx: GithubMatchCtx): GithubThreadFamily | undefined {
  if (ctx.event === 'issues') return 'issues'
  if (
    ctx.event === 'pull_request' ||
    ctx.event === 'pull_request_review' ||
    ctx.event === 'pull_request_review_comment'
  )
    return 'pull_request'
  if (ctx.event === 'issue_comment') return ctx.commentSubjectFamily
  return undefined
}

/** The thread families a rule's events name; a shared `issue_comment` pattern is narrowed by `commentFamilies`. */
export function githubRuleFamilies(
  github: Pick<NonNullable<RcHookAssign['github']>, 'events' | 'commentFamilies'>
): Set<GithubThreadFamily> {
  const families = new Set<GithubThreadFamily>()
  for (const pattern of github.events) {
    const prefix = pattern.split(':', 1)[0]
    if (prefix === 'issues') families.add('issues')
    else if (prefix === 'pull_request' || prefix === 'pull_request_review_comment') families.add('pull_request')
    else if (prefix === 'issue_comment') {
      const scoped = github.commentFamilies && github.commentFamilies.length > 0 ? github.commentFamilies : undefined
      for (const family of scoped ?? (['issues', 'pull_request'] as const)) families.add(family)
    }
  }
  return families
}

/** The evaluation agent's own rule in a scope, fenced to this event's repository and installation. */
export function githubRoutingHostRule(
  scopeRules: readonly RcHookAssign[],
  routing: RcHookRouting,
  ctx: Pick<GithubMatchCtx, 'repoId' | 'installationId'>
): RcHookAssign | undefined {
  return scopeRules.find(
    (rule) =>
      rule.routing?.routingId === routing.routingId &&
      rule.agentId === routing.evaluationAgentId &&
      rule.kind === 'github' &&
      rule.github !== undefined &&
      ctx.repoId !== undefined &&
      rule.github.repoId === ctx.repoId &&
      ctx.installationId !== undefined &&
      rule.github.installationIds.includes(ctx.installationId)
  )
}

/** GitHub's record-only fence: a numbered, non-deleted thread event of the host rule's repository and installation. */
function githubRecordOnlyFence(hostRule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  if (hostRule.kind !== 'github' || !hostRule.github) return false
  if (!GITHUB_ROUTED_THREAD_EVENTS.has(ctx.event) || ctx.subjectNumber === undefined) return false
  if (ctx.eventAction === `${ctx.event}:deleted`) return false
  if (!ctx.installationId || !hostRule.github.installationIds.includes(ctx.installationId)) return false
  return ctx.repoId !== undefined && hostRule.github.repoId === ctx.repoId
}

const NO_FAMILIES: ReadonlySet<GithubThreadFamily> = new Set()

/** GitHub's callbacks for the shared routing step. */
export const GITHUB_ROUTING: CodeHostRoutingProvider<GithubMatchCtx> = {
  provider: 'github',
  hostFeatures: [HOOK_DECISION_ROUTING_V1_FEATURE],
  eventFamily: githubEventFamily,
  ruleFamilies: (rule) => (rule.kind === 'github' && rule.github ? githubRuleFamilies(rule.github) : NO_FAMILIES),
  hostRule: githubRoutingHostRule,
  recordOnlyEligible: githubRecordOnlyFence
}

/** Whether a scope with no candidate records this event on its host: a non-deleted thread event of its repository and family. */
export function githubRecordOnlyEligible(hostRule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  return codeHostRecordOnlyEligible(GITHUB_ROUTING, hostRule, ctx)
}
