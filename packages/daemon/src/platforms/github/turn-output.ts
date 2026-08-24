/**
 * GitHub's **turn-output surface** (integration-plugin-architecture.md §7.3 and
 * §7.6, stage S2).
 *
 * §7.6 lists GitHub as `Layer 1: no, Layer 2: yes` — it has no connection, no
 * ingress, no read port (its ingress arrives through the core hook seam and
 * stays there permanently, per §12), but it does produce output for a turn. What
 * this extraction discovered is that its output has a DIFFERENT SHAPE from the
 * four chat platforms, and the difference is worth naming rather than papering
 * over.
 *
 * TWO MODES OF LAYER 2. `TurnOutputSurface` — converger + `apply` + state — was
 * derived from four STREAMING platforms: text arrives in chunks, each chunk
 * becomes an action, each action becomes an API call. GitHub does none of that.
 * It publishes exactly ONE comment, at the very end, containing one logical
 * final answer. It has:
 *
 *   - no converger — it consumes raw ACP updates directly, because its
 *     production rule is "select the final answer", not "chunk the stream";
 *   - no `apply` — there are no per-action calls to make. The core streaming
 *     path is deliberately BYPASSED for a GitHub turn (`isHeadlessGithubFinal`),
 *     precisely so no intermediate output escapes;
 *   - a real per-turn state — the poster, the collector, and whether the final
 *     was withheld from the transcript.
 *
 * Forcing that into `apply` would mean inventing actions nobody emits. So Layer
 * 2 gets a second published shape, `TurnFinalSurface`, and GitHub is its first
 * implementer. A platform implements whichever matches how it actually emits;
 * the four chat platforms are unaffected.
 *
 * WHY THE DURABILITY BARRIER STAYS IN CORE. Publishing is wrapped in a hook
 * state machine — `in_flight` recorded before any public POST, `settled` after —
 * and a replayed `in_flight` is what stops a retry from double-commenting. That
 * is the HOOK's durability contract, not GitHub's rendering, and §12 keeps hook
 * machinery in core. So the surface does not reach for it: core offers
 * `beginPublish()` / `endPublish()`, and a `false` from `beginPublish` means the
 * barrier could not be made durable and the surface must not POST. Fail-closed
 * stays fail-closed, and it stays readable as one rule in one place.
 *
 * Likewise the formal-review fork (a submitted PR review already answered the
 * human, so the ordinary final must be suppressed) is decided by core from hook
 * state and passed in as one boolean — the surface never inspects hook context.
 */
import type { GithubPublishedComment, PublishedHookOutput } from '@agentconnect.md/protocol'
import type { GithubReplyCollector } from '../../github/poster.js'
import type { GitlabPublishFailure } from '../../gitlab/poster.js'

/** GitHub's per-turn state (§7.3). Held in the turn's final-surface slot, which
 *  core stores opaquely and never reads. */
export interface GithubTurnState {
  /** Publishes the one comment — structurally the GitHub poster or its GitLab twin (§14.1), tokened and attributed at publish time. */
  poster: {
    publish(finalBody?: string): Promise<GithubPublishedComment | PublishedHookOutput | undefined>
    /** Normalized reason the one note is absent (GitLab §14.1); GitHub's poster reports none. */
    readonly failure?: GitlabPublishFailure
  }
  /** Accumulates ACP updates and selects the single logical final answer. */
  collector: GithubReplyCollector
  /** Set when the runtime's explicit final chunk was withheld from the core
   *  converger, so the transcript row must be written from the collector's text
   *  at turn end instead of per idle/size flush. */
  deferredFinalTranscript: boolean
}

/** The core turn, as GitHub's surface sees it. `Pending` satisfies it
 *  structurally — a far smaller footprint than the chat surfaces need, because
 *  GitHub owns no anchors on the turn record. */
export interface GithubTurn {
  plan: {
    statusThread: string
    transcriptChannel: string
    agentId: string
    platform: string
  }
}

