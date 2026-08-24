/**
 * The daemon's hook-admission contract member (gitlab-com-integration.md §6.5,
 * webhook-triggers-and-github-events.md).
 *
 * One code host's deliveries contend for the next generation of one change-request
 * lane. Core asks this seam which delivery wins, which comment deliveries coalesce,
 * and how a sealed batch is published — never a provider module. Every member below
 * exists because BOTH providers implement it; the parts that genuinely diverge
 * (GitHub check-run rerun semantics, GitLab's headless note identity) stay inside
 * the implementing module.
 */
import type { CodeHostProvider } from '@agentconnect.md/protocol'
import type { GithubReviewBatch, GithubReviewBatchItem, HookDispatchContext } from '../github/hook-coords.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { QueueEntry } from '../daemon/turn-types.js'
import { githubHookAdmission } from '../github/hook-admission.js'
import { gitlabHookAdmission } from '../gitlab/hook-admission.js'

/** The three timing gates one open comment batch is sealed by; both providers share them. */
export const REVIEW_BATCH_QUIET_MS = 5_000
export const REVIEW_BATCH_MAX_WAIT_MS = 30_000
export const REVIEW_BATCH_MAX_COMMENTS = 25

/** The session dimensions a lane is scoped by; one lane never crosses them. */
export interface CodeHostHookCoordinates {
  agentId: string
  platform: string
  channel: string
  integrationId?: string
}

/** The trusted identity an admission decision may read — never model-visible text. */
export type CodeHostCoordinatedHook = Pick<HookDispatchContext, 'hookId' | 'agentId' | 'event' | 'github' | 'gitlab'>

/** One lane's contest for the next generation; a re-run is `pinned` to its exact provider revision. */
export interface CodeHostRevisionStream {
  lane: string
  revision: string
  pinned: boolean
}

export interface HookQueueCandidate {
  key: string
  entry: QueueEntry
  state: 'active' | 'queued' | 'incoming'
}

export interface RevisionAdmissionPlan {
  winner: HookQueueCandidate
  superseded: HookQueueCandidate[]
}

/** One code host's admission behavior behind the seam. */
export interface CodeHostHookAdmission {
  readonly provider: CodeHostProvider
  /** True when this delivery's trusted discriminator names THIS provider. */
  claims(hook: CodeHostCoordinatedHook | undefined): boolean
  /** Stable identity of the change-request lane this delivery belongs to, or undefined. */
  reviewSubjectLane(hook: CodeHostCoordinatedHook | undefined, coords: CodeHostHookCoordinates): string | undefined
  /** The generation stream this delivery contests, or undefined when it opens none. */
  revisionStream(
    hook: CodeHostCoordinatedHook | undefined,
    coords: CodeHostHookCoordinates
  ): CodeHostRevisionStream | undefined
  /** True when this delivery re-runs the exact revision already current, so an older generation is dead work. */
  rerunsCurrentRevision(hook: Pick<HookDispatchContext, 'event'> | undefined): boolean
  /** Identity of the comment stream this delivery coalesces into, or undefined when it batches with nothing. */
  reviewBatchStream(hook: CodeHostCoordinatedHook | undefined, coords: CodeHostHookCoordinates): string | undefined
  /** This delivery's own single-item batch, or undefined when it coalesces with nothing. */
  openReviewBatch(
    hook: HookDispatchContext,
    coords: CodeHostHookCoordinates,
    text: string,
    now: number
  ): GithubReviewBatch | undefined
  /** The item identity a redelivery is deduplicated on within one open batch. */
  batchItemKey(item: GithubReviewBatchItem): string
  /** The model-visible prompt for a sealed multi-item batch. */
  renderBatchPrompt(batch: GithubReviewBatch): string
  /** A sealed multi-item batch publishes each item through a provider tool, so the ordinary reply target is withdrawn. */
  readonly batchPublishesItems: boolean
}

/** Registration order is resolution order; adding a code host is adding one entry. */
const ADMISSIONS: readonly CodeHostHookAdmission[] = [githubHookAdmission, gitlabHookAdmission]

/** The module owning one delivery, resolved off the frame's discriminated provider member. */
export function hookAdmissionFor(hook: CodeHostCoordinatedHook | undefined): CodeHostHookAdmission | undefined {
  return ADMISSIONS.find((admission) => admission.claims(hook))
}

export function hookCoordinates(
  agentId: string,
  msg: Pick<NormalizedMessage, 'platform' | 'channel'>,
  integrationId?: string
): CodeHostHookCoordinates {
  return {
    agentId,
    platform: msg.platform,
    channel: msg.channel,
    ...(integrationId !== undefined ? { integrationId } : {})
  }
}

/** The lane a safety drain may keep admitting while it interrupts the generation it supersedes. */
export function reviewSubjectLane(
  hook: CodeHostCoordinatedHook | undefined,
  coords: CodeHostHookCoordinates
): string | undefined {
  return hookAdmissionFor(hook)?.reviewSubjectLane(hook, coords)
}

/** The single-item batch this delivery opens, so a later sibling has a leader to fold into. */
export function openReviewBatch(
  hook: HookDispatchContext,
  coords: CodeHostHookCoordinates,
  text: string,
  now: number
): GithubReviewBatch | undefined {
  return hookAdmissionFor(hook)?.openReviewBatch(hook, coords, text, now)
}

/** True when the sealed batch on this hook is published item by item rather than by the ordinary reply. */
export function batchPublishesItems(hook: CodeHostCoordinatedHook | undefined): boolean {
  return hookAdmissionFor(hook)?.batchPublishesItems === true
}

/** Contenders share a lane, and share an exact provider revision whenever either only re-runs its own. */
export function revisionStreamsContest(a: CodeHostRevisionStream, b: CodeHostRevisionStream): boolean {
  return a.lane === b.lane && (!(a.pinned || b.pinned) || a.revision === b.revision)
}

/** Recency of one delivery against another; the delivery key breaks an identical fire instant. */
export function compareHookDeliveryRecency(a: HookDispatchContext, b: HookDispatchContext): number {
  if (a.firedAt !== b.firedAt) return a.firedAt < b.firedAt ? -1 : 1
  if (a.deliveryKey === b.deliveryKey) return 0
  return a.deliveryKey < b.deliveryKey ? -1 : 1
}

/** The shared lane shape: one hook, one agent, one numbered subject, one session address. */
export function codeHostLane(
  hook: CodeHostCoordinatedHook,
  repoId: string,
  subjectNumber: number,
  coords: CodeHostHookCoordinates
): string {
  return JSON.stringify([
    hook.hookId,
    hook.agentId,
    repoId,
    subjectNumber,
    coords.platform,
    coords.channel,
    coords.integrationId ?? null
  ])
}
