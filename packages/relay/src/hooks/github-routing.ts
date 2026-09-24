// GitHub Decision routing (code-host-decisions.md §4): candidates, one host copy per scope, fan-out of the host's choice.
import {
  HOOK_DECISION_ROUTING_V1_FEATURE,
  type HookRouteSelection,
  type RcHookAssign,
  type RcHookRouting,
  type RdAck,
  type RdHookRouteCandidate,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import type { RelayDaemonServer } from '../relay-daemon-server.js'
import type { Logger } from '../log.js'
import type { GithubMatchCtx } from './github-ingress.js'

/** Numbered-thread events a routing host records; `pull_request_review` is recorded only, never matched. */
export const GITHUB_ROUTED_THREAD_EVENTS = new Set([
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment'
])

/** Longer than the host's 5 s Decision deadline, single-shot so the fallback is not delayed by retransmits. */
export const HOOK_ROUTING_ACK_TIMEOUT_MS = 15_000
const ROUTING_REQUEST = { ackTimeoutMs: HOOK_ROUTING_ACK_TIMEOUT_MS, maxTries: 1 }

export type GithubThreadFamily = 'issues' | 'pull_request'

/** One routed rule that would fire; the host's Decision chooses among them. */
export interface GithubRouteCandidate {
  rule: RcHookAssign
}

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
export function githubRuleFamilies(github: NonNullable<RcHookAssign['github']>): Set<GithubThreadFamily> {
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

/** Whether a scope with no candidate records this event on its host: a non-deleted thread event of its repository and family. */
export function githubRecordOnlyEligible(hostRule: RcHookAssign, ctx: GithubMatchCtx): boolean {
  if (hostRule.kind !== 'github' || !hostRule.github || hostRule.routing === undefined) return false
  if (!GITHUB_ROUTED_THREAD_EVENTS.has(ctx.event) || ctx.subjectNumber === undefined) return false
  if (ctx.eventAction === `${ctx.event}:deleted`) return false
  if (!ctx.installationId || !hostRule.github.installationIds.includes(ctx.installationId)) return false
  if (ctx.repoId === undefined || hostRule.github.repoId !== ctx.repoId) return false
  const family = githubEventFamily(ctx)
  return family !== undefined && githubRuleFamilies(hostRule.github).has(family)
}

/** The wire candidates, one per hook, in fire order. */
export function githubRouteCandidates(candidates: readonly GithubRouteCandidate[]): RdHookRouteCandidate[] {
  return candidates.map(({ rule }) => ({ hookId: rule.hookId, agentId: rule.agentId }))
}

/** The provider-failure fallback's evidence: every candidate fires as without a Decision. */
export function hostUnavailableSelection(routing: RcHookRouting): HookRouteSelection {
  return {
    routingId: routing.routingId,
    decisionId: routing.decisionId,
    reason: 'unavailable',
    unavailableReason: 'host_unavailable'
  }
}

/** The host copy of a routed event: the host rule's own delivery under a distinct msgId, carrying the candidates. */
export function githubHostCopy(
  hostMsg: RdMsgHook,
  routing: RcHookRouting,
  candidates: readonly GithubRouteCandidate[]
): RdMsgHook {
  return {
    ...hostMsg,
    msgId: `${hostMsg.msgId}:route`,
    routing: {
      routingId: routing.routingId,
      decisionId: routing.decisionId,
      candidates: githubRouteCandidates(candidates)
    }
  }
}

export type GithubHostVerdict =
  | { kind: 'targets'; targets: NonNullable<RdAck['hookRoute']>['targets'] }
  | { kind: 'held'; reason: string }
  | { kind: 'unavailable'; reason: string }

type Daemons = () => Pick<RelayDaemonServer, 'get'> | undefined

/** Ask the scope's host for its choice; any failure to get an answer is `unavailable`. */
export async function askGithubRoutingHost(
  daemons: Daemons,
  routing: RcHookRouting,
  copy: RdMsgHook
): Promise<GithubHostVerdict> {
  const conn = daemons()?.get(routing.evaluationDaemonId)
  if (!conn) return { kind: 'unavailable', reason: 'offline' }
  if (!conn.supports(HOOK_DECISION_ROUTING_V1_FEATURE)) return { kind: 'unavailable', reason: 'unsupported' }
  let ack: RdAck
  try {
    ack = await conn.sendMsg(copy, ROUTING_REQUEST)
  } catch (err) {
    return { kind: 'unavailable', reason: `timeout: ${String(err)}` }
  }
  if (!ack.accepted) return { kind: 'held', reason: ack.reason ?? 'rejected' }
  if (!ack.hookRoute) return { kind: 'held', reason: 'no_route' }
  return { kind: 'targets', targets: ack.hookRoute.targets }
}

/** Fire-and-forget a record-only copy; a host that cannot take it loses one history row, nothing more. */
export function sendGithubRecordOnlyCopy(daemons: Daemons, routing: RcHookRouting, copy: RdMsgHook, log: Logger): void {
  const conn = daemons()?.get(routing.evaluationDaemonId)
  if (!conn || !conn.supports(HOOK_DECISION_ROUTING_V1_FEATURE)) {
    log.info(`github ingress: record-only copy dropped, host unavailable ${copy.msgId}`)
    return
  }
  void conn.sendMsg(copy, ROUTING_REQUEST).catch(() => {})
  log.info(`github ingress: queued record-only copy ${copy.msgId} (${copy.event ?? 'unknown'})`)
}
