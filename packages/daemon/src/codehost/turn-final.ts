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
import type { GithubCommentAttributionSource } from '../github/poster.js'
import type { GitlabPublishFailure } from '../gitlab/poster.js'
import type { HookPromptSupplement } from '../messages/hook-message.js'
import { replyTargetProvider, type CodeHostReplyTarget } from './reply-target.js'

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

export type CodeHostThreadWorktreeCleanup = 'pull_request_merged' | 'issue_closed' | 'issue_deleted'

/** What the daemon lends these members; each provider declares only the part it reads. */
export type CodeHostTurnFinalHost = GithubTurnFinalHost & GitlabTurnFinalHost & GiteaTurnFinalHost

/** One code host's turn-final members. */
export interface CodeHostTurnFinal<P extends CodeHostProvider = CodeHostProvider> {
  readonly provider: P
  /** This delivery's one reply target, or undefined when it owns no public reply (a push, a subject it cannot address). */
  replyTarget(msg: RdMsgHook): CodeHostReplyTarget | undefined
  /** The named refusal a turn-start instance disagreement takes, or undefined when this provider pins no instance. */
  hostFence(msg: RdMsgHook, host: CodeHostTurnFinalHost): string | undefined
  /** The lifecycle pairing that retires the per-thread checkout, read off the normalized event and trusted metadata. */
  worktreeCleanup(delivery: CodeHostDelivery): CodeHostThreadWorktreeCleanup | undefined
  /** The lease this target's public output publishes under, resolved per turn. */
  effectLease(agentId: string, target: CodeHostReplyTarget, host: CodeHostTurnFinalHost): CodeHostEffectLease
  /** The turn's one poster, tokened through that lease. */
  finalPoster(target: CodeHostReplyTarget, deps: CodeHostFinalPosterDeps): CodeHostFinalPoster
  /** Host content this delivery's prompt needs fetched first (gitea-integration.md §8); absent for a host whose deliveries are complete on the wire. */
  promptSupplement?(msg: RdMsgHook, deps: CodeHostPromptSupplementDeps): Promise<HookPromptSupplement | undefined>
  /** True when this provider's poster names WHY its one comment is absent (§14.1); GitHub's reports none. */
  readonly reportsAbsentOutput: boolean
}

/** Adding a code host is adding one entry; the record over the provider union makes a missing one a compile error. */
const TURN_FINALS: { readonly [P in CodeHostProvider]: CodeHostTurnFinal<P> } = {
  github: githubTurnFinal,
  gitlab: gitlabTurnFinal,
  gitea: giteaTurnFinal
}

/** Every registered member, in provider order — the order a member that claims its own delivery resolves in. */
const TURN_FINAL_MEMBERS: readonly CodeHostTurnFinal[] = Object.values(TURN_FINALS)

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