/** The host capabilities this surface needs.
 *
 *  Deliberately excludes anything hook-shaped: the surface is told WHETHER it
 *  may publish, never how the decision was reached. */
export interface GithubTurnHost {
  appendTranscript(row: {
    channel: string
    thread: string
    ts: string
    sender: string
    kind: 'text'
    text: string
  }): void | Promise<void | string>
  /** Monotonic transcript timestamp — core owns ordering across surfaces. */
  monotonicTs(): string
  /** Record the durable `in_flight` barrier. `false` means the write could not
   *  be made durable, and the caller must NOT perform the public POST. `hasFinal`
   *  says whether a body was actually owed, so core can tell a lost publication
   *  from a barrier failure on a turn that had nothing to say. */
  beginPublish(hasFinal: boolean): boolean | Promise<boolean>
  /** Record the durable `settled` state and any exact public comment identity. */
  endPublish(publishedComment?: GithubPublishedComment | PublishedHookOutput): void | Promise<void>
  warn(message: string): void
}

/** Does this ACP update carry the runtime's explicit final answer for a headless
 *  GitHub turn? Such a chunk is withheld from the core converger — nothing may
 *  reach a platform before `publish()` makes the single public POST — so its
 *  transcript row is owed at turn end instead. */
export function isGithubFinalChunk(
  turn: { plan: Pick<GithubTurn['plan'], 'platform'> },
  update: { sessionUpdate?: unknown; _meta?: { codex?: { phase?: unknown } } } | undefined
): boolean {
  return (
    turn.plan.platform === 'hook' &&
    update?.sessionUpdate === 'agent_message_chunk' &&
    update?._meta?.codex?.phase === 'final_answer'
  )
}

/** Feed one ACP update to the turn's collector. GitHub's analog of a converger
 *  step: no action is produced, because nothing is published until the turn ends. */
export function onGithubUpdate(state: GithubTurnState, update: unknown, isFinalChunk: boolean): void {
  state.collector.onUpdate(update)
  if (isFinalChunk) state.deferredFinalTranscript = true
}

/** Publish the turn's one GitHub comment, and settle the transcript row the
 *  deferred final still owes.
 *
 *  @param suppressed  Core's output-suppression verdict for the turn.
 *  @param formalReviewOwnsResponse  A submitted PR review already answered the
 *    human, so the ordinary final must not be posted. Core derives this from
 *    hook state; the surface only obeys it.
 */
export async function finalizeGithubTurn<TTurn extends GithubTurn>(
  host: GithubTurnHost,
  turn: TTurn,
  state: GithubTurnState,
  opts: { suppressed: boolean; atEnd: boolean; formalReviewOwnsResponse: boolean }
): Promise<void> {
  // A headless GitHub hook has no platform-send boundary. Explicit final chunks
  // were withheld from the core converger, so persist the collector's one
  // logical final now instead of one row per idle/size flush.
  const final = !opts.suppressed && opts.atEnd ? state.collector.finalText(true) : undefined
  if (state.deferredFinalTranscript && final?.trim()) {
    await host.appendTranscript({
      channel: turn.plan.transcriptChannel,
      thread: turn.plan.statusThread,
      ts: host.monotonicTs(),
      sender: turn.plan.agentId,
      kind: 'text',
      text: final
    })
  }
  if (opts.suppressed || opts.formalReviewOwnsResponse) return
  // With no formal effect (or a proved not_submitted effect), the ordinary final
  // remains the fallback. A replay of `in_flight` suppresses another comment; if
  // that write cannot be made durable, fail closed and skip the POST entirely.
  if (!(await host.beginPublish(!!final?.trim()))) return
  // publish() is time-bounded and degrading — a failure here must not strand the
  // turn, so it is logged and the hook still settles.
  const publishedComment = await state.poster.publish(final).catch((err) => {
    host.warn(`github poster: final publish failed (${err instanceof Error ? err.message : String(err)})`)
    return undefined
  })
  await host.endPublish(publishedComment)
}
