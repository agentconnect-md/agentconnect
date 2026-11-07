/**
 * The daemon's TURN-FINAL contract member for code hosts (gitlab-com-integration.md §6.5,
 * §14.1; integration-plugin-architecture.md §7.6, stage S2).
 *
 * A code-host turn publishes ONE comment at the very end, which is why its Layer-2 shape is
 * the published turn-FINAL surface and not a streaming one. What a provider must supply to
 * that surface is registered here: where the delivery's one reply goes, the effect lease and
 * REST root it publishes under, the poster itself, the instance a turn is fenced to at start,
 * and the lifecycle pairing that retires a thread's checkout without opening a turn. Core
 * selects through the registry and compares no provider name, so adding a code host is adding
 * one entry — never a branch on the dispatch path.
 *
 * Every member exists because BOTH providers implement it. GitHub-only product surfaces stay
 * out on purpose (the workflow-approval start path, the session pull-request panel): one
 * implementer is an interface guessed at, not a contract.
 */
import {
  isCodeHostHookKind,
  type CodeHostHookMembers,
  type CodeHostProvider,
  type GithubPublishedComment,
  type PublishedHookOutput,
  type RdMsgHook
} from '@agentconnect.md/protocol'
import { githubTurnFinal, type GithubTurnFinalHost } from '../github/turn-final.js'
import { gitlabTurnFinal, type GitlabTurnFinalHost } from '../gitlab/turn-final.js'
import { giteaTurnFinal, type GiteaTurnFinalHost } from '../gitea/turn-final.js'
import { azureDevOpsTurnFinal, type AzureDevOpsTurnFinalHost } from '../azure-devops/turn-final.js'
import type { GithubCommentAttributionSource } from '../github/poster.js'
import type { GitlabPublishFailure } from '../gitlab/poster.js'
import type { HookPromptSupplement } from '../messages/hook-message.js'
import { replyTargetProvider, type CodeHostReplyTarget } from './reply-target.js'
import type { PullRequestContext } from './pull-context.js'

/** The one end-of-turn poster both providers implement — the published surface's `poster` slot. */
export interface CodeHostFinalPoster {
  publish(finalBody?: string): Promise<GithubPublishedComment | PublishedHookOutput | undefined>
  /** Normalized reason the one comment is absent (§14.1); a provider that names none omits it. */
  readonly failure?: GitlabPublishFailure
}

/** The action-time effect lease and REST root one delivery's public output is published under (§14.1). */
export interface CodeHostEffectLease {
  token: () => Promise<string>
  /** Drop a cached token the host just rejected (401/403) so the one retry re-mints. */
  invalidateToken: (presentedToken: string) => void
  apiBaseUrl: () => string
}

/** What a provider's poster is built from: its lease, plus the footer facts resolved at publish time. */
export interface CodeHostFinalPosterDeps extends CodeHostEffectLease {
  attribution?: GithubCommentAttributionSource
  log: { warn: (message: string) => void }
}

/** What a provider reads to fetch prompt content before a turn: the turn's own lease and a warn sink. */
export interface CodeHostPromptSupplementDeps {
  token: () => Promise<string>
  apiBaseUrl: () => string
  log: { warn: (message: string) => void }
  fetchImpl?: typeof fetch
}

/** A delivery's trusted members plus the normalized event — the pair a lifecycle cleanup is fenced on. */
export type CodeHostDelivery = CodeHostHookMembers & { event?: string }

/** Trusted coordinates available both at ingress and when replaying a retained hook. */
export type CodeHostReplySource = CodeHostHookMembers & Pick<RdMsgHook, 'hookId' | 'context'>

export type CodeHostThreadWorktreeCleanup =
  'pull_request_merged' | 'pull_request_closed' | 'issue_closed' | 'issue_deleted'

/** A delivery a host classified on a turn-start read: as classified, with what the read found for the prompt, or refused. */
export type CodeHostResolvedDelivery = { msg: RdMsgHook; supplement?: HookPromptSupplement } | { refused: string }

/** What the daemon lends these members; each provider declares only the part it reads. */
export type CodeHostTurnFinalHost = GithubTurnFinalHost &
  GitlabTurnFinalHost &
  GiteaTurnFinalHost &
  AzureDevOpsTurnFinalHost

/** One code host's turn-final members. */
export interface CodeHostTurnFinal<P extends CodeHostProvider = CodeHostProvider> {
  readonly provider: P
  /** This delivery's one reply target, or undefined when it owns no public reply (a push, a subject it cannot address). */
  replyTarget(msg: CodeHostReplySource): CodeHostReplyTarget | undefined
  /** The named refusal a turn-start instance disagreement takes, or undefined when this provider pins no instance. */
  hostFence(msg: RdMsgHook, host: CodeHostTurnFinalHost): string | undefined
  /** The lifecycle pairing that retires the per-thread checkout, read off the normalized event and trusted metadata. */
  worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined
  /** Why a classified delivery is acknowledged without a turn; absent for a host that classifies nothing. */
  ignoredReason?(delivery: CodeHostDelivery): string | undefined
  /** The delivery as a turn-start read classifies it (azure-devops-integration.md §11.4); absent or undefined ⇒ complete on the wire. */
  resolveDelivery?(msg: RdMsgHook, host: CodeHostTurnFinalHost): Promise<CodeHostResolvedDelivery | undefined>
  /** The lease this target's public output publishes under, resolved per turn. */
  effectLease(agentId: string, target: CodeHostReplyTarget, host: CodeHostTurnFinalHost): CodeHostEffectLease
  /** The turn's one poster, tokened through that lease. */
  finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster
  /** Host content this delivery's prompt needs fetched first (gitea-integration.md §8); absent for a host whose deliveries are complete on the wire. */
  promptSupplement?(msg: RdMsgHook, deps: CodeHostPromptSupplementDeps): Promise<HookPromptSupplement | undefined>
  pullRequestContext(
    source: CodeHostReplySource,
    agentId: string,
    host: CodeHostTurnFinalHost,
    signal: AbortSignal
  ): Promise<PullRequestContext | undefined>
  /** True when this provider's poster names WHY its one comment is absent (§14.1); GitHub's reports none. */
  readonly reportsAbsentOutput: boolean
}

/** Adding a code host is adding one entry; the record over the provider union makes a missing one a compile error. */
const TURN_FINALS: { readonly [P in CodeHostProvider]: CodeHostTurnFinal<P> } = {
  github: githubTurnFinal,
  gitlab: gitlabTurnFinal,
  gitea: giteaTurnFinal,
  'azure-devops': azureDevOpsTurnFinal
}

/** Every registered member, in provider order — the order a member that claims its own delivery resolves in. */
const TURN_FINAL_MEMBERS: readonly CodeHostTurnFinal[] = Object.values(TURN_FINALS)

export async function codeHostPullRequestContext(
  source: CodeHostReplySource,
  agentId: string,
  host: CodeHostTurnFinalHost,
  signal: AbortSignal
): Promise<PullRequestContext | undefined> {
  for (const member of TURN_FINAL_MEMBERS) {
    const context = await member.pullRequestContext(source, agentId, host, signal)
    if (context !== undefined) return context
  }
  return undefined
}

/** The module owning one reply target, and therefore this turn's poster, lease and acknowledgement. */
export function turnFinalFor(target: Pick<CodeHostReplyTarget, 'provider'>): CodeHostTurnFinal {
  return TURN_FINALS[replyTargetProvider(target)]
}

/** The one reply target a delivery opens, built by the module its TRUSTED source names — never inferred from model-visible text. */
export function codeHostReplyTarget(msg: RdMsgHook): CodeHostReplyTarget | undefined {
  const source = msg.context?.source
  if (source === undefined || !isCodeHostHookKind(source)) return undefined
  return TURN_FINALS[source].replyTarget(msg)
}

/** What a delivery's prompt needs from its host, fetched under the turn's own lease; a failure leaves the prompt as delivered. */
export async function codeHostPromptSupplement(
  msg: RdMsgHook,
  host: CodeHostTurnFinalHost
): Promise<HookPromptSupplement | undefined> {
  const target = codeHostReplyTarget(msg)
  if (!target) return undefined
  const turnFinal = turnFinalFor(target)
  if (!turnFinal.promptSupplement) return undefined
  const lease = turnFinal.effectLease(msg.agentId, target, host)
  try {
    return await turnFinal.promptSupplement(msg, { token: lease.token, apiBaseUrl: lease.apiBaseUrl, log: host.log })
  } catch (err) {
    host.log.warn(
      `hook: prompt supplement for ${msg.msgId} failed (${err instanceof Error ? err.message : String(err)})`
    )
    return undefined
  }
}

/** The turn-start refusal this delivery takes when it names an instance the session's spec is not bound to (§24.4). */
export function codeHostHostFence(msg: RdMsgHook, host: CodeHostTurnFinalHost): string | undefined {
  for (const member of TURN_FINAL_MEMBERS) {
    const refusal = member.hostFence(msg, host)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/** The delivery as its host classifies it before admission; a host that reads nothing hands it back as it came. */
export async function codeHostResolveDelivery(
  msg: RdMsgHook,
  host: CodeHostTurnFinalHost
): Promise<CodeHostResolvedDelivery> {
  for (const member of TURN_FINAL_MEMBERS) {
    if (!member.resolveDelivery) continue
    try {
      const resolved = await member.resolveDelivery(msg, host)
      if (resolved !== undefined) return resolved
    } catch (err) {
      host.log.warn(`hook: resolving ${msg.msgId} failed (${err instanceof Error ? err.message : String(err)})`)
      return { refused: 'delivery_unresolved' }
    }
  }
  return { msg }
}

/** Why a classified delivery is acknowledged and completed without a model turn, or undefined. */
export function codeHostIgnoredDelivery(delivery: CodeHostDelivery | undefined): string | undefined {
  if (!delivery) return undefined
  for (const member of TURN_FINAL_MEMBERS) {
    const reason = member.ignoredReason?.(delivery)
    if (reason !== undefined) return reason
  }
  return undefined
}

/** Relay-authored lifecycle events that remove the isolated checkout without opening a model turn. */
export function codeHostThreadWorktreeCleanup(
  delivery: CodeHostDelivery | undefined
): CodeHostThreadWorktreeCleanup | undefined {
  if (!delivery) return undefined
  for (const member of TURN_FINAL_MEMBERS) {
    const cleanup = member.worktreeCleanup(delivery)
    if (cleanup !== undefined) return cleanup
  }
  return undefined
}
